"""NYC Jobs: City of New York government postings, from NYC Open Data.

Endpoint: https://data.cityofnewyork.us/resource/kpav-sd4t.json (Socrata, no
auth). Added 2026-11 for the Per Scholas NYC cohort: the city posts help
desk, IT service, data and security roles that none of the job boards carry,
about 130 tech postings a month. City jobs are on site, so this source only
runs for users who target New York City.

Each posting appears once per posting_type (Internal / External) under the
same job_id, so results are deduped by job_id. cityjobs.nyc.gov/job/<job_id>
redirects to the posting's page, which is where people apply.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

import httpx
from loguru import logger

from models import JobListing

ENDPOINT = "https://data.cityofnewyork.us/resource/kpav-sd4t.json"
APPLY_URL = "https://cityjobs.nyc.gov/job/{job_id}"
LOOKBACK_DAYS = 21
MAX_TITLES = 8
PER_TITLE = 40

NYC_MARKERS = ("new york", "nyc", "manhattan", "brooklyn", "bronx", "queens", "staten island")

# Agency names arrive upper case ("CONSUMER AND WORKER PROTECTION").
_SMALL_WORDS = {"and", "of", "the", "for", "on", "in", "to"}


# Words that say nothing about the job on their own. The pipeline's shared
# title check accepts a single word, so "IT Support Specialist" let through
# "Mediator and Intake Specialist"; city titles are full of these words, so
# this source requires every distinctive word of some target title instead.
_GENERIC = {
    "specialist", "analyst", "technician", "associate", "assistant", "junior", "jr", "senior", "sr",
    "entry", "level", "i", "ii", "iii", "iv", "1", "2", "3", "lead", "staff", "officer", "the", "and", "of",
}
_EXPAND = {"it": "information technology", "soc": "security operations", "bi": "business intelligence", "noc": "network operations"}


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def title_matches(job_title: str, targets: list[str]) -> bool:
    have = " " + " ".join(_words(job_title)) + " "
    for target in targets:
        core = [w for w in _words(target) if w not in _GENERIC]
        if not core:
            continue
        if all(f" {w} " in have or (w in _EXPAND and f" {_EXPAND[w]} " in have) for w in core):
            return True
    return False


def targets_nyc(locations: list[str]) -> bool:
    return any(any(m in (loc or "").lower() for m in NYC_MARKERS) for loc in locations)


def agency_display(agency: str) -> str:
    words = (agency or "").strip().lower().split()
    if words and words[0] == "nyc":
        words = words[1:]
    titled = [w if (i and w in _SMALL_WORDS) else w.capitalize() for i, w in enumerate(words)]
    return "NYC " + " ".join(titled) if titled else "City of New York"


def salary_text(row: dict) -> str:
    lo, hi, freq = row.get("salary_range_from"), row.get("salary_range_to"), (row.get("salary_frequency") or "").lower()
    try:
        lo_f, hi_f = float(lo), float(hi)
    except (TypeError, ValueError):
        return ""
    if freq.startswith("hour"):
        return f"${lo_f:,.2f} - ${hi_f:,.2f} per hour"
    return f"${lo_f:,.0f} - ${hi_f:,.0f}"


def to_listing(row: dict) -> JobListing | None:
    title = (row.get("business_title") or "").strip()
    job_id = (row.get("job_id") or "").strip()
    if not title or not job_id:
        return None
    place = (row.get("work_location") or "").strip().rstrip(".")
    place = re.sub(r",?\s*N\.?Y\.?$", "", place, flags=re.I).strip()
    location = f"{place}, New York, NY" if place else "New York, NY"
    description = "\n\n".join(
        part.strip()
        for part in (row.get("job_description"), row.get("minimum_qual_requirements"), row.get("preferred_skills"))
        if part and part.strip()
    )
    url = APPLY_URL.format(job_id=job_id)
    job = JobListing(
        source="NYC Jobs",
        title=title,
        company=agency_display(row.get("agency") or ""),
        location=location,
        is_remote=False,
        description=description,
        salary_range=salary_text(row),
        apply_url=url,
        listing_url=url,
    )
    job.generate_id()
    return job


async def scrape(titles: list[str], locations: list[str], limit: int = 20) -> list[JobListing]:
    if not targets_nyc(locations):
        logger.info("NYC Jobs: no New York City target, skipping")
        return []

    since = (datetime.utcnow() - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%dT00:00:00")
    seen: set[str] = set()
    out: list[JobListing] = []
    async with httpx.AsyncClient(timeout=20, headers={"Accept": "application/json"}) as client:
        for i, title in enumerate(titles[:MAX_TITLES]):
            params = {
                "$q": title,
                "$where": f"posting_date > '{since}'",
                "$order": "posting_date DESC",
                "$limit": str(PER_TITLE),
            }
            try:
                resp = await client.get(ENDPOINT, params=params)
                resp.raise_for_status()
                rows = resp.json()
            except Exception as e:
                logger.warning(f"NYC Jobs: search {i + 1} failed: {type(e).__name__}")
                continue
            new = 0
            for row in rows if isinstance(rows, list) else []:
                job_id = row.get("job_id")
                if not job_id or job_id in seen:
                    continue
                seen.add(job_id)
                job = to_listing(row)
                # The city's full-text search is loose ("IT Support" also
                # returns Customer Service Representative).
                if job and title_matches(job.title, titles):
                    out.append(job)
                    new += 1
            # Counts only: the search term is a user's target title.
            logger.info(f"NYC Jobs: search {i + 1}: {len(rows) if isinstance(rows, list) else 0} rows, {new} new")
    logger.info(f"NYC Jobs done: {len(out)} jobs")
    return out[: max(limit * 3, limit)]
