"""Autopilot Scraper Service — FastAPI app for Railway."""

import asyncio
import hashlib
import os
import sys
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from loguru import logger
from supabase import create_client

from models import ScrapeRequest
from scrapers import linkedin, builtin, hiringcafe, greenhouse, lever, ashby, workday
from scrapers.dedup import deduplicate, normalize_company, normalize_title
from scorer import score_job, is_title_relevant
from haiku_scorer import rescore_with_haiku
from source_stats import write_source_stats

load_dotenv()

# Loguru's default sink emits DEBUG and up, and uvicorn's --log-level only
# governs uvicorn's own logger, so anything demoted to DEBUG below would still
# land in the public GitHub Actions log. Pin the level here; LOG_LEVEL=DEBUG
# locally when the search terms are needed to debug a run.
logger.remove()
logger.add(sys.stderr, level=os.getenv("LOG_LEVEL", "INFO").upper())

app = FastAPI(title="Autopilot Scraper", version="1.0.0")

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

SCRAPER_MAP = {
    "linkedin": linkedin.scrape,
    "builtin": builtin.scrape,
    "hiringcafe": hiringcafe.scrape,
    "greenhouse": greenhouse.scrape,
    "lever": lever.scrape,
    "ashby": ashby.scrape,
    "workday": workday.scrape,
}

# ATS scrapers iterate user-specified companies rather than running keyword
# searches, so passing an empty companies list is a no-op for them.
ATS_SOURCES = {"greenhouse", "lever", "ashby", "workday"}

# Scrapers that spin up a headless Chromium. Each Playwright session eats
# ~400MB on Railway's plan; running three in parallel OOM-killed the service
# on the Vercel side before we knew this. The semaphore below caps concurrent
# browser launches while letting HTTP-only (ATS) scrapers run freely.
PLAYWRIGHT_SOURCES = {"linkedin", "builtin", "hiringcafe"}
PLAYWRIGHT_CONCURRENCY = int(os.getenv("PLAYWRIGHT_CONCURRENCY", "2"))

# Per-source budget in seconds. LinkedIn is allowed more time because it's
# the slowest (Playwright + N×M matrix + anti-bot delays), but capped hard
# so a hung session can't starve the downstream loop or blow the overall
# Vercel budget on the calling side. Tune in Railway env if a source
# chronically hits its ceiling.
DEFAULT_SOURCE_TIMEOUT = int(os.getenv("SOURCE_TIMEOUT_SECONDS", "60"))
SOURCE_TIMEOUTS = {
    "linkedin": int(os.getenv("LINKEDIN_TIMEOUT_SECONDS", "90")),
    "builtin": DEFAULT_SOURCE_TIMEOUT,
    "hiringcafe": DEFAULT_SOURCE_TIMEOUT,
    # ATS scrapers hit REST JSON endpoints and rarely exceed ~10s; keep
    # the budget tight so a flaky board can't consume the whole window.
    "greenhouse": 45,
    "lever": 45,
    "ashby": 45,
}

# Global score floor, applied on top of the user's own min_match_score (the
# max of the two wins). min_match_score defaults to 0 (14 of 17 onboarded
# users never changed it), so until 2026-10-20 every scored job was inserted:
# of the 387 jobs created since 2026-10-16, 138 (36%) had match_score 0-2.
# Haiku's own rubric calls raw 0-30 "wrong role/level", and a stored
# match_score of 2 is raw <= 25 (round(25 / 10) == 2), so 3 is the first value
# that is not "wrong role". Measured 2026-10-20 (read-only, all-time): of the
# 750 Haiku-scored rows users have ever seen, 169 scored 0-2 and 3 of those
# were acted on (applied or moved out of New), against 86 of the 581 scored
# 3+: a 1.8% vs 14.8% action rate, and 3 of the 7 negative-feedback rows (all
# "wrong industry") sit on score-2 jobs; the one "not a fit" row is on a 3.
# In the 2026-10-16 window a floor of 3 drops 120 of the
# 369 Haiku-scored rows (33%: HiringCafe 58 of 58, BuiltIn 39, LinkedIn 12)
# and keeps the 3-4 band (76 rows, 21%) that Haiku calls tangential and that
# users do act on (21 all-time applies at 4). The daily cap is applied before
# scoring, so every dropped job is a slot the user does not get back.
#
# Heuristic-only scores sit on a different, compressed scale and are exempt
# by default. Recomputing scorer.score_job for the 369 Haiku-scored rows with
# the owning user's real resume and titles: of the 150 jobs Haiku rated 7 or
# higher, 44 (29%) score only 1-2 on the heuristic, so a floor of 3 there
# would drop nearly a third of the good jobs whenever Haiku is unavailable (no
# API key, no credits, a failed call) or a job falls outside the top-20 batch.
# MIN_INSERT_SCORE_HEURISTIC is the knob if that changes (no job Haiku rated
# 7+ scored a heuristic 0, so 1 is the safe value). It never applies without
# a resume, because score_job returns 0 for every job then and the number
# carries no information (all 18 heuristic-only rows since 2026-10-16 were
# one resume-less user's, all 0).
MIN_INSERT_SCORE = int(os.getenv("MIN_INSERT_SCORE", "3"))
MIN_INSERT_SCORE_HEURISTIC = int(os.getenv("MIN_INSERT_SCORE_HEURISTIC", "0"))


def short_user(user_id: str) -> str:
    """First 8 hex chars of sha256(user_id).

    Enough to correlate the log lines of one run without putting the id itself
    into the public GitHub Actions log. scripts/cleanup/dismiss-junk.ts prints
    the same hash so counts can be matched across the two.
    """
    return hashlib.sha256((user_id or "").encode()).hexdigest()[:8]


def insert_floor(
    user_min: int,
    haiku_scored: bool,
    has_resume: bool,
    global_min: int | None = None,
    heuristic_min: int | None = None,
) -> int:
    """Lowest match_score (0-10) a job may carry and still be inserted.

    The user's own min_match_score always applies. Haiku-scored jobs also face
    the global floor (max of the two). Heuristic-only jobs face the heuristic
    floor instead, and only when a resume exists: without one every heuristic
    score is 0 by construction, so there is nothing to judge.
    """
    global_min = MIN_INSERT_SCORE if global_min is None else global_min
    heuristic_min = MIN_INSERT_SCORE_HEURISTIC if heuristic_min is None else heuristic_min
    user_min = max(0, int(user_min or 0))
    if haiku_scored:
        return max(user_min, global_min)
    if has_resume:
        return max(user_min, heuristic_min)
    return user_min


def resolve_score(haiku: dict | None, heuristic: int) -> tuple[int, str, list[str], list[str]]:
    """Final 0-10 score plus Haiku's extras (reasoning, matched_skills, concerns).

    Haiku scores 0-100; the UI expects 0-10 in match_score. Round to nearest so
    a 78 lands at 8 (and stays above min_match_score filters users set against
    the legacy 0-10 scale). Jobs Haiku did not score keep the heuristic number.
    """
    if haiku:
        return round(haiku["score"] / 10), haiku["reasoning"], haiku["matched_skills"], haiku["concerns"]
    return heuristic, "", [], []


def get_supabase():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(500, "Supabase credentials not configured")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# Probe once per cold start whether the Haiku-score columns exist yet. Until
# migration 016 ships we must NOT send score_reasoning/matched_skills/concerns
# in the insert payload or PostgREST rejects the whole row with 42703. Cached
# so we only pay one round-trip per Railway instance.
_haiku_columns_checked = False
_haiku_columns_available = False


def haiku_columns_available(supabase) -> bool:
    global _haiku_columns_checked, _haiku_columns_available
    if _haiku_columns_checked:
        return _haiku_columns_available
    try:
        supabase.table("jobs").select("score_reasoning", count=None, head=True).limit(1).execute()
        _haiku_columns_available = True
        logger.info("Haiku columns detected — semantic scoring fields will be persisted")
    except Exception as e:
        # 42703 = column does not exist. Anything else we also treat as "skip
        # the new fields" so a transient lookup error doesn't corrupt inserts.
        _haiku_columns_available = False
        logger.warning(f"Haiku columns unavailable ({e}) — dropping those fields from insert")
    _haiku_columns_checked = True
    return _haiku_columns_available


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


# Global serialization for /scrape. The container has finite RAM (~1GB on
# our Railway plan); each concurrent scrape spawns up to PLAYWRIGHT_CONCURRENCY
# browsers at ~400MB apiece, so two parallel requests reliably OOM-kill the
# process (we observed 'Killed' in logs whenever the cron sent batched calls).
# Queueing instead of failing means callers wait their turn — fine for our
# fire-and-forget cron, and the per-source timeouts cap each scrape so the
# queue can't grow unbounded.
_scrape_lock = asyncio.Semaphore(1)


@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    async with _scrape_lock:
        return await _scrape_inner(req)


async def _scrape_inner(req: ScrapeRequest):
    # Counts only at INFO. The ingest runs in GitHub Actions and its log is
    # public, so users' titles and locations (their search terms) stay out of
    # it; LOG_LEVEL=DEBUG shows them locally.
    user_tag = short_user(req.user_id)
    logger.info(
        f"Scrape request: user={user_tag}, titles={len(req.target_titles)}, "
        f"expanded={len(req.expanded_titles or [])}, locations={len(req.target_locations)}, "
        f"sources={len(req.sources)}, companies={len(req.companies)}, limit={req.daily_job_limit}, "
        f"min_match_score={req.min_match_score}"
    )
    logger.debug(
        f"Scrape request detail: titles={req.target_titles}, locations={req.target_locations}, "
        f"sources={req.sources}"
    )

    if not req.target_titles or not req.target_locations:
        return {"jobs_added": 0, "message": "No titles or locations configured"}

    if not req.resume_text:
        logger.warning(f"User {user_tag} has no resume: match scores will be 0")

    # Union target_titles with upstream-expanded variants. Dedup is case-
    # insensitive but preserves the first-seen casing so logs stay readable.
    # target_titles always wins tie-breaks (appears first).
    seen_titles: set[str] = set()
    effective_titles: list[str] = []
    for t in list(req.target_titles) + list(req.expanded_titles or []):
        key = (t or "").strip().lower()
        if not key or key in seen_titles:
            continue
        seen_titles.add(key)
        effective_titles.append(t)
    if req.expanded_titles:
        logger.info(
            f"Titles: {len(req.target_titles)} target + {len(req.expanded_titles)} expanded "
            f"-> {len(effective_titles)} unique"
        )

    # Fold user's not-a-fit companies into the excluded-companies filter. Case-
    # insensitive dedup; values from either list survive in their original form
    # so the substring match in JobListing.is_excluded_company keeps working.
    seen_excl: set[str] = set()
    effective_excluded_companies: list[str] = []
    for c in list(req.excluded_companies) + list(req.negative_companies or []):
        key = (c or "").strip().lower()
        if not key or key in seen_excl:
            continue
        seen_excl.add(key)
        effective_excluded_companies.append(c)
    if req.negative_companies:
        logger.info(
            f"Excluded companies: {len(req.excluded_companies)} base + "
            f"{len(req.negative_companies)} negative-feedback -> "
            f"{len(effective_excluded_companies)} unique"
        )

    supabase = get_supabase()

    # Get existing jobs for this user to deduplicate against
    existing_keys = set()
    try:
        result = supabase.table("jobs").select("company, role").eq("user_id", req.user_id).execute()
        for row in result.data or []:
            key = f"{normalize_company(row.get('company', ''))}|{normalize_title(row.get('role', ''))}"
            existing_keys.add(key)
        logger.info(f"User has {len(existing_keys)} existing jobs")
    except Exception as e:
        logger.warning(f"Failed to load existing jobs: {e}")

    # Run enabled scrapers concurrently. Each source gets its own budget;
    # total wall clock is max(budgets), not sum. This matters because Railway's
    # edge kills requests past ~120s — serial scraping with 5+ sources would
    # 502 even when every individual source succeeds. Concurrent + per-source
    # timeout means LinkedIn hanging doesn't starve anyone else, AND the whole
    # pass finishes inside the request window.
    all_jobs = []
    per_source_limit = max(5, req.daily_job_limit // len(req.sources)) if req.sources else req.daily_job_limit

    # Shared across all _run_one coroutines in this request — limits how
    # many browser-launching scrapers run at once.
    playwright_sem = asyncio.Semaphore(PLAYWRIGHT_CONCURRENCY)

    async def _run_one(source: str):
        """Execute one scraper under its budget. Returns (source, jobs, error)."""
        src_lower = source.lower()
        scraper_fn = SCRAPER_MAP.get(src_lower)
        if not scraper_fn:
            return (source, [], f"unknown source")

        if src_lower in ATS_SOURCES:
            if not any((c.ats_type or "").lower() == src_lower for c in req.companies):
                return (source, [], "no tracked companies")

        timeout = SOURCE_TIMEOUTS.get(src_lower, DEFAULT_SOURCE_TIMEOUT)
        source_start = datetime.now()

        async def _invoke():
            kwargs: dict = {
                "titles": effective_titles,
                "locations": req.target_locations,
                "limit": per_source_limit,
            }
            # Only ATS scrapers take the tracked-companies list. The old code
            # passed companies=None to everyone and re-ran the scraper on
            # TypeError, which also swallowed real TypeErrors inside a scraper.
            if src_lower in ATS_SOURCES:
                kwargs["companies"] = req.companies
            if src_lower == "linkedin":
                # Seeds the daily title x location rotation (linkedin.select_pairs).
                kwargs["user_id"] = req.user_id
            return await scraper_fn(**kwargs)

        try:
            # Gate browser-launching scrapers behind the shared semaphore so we
            # never have more than PLAYWRIGHT_CONCURRENCY Chromium processes
            # alive at once. ATS scrapers are pure HTTP and run freely.
            # PLAYWRIGHT_CONCURRENCY=0 disables all browser sources entirely —
            # useful on memory-constrained hosts where a single Chromium OOMs.
            if src_lower in PLAYWRIGHT_SOURCES:
                if PLAYWRIGHT_CONCURRENCY == 0:
                    return (source, [], "playwright disabled (PLAYWRIGHT_CONCURRENCY=0)")
                async with playwright_sem:
                    jobs = await asyncio.wait_for(_invoke(), timeout=timeout)
            else:
                jobs = await asyncio.wait_for(_invoke(), timeout=timeout)
            elapsed = (datetime.now() - source_start).total_seconds()
            logger.info(f"{source}: scraped {len(jobs)} jobs in {elapsed:.1f}s")
            return (source, jobs, None)
        except asyncio.TimeoutError:
            elapsed = (datetime.now() - source_start).total_seconds()
            logger.warning(
                f"{source} timed out after {elapsed:.1f}s (budget {timeout}s) — "
                f"moving on so the rest of the run doesn't stall"
            )
            return (source, [], f"timeout after {timeout}s")
        except Exception as e:
            elapsed = (datetime.now() - source_start).total_seconds()
            # Playwright errors append a call log with the page URL, and a
            # search URL carries the user's titles and locations, so only the
            # exception type and first line reach the public log at ERROR.
            logger.error(f"{source} scraper failed after {elapsed:.1f}s: {linkedin.brief_error(e)}")
            logger.debug(f"{source} scraper error detail: {e}")
            return (source, [], str(e))

    results = await asyncio.gather(*[_run_one(s) for s in req.sources], return_exceptions=False)

    # Per-source stats accumulator. Keyed by source (raw case from the request)
    # so we preserve whatever the caller sent. Filled in across dedup + insert.
    source_stats: dict[str, dict] = {}
    for source, jobs, err in results:
        all_jobs.extend(jobs)
        source_stats[source] = {
            "source": source,
            "jobs_returned": len(jobs),
            "jobs_after_dedup": 0,
            "jobs_inserted": 0,
            "error": err,
        }

    # Deduplicate
    unique_jobs = deduplicate(all_jobs, existing_keys)

    # Filter by salary floor
    if req.salary_floor > 0:
        before = len(unique_jobs)
        unique_jobs = [j for j in unique_jobs if not _below_salary_floor(j, req.salary_floor)]
        logger.info(f"Salary filter: {before} -> {len(unique_jobs)}")

    # Filter excluded companies (union of user-managed excluded + feedback
    # negative_companies).
    if effective_excluded_companies:
        before = len(unique_jobs)
        unique_jobs = [
            j for j in unique_jobs if not j.is_excluded_company(effective_excluded_companies)
        ]
        logger.info(f"Excluded companies filter: {before} -> {len(unique_jobs)}")

    # Filter excluded titles (user-managed substring deny-list — catches
    # off-target roles the loose family filter lets through, e.g. a Product
    # Designer who doesn't want "graphic" or "brand" designer roles).
    if req.excluded_titles:
        before = len(unique_jobs)
        unique_jobs = [j for j in unique_jobs if not j.is_excluded_title(req.excluded_titles)]
        logger.info(f"Excluded titles filter: {before} -> {len(unique_jobs)}")

    # Role-family relevance filter. Search APIs return loose keyword matches
    # ("Product Designer" → "Product Manager" leak), so drop anything whose
    # title doesn't share a family with the user's target_titles. We match
    # against the user's canonical target_titles (NOT the expanded union) so
    # upstream query expansion can't sneak in off-role families.
    if req.target_titles:
        before = len(unique_jobs)
        unique_jobs = [j for j in unique_jobs if is_title_relevant(j.title, req.target_titles)]
        dropped = before - len(unique_jobs)
        logger.info(f"Title relevance filter: {before} -> {len(unique_jobs)} ({dropped} off-role dropped)")

    # Fill in jobs_after_dedup per source using the post-filter set so the
    # stat reflects "jobs that survived all the way to the scoring stage."
    for j in unique_jobs:
        s = source_stats.get(j.source)
        if s is not None:
            s["jobs_after_dedup"] += 1

    # Enforce daily limit
    unique_jobs = unique_jobs[:req.daily_job_limit]

    # Score pass 1 — cheap heuristic. We need a score on every job so we can
    # (a) rank candidates for the Haiku rescore and (b) fall back cleanly when
    # Haiku is unavailable or skips a row.
    heuristic_scores: dict[str, int] = {}
    for job in unique_jobs:
        heuristic_scores[job.id] = score_job(job, req.resume_text, effective_titles)

    # Score pass 2 — Haiku semantic rescore on the top HAIKU_BATCH_SIZE by
    # heuristic. Returns richer data (0-100 score, reasoning, matched_skills,
    # concerns). Anything not Haiku-scored keeps the heuristic number. If
    # ANTHROPIC_API_KEY is unset or the batch fails, this is a no-op and we
    # ship heuristic-only scores.
    HAIKU_BATCH_SIZE = int(os.getenv("HAIKU_BATCH_SIZE", "20"))
    top_candidates = sorted(unique_jobs, key=lambda j: heuristic_scores.get(j.id, 0), reverse=True)[:HAIKU_BATCH_SIZE]
    haiku_by_id: dict[str, dict] = {}
    if top_candidates and req.resume_text:
        try:
            haiku_results = await rescore_with_haiku(
                top_candidates,
                req.resume_text,
                effective_titles,
                req.priority_industries,
                req.priority_keywords,
                req.negative_companies,
            )
            for r in haiku_results:
                haiku_by_id[r["id"]] = r
            logger.info(f"Haiku rescored {len(haiku_results)}/{len(top_candidates)} top candidates")
        except Exception as e:
            logger.warning(f"Haiku rescore failed entirely, falling back to heuristic: {e}")

    # Insert into Supabase
    inserted = 0
    today = datetime.now().strftime("%Y-%m-%d")
    has_resume = bool(req.resume_text)

    skipped_low_score = 0
    # Of the skipped jobs, how many the user's own min_match_score would have
    # let through, i.e. what the global floor alone removed.
    skipped_global_floor = 0
    for job in unique_jobs:
        try:
            dedup_key = f"{normalize_company(job.company)}|{normalize_title(job.title)}|{job.source}"
            haiku = haiku_by_id.get(job.id)
            match_score, reasoning, matched_skills, concerns = resolve_score(
                haiku, heuristic_scores.get(job.id, 0)
            )

            floor = insert_floor(req.min_match_score, haiku is not None, has_resume)
            if match_score < floor:
                skipped_low_score += 1
                if match_score >= req.min_match_score:
                    skipped_global_floor += 1
                continue

            priority = "High" if match_score >= 8 else "Medium" if match_score >= 5 else "Low"
            row = {
                "user_id": req.user_id,
                "company": job.company,
                "role": job.title,
                "location": job.location,
                "source": job.source,
                "status": "New",
                "priority": priority,
                "match_score": match_score,
                "salary_range": job.salary_range,
                "apply_link": job.apply_url,
                "date_found": today,
                "dedup_hash": dedup_key,
                "description": job.description or "",
            }
            if haiku_columns_available(supabase):
                row["score_reasoning"] = reasoning
                row["matched_skills"] = matched_skills
                row["concerns"] = concerns
            supabase.table("jobs").insert(row).execute()
            inserted += 1
            s = source_stats.get(job.source)
            if s is not None:
                s["jobs_inserted"] += 1
        except Exception as e:
            logger.error(f"Insert failed for {job.title} @ {job.company}: {e}")

    logger.info(
        f"Done: {inserted}/{len(unique_jobs)} jobs inserted for user {user_tag} "
        f"(skipped {skipped_low_score} below floor: user min_match_score={req.min_match_score}, "
        f"global MIN_INSERT_SCORE={MIN_INSERT_SCORE}; {skipped_global_floor} removed by the global floor alone)"
    )

    # Best-effort per-source stats write. Fire-and-forget semantics: a failure
    # here MUST NOT affect the /scrape response, so write_source_stats swallows
    # its own exceptions and source_stats_available() degrades gracefully when
    # the table is absent.
    try:
        write_source_stats(supabase, req.user_id, list(source_stats.values()))
    except Exception as e:
        logger.warning(f"source_stats outer write failed: {e}")

    return {
        "jobs_scraped": len(all_jobs),
        "jobs_after_dedup": len(unique_jobs),
        "jobs_added": inserted,
        "jobs_skipped_low_score": skipped_low_score,
        "jobs_skipped_global_floor": skipped_global_floor,
        "min_insert_score": MIN_INSERT_SCORE,
        "sources_used": req.sources,
    }


def _below_salary_floor(job, floor: int) -> bool:
    """Check if a job's salary is below the floor. Returns False if no salary info."""
    import re
    if not job.salary_range:
        return False
    numbers = re.findall(r'[\d,]+', job.salary_range.replace("K", "000"))
    if not numbers:
        return False
    amounts = [int(n.replace(",", "")) for n in numbers]
    # If the max salary mentioned is below the floor, exclude it
    max_salary = max(amounts)
    # Handle "120K" style (already expanded) vs raw numbers
    if max_salary < 1000:
        max_salary *= 1000
    return max_salary < floor
