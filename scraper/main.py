"""Autopilot Scraper Service — FastAPI app for Railway."""

import asyncio
import os
from datetime import datetime

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from loguru import logger
from supabase import create_client

from models import ScrapeRequest
from scrapers import linkedin, builtin, hiringcafe, greenhouse, lever, ashby
from scrapers.dedup import deduplicate, normalize_company, normalize_title
from scorer import score_job, is_title_relevant

load_dotenv()

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
}

# ATS scrapers iterate user-specified companies rather than running keyword
# searches, so passing an empty companies list is a no-op for them.
ATS_SOURCES = {"greenhouse", "lever", "ashby"}

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


def get_supabase():
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise HTTPException(500, "Supabase credentials not configured")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    logger.info(f"Scrape request: user={req.user_id}, titles={req.target_titles}, "
                f"locations={req.target_locations}, sources={req.sources}, limit={req.daily_job_limit}")

    if not req.target_titles or not req.target_locations:
        return {"jobs_added": 0, "message": "No titles or locations configured"}

    if not req.resume_text:
        logger.warning(f"User {req.user_id} has no resume — match scores will be 0")

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

    # Run enabled scrapers
    all_jobs = []
    per_source_limit = max(5, req.daily_job_limit // len(req.sources)) if req.sources else req.daily_job_limit

    for source in req.sources:
        src_lower = source.lower()
        scraper_fn = SCRAPER_MAP.get(src_lower)
        if not scraper_fn:
            logger.warning(f"Unknown source: {source}")
            continue

        # Short-circuit ATS sources when no companies are tracked for that ATS.
        if src_lower in ATS_SOURCES:
            if not any((c.ats_type or "").lower() == src_lower for c in req.companies):
                logger.info(f"{source}: no tracked companies, skipping")
                continue

        timeout = SOURCE_TIMEOUTS.get(src_lower, DEFAULT_SOURCE_TIMEOUT)
        source_start = datetime.now()

        async def _run():
            try:
                return await scraper_fn(
                    titles=req.target_titles,
                    locations=req.target_locations,
                    limit=per_source_limit,
                    companies=req.companies if src_lower in ATS_SOURCES else None,
                )
            except TypeError:
                # Legacy scrapers without the companies kwarg
                return await scraper_fn(
                    titles=req.target_titles,
                    locations=req.target_locations,
                    limit=per_source_limit,
                )

        try:
            jobs = await asyncio.wait_for(_run(), timeout=timeout)
            elapsed = (datetime.now() - source_start).total_seconds()
            all_jobs.extend(jobs)
            logger.info(f"{source}: scraped {len(jobs)} jobs in {elapsed:.1f}s")
        except asyncio.TimeoutError:
            elapsed = (datetime.now() - source_start).total_seconds()
            logger.warning(
                f"{source} timed out after {elapsed:.1f}s (budget {timeout}s) — "
                f"moving on so the rest of the run doesn't stall"
            )
        except Exception as e:
            elapsed = (datetime.now() - source_start).total_seconds()
            logger.error(f"{source} scraper failed after {elapsed:.1f}s: {e}")

    # Deduplicate
    unique_jobs = deduplicate(all_jobs, existing_keys)

    # Filter by salary floor
    if req.salary_floor > 0:
        before = len(unique_jobs)
        unique_jobs = [j for j in unique_jobs if not _below_salary_floor(j, req.salary_floor)]
        logger.info(f"Salary filter: {before} -> {len(unique_jobs)}")

    # Filter excluded companies
    if req.excluded_companies:
        before = len(unique_jobs)
        unique_jobs = [j for j in unique_jobs if not j.is_excluded_company(req.excluded_companies)]
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
    # title doesn't share a family with the user's target_titles.
    if req.target_titles:
        before = len(unique_jobs)
        unique_jobs = [j for j in unique_jobs if is_title_relevant(j.title, req.target_titles)]
        dropped = before - len(unique_jobs)
        logger.info(f"Title relevance filter: {before} -> {len(unique_jobs)} ({dropped} off-role dropped)")

    # Enforce daily limit
    unique_jobs = unique_jobs[:req.daily_job_limit]

    # Insert into Supabase
    inserted = 0
    today = datetime.now().strftime("%Y-%m-%d")

    skipped_low_score = 0
    for job in unique_jobs:
        try:
            dedup_key = f"{normalize_company(job.company)}|{normalize_title(job.title)}|{job.source}"
            match_score = score_job(job, req.resume_text, req.target_titles)
            if match_score < req.min_match_score:
                skipped_low_score += 1
                continue
            priority = "High" if match_score >= 8 else "Medium" if match_score >= 5 else "Low"
            supabase.table("jobs").insert({
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
            }).execute()
            inserted += 1
        except Exception as e:
            logger.error(f"Insert failed for {job.title} @ {job.company}: {e}")

    logger.info(
        f"Done: {inserted}/{len(unique_jobs)} jobs inserted for user {req.user_id} "
        f"(skipped {skipped_low_score} below min_match_score={req.min_match_score})"
    )

    return {
        "jobs_scraped": len(all_jobs),
        "jobs_after_dedup": len(unique_jobs),
        "jobs_added": inserted,
        "jobs_skipped_low_score": skipped_low_score,
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
