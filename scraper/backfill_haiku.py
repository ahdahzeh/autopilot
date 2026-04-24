"""Backfill existing Supabase jobs with Haiku-based semantic scores.

Standalone CLI. Pulls onboarded user profiles (resume_text, target_titles,
priority_industries, priority_keywords) and all their jobs, then re-scores each
job in batches of 20 via haiku_scorer.rescore_with_haiku. Writes the new
match_score (0-10, rounded from Haiku's 0-100), reasoning, matched_skills,
concerns, and priority back to the jobs row.

Usage:
    # All onboarded users
    python backfill_haiku.py

    # Single user
    python backfill_haiku.py --user-id <uuid>

Env:
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    ANTHROPIC_API_KEY
"""

import argparse
import asyncio
import os
import sys
from typing import Any

from dotenv import load_dotenv
from loguru import logger

from models import JobListing
from haiku_scorer import rescore_with_haiku


load_dotenv()

BATCH_SIZE = 20

# Rough cost model for reporting only — claude-haiku-4-5 is $1/MTok input,
# $5/MTok output. Most of our per-job calls are ~1.5k input + ~120 output.
AVG_INPUT_TOKENS = 1500
AVG_OUTPUT_TOKENS = 120
INPUT_COST_PER_TOKEN = 1.0 / 1_000_000
OUTPUT_COST_PER_TOKEN = 5.0 / 1_000_000


def _get_supabase():
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
        sys.exit(1)
    # Import here so syntax-check works without supabase installed.
    from supabase import create_client

    return create_client(url, key)


def _priority_from_score(score: int) -> str:
    if score >= 80:
        return "High"
    if score >= 50:
        return "Medium"
    return "Low"


def _load_profiles(supabase, user_id: str | None) -> list[dict[str, Any]]:
    """Pull profiles scoped to one user or all users with a resume.

    The profiles table keys on `id` (matches auth.users.id), so we alias it to
    `user_id` for the rest of the script's convenience.
    """
    query = supabase.table("profiles").select(
        "id, resume_text, target_titles, priority_industries, priority_keywords, onboarded"
    )
    if user_id:
        query = query.eq("id", user_id)
    else:
        query = query.eq("onboarded", True)
    result = query.execute()
    profiles = [{**p, "user_id": p["id"]} for p in (result.data or [])]

    # Keep only profiles with at least *some* resume text — otherwise Haiku has
    # nothing to compare against and scores collapse.
    usable = [p for p in profiles if (p.get("resume_text") or "").strip()]
    skipped = len(profiles) - len(usable)
    if skipped:
        logger.info(f"Skipping {skipped} profile(s) with no resume_text")
    return usable


def _load_jobs_for_user(
    supabase, user_id: str, only_missing: bool = False
) -> list[dict[str, Any]]:
    """Pull every job row for one user. Sorted by existing match_score desc so
    top heuristic jobs get rescored first — useful if the caller kills the run
    mid-way. If only_missing=True, skip rows that already have a Haiku reasoning
    so we can cheaply finish a partial backfill after rate-limit failures.
    """
    query = (
        supabase.table("jobs")
        .select("id, role, company, description, source, location, match_score, score_reasoning")
        .eq("user_id", user_id)
        .order("match_score", desc=True)
    )
    if only_missing:
        query = query.or_("score_reasoning.is.null,score_reasoning.eq.")
    result = query.execute()
    return result.data or []


def _row_to_job_listing(row: dict[str, Any]) -> JobListing:
    """Adapt a Supabase jobs row to a JobListing so haiku_scorer can consume it.

    The DB uses `role` for title and `id` is a uuid string; we pass it through
    as JobListing.id so the Haiku result can be merged back by id.
    """
    return JobListing(
        id=str(row.get("id", "")),
        source=row.get("source", "") or "unknown",
        title=row.get("role", "") or "",
        company=row.get("company", "") or "",
        location=row.get("location", "") or "",
        description=row.get("description", "") or "",
    )


async def _process_user(
    supabase,
    profile: dict[str, Any],
    only_missing: bool = False,
) -> tuple[int, int, float]:
    """Rescore one user's jobs. Returns (jobs_scored, jobs_total, score_sum)."""
    user_id = profile["user_id"]
    resume_text = profile.get("resume_text", "") or ""
    target_titles = profile.get("target_titles", []) or []
    priority_industries = profile.get("priority_industries", []) or []
    priority_keywords = profile.get("priority_keywords", []) or []

    rows = _load_jobs_for_user(supabase, user_id, only_missing=only_missing)
    if not rows:
        logger.info(f"user={user_id}: no jobs to rescore")
        return (0, 0, 0.0)

    logger.info(
        f"user={user_id}: {len(rows)} jobs to rescore "
        f"(titles={target_titles}, industries={priority_industries})"
    )

    scored = 0
    score_sum = 0

    for start in range(0, len(rows), BATCH_SIZE):
        batch_rows = rows[start : start + BATCH_SIZE]
        batch_jobs = [_row_to_job_listing(r) for r in batch_rows]

        results = await rescore_with_haiku(
            jobs=batch_jobs,
            resume_text=resume_text,
            target_titles=target_titles,
            priority_industries=priority_industries,
            priority_keywords=priority_keywords,
        )

        if not results:
            logger.warning(
                f"user={user_id}: batch {start}-{start + len(batch_rows)} returned no results"
            )
            continue

        for res in results:
            job_id = res["id"]
            raw_score = res["score"]  # 0-100
            match_score_10 = round(raw_score / 10)  # back to 0-10 for existing UI
            priority = _priority_from_score(raw_score)

            try:
                supabase.table("jobs").update(
                    {
                        "match_score": match_score_10,
                        "score_reasoning": res["reasoning"],
                        "matched_skills": res["matched_skills"],
                        "concerns": res["concerns"],
                        "priority": priority,
                    }
                ).eq("id", job_id).execute()
                scored += 1
                score_sum += raw_score
            except Exception as e:
                logger.error(f"user={user_id}: failed to PATCH job {job_id}: {e}")

        logger.info(
            f"user={user_id}: batch {start}-{start + len(batch_rows)} "
            f"→ {len(results)} scored, {len(batch_rows) - len(results)} failed"
        )

    return (scored, len(rows), float(score_sum))


async def run(user_id: str | None, only_missing: bool = False) -> None:
    supabase = _get_supabase()

    if not os.getenv("ANTHROPIC_API_KEY"):
        logger.error("ANTHROPIC_API_KEY must be set")
        sys.exit(1)

    profiles = _load_profiles(supabase, user_id)
    if not profiles:
        logger.warning("No profiles to process — exiting")
        return

    logger.info(f"Backfill: {len(profiles)} profile(s) to process")

    total_users = 0
    total_scored = 0
    total_jobs = 0
    total_score_sum = 0.0

    # Sequential across users so one slow profile's concurrency doesn't fight
    # another's for Haiku rate limits. Within each user, rescore_with_haiku
    # parallelises the 20-wide batch internally.
    for profile in profiles:
        scored, job_count, score_sum = await _process_user(
            supabase, profile, only_missing=only_missing
        )
        total_users += 1
        total_scored += scored
        total_jobs += job_count
        total_score_sum += score_sum

    avg_score = (total_score_sum / total_scored) if total_scored else 0.0
    est_cost = total_scored * (
        AVG_INPUT_TOKENS * INPUT_COST_PER_TOKEN
        + AVG_OUTPUT_TOKENS * OUTPUT_COST_PER_TOKEN
    )

    print("")
    print("=" * 60)
    print("BACKFILL SUMMARY")
    print("=" * 60)
    print(f"Users processed:       {total_users}")
    print(f"Jobs considered:       {total_jobs}")
    print(f"Jobs rescored:         {total_scored}")
    print(f"Jobs failed/skipped:   {total_jobs - total_scored}")
    print(f"Average Haiku score:   {avg_score:.1f} / 100")
    print(f"Estimated API cost:    ${est_cost:.4f} (at ~{AVG_INPUT_TOKENS}in/{AVG_OUTPUT_TOKENS}out per job)")
    print("=" * 60)


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill Haiku scores for existing jobs.")
    parser.add_argument(
        "--user-id",
        type=str,
        default=None,
        help="Scope to a single user uuid. Omit to run across all onboarded users.",
    )
    parser.add_argument(
        "--only-missing",
        action="store_true",
        help="Only rescore rows that have no score_reasoning yet (cheap top-off after rate-limit failures).",
    )
    args = parser.parse_args()

    asyncio.run(run(args.user_id, only_missing=args.only_missing))


if __name__ == "__main__":
    main()
