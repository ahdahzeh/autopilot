"""USAJOBS: US federal government postings, via the official search API.

Endpoint: https://data.usajobs.gov/api/Search. Free, but every request needs
an API key (request one at developer.usajobs.gov) sent as Authorization-Key,
with the registered email as User-Agent. Without USAJOBS_API_KEY and
USAJOBS_EMAIL the source returns nothing and says so once per scrape.

Added 2026-11 for the Per Scholas cohort: agencies hire entry-level IT
specialists and cybersecurity analysts in volume, and many of those roles are
remote. "Remote" targets use RemoteIndicator=True; anything else is passed as
LocationName.
"""

from __future__ import annotations

import os

import httpx
from loguru import logger

from models import JobListing

ENDPOINT = "https://data.usajobs.gov/api/Search"
DATE_POSTED_DAYS = 14
MAX_TITLES = 6
MAX_LOCATIONS = 3
PER_SEARCH = 25


def _search_params(title: str, location: str) -> dict[str, str]:
    params = {"Keyword": title, "DatePosted": str(DATE_POSTED_DAYS), "ResultsPerPage": str(PER_SEARCH)}
    if "remote" in location.lower():
        params["RemoteIndicator"] = "True"
    else:
        params["LocationName"] = location
    return params


def _salary(remuneration: list[dict]) -> str:
    for r in remuneration or []:
        try:
            lo, hi = float(r.get("MinimumRange")), float(r.get("MaximumRange"))
        except (TypeError, ValueError):
            continue
        code = (r.get("RateIntervalCode") or "").upper()
        if code == "PH":
            return f"${lo:,.2f} - ${hi:,.2f} per hour"
        return f"${lo:,.0f} - ${hi:,.0f}"
    return ""


def to_listing(item: dict) -> JobListing | None:
    d = item.get("MatchedObjectDescriptor") or {}
    title = (d.get("PositionTitle") or "").strip()
    if not title:
        return None
    details = ((d.get("UserArea") or {}).get("Details") or {})
    location = (d.get("PositionLocationDisplay") or "").strip()
    remote = bool(details.get("RemoteIndicator")) or "remote" in location.lower()
    apply = (d.get("ApplyURI") or [None])[0] or d.get("PositionURI") or ""
    job = JobListing(
        source="USAJOBS",
        title=title,
        company=(d.get("OrganizationName") or d.get("DepartmentName") or "US Federal Government").strip(),
        location="Remote (US)" if remote and not location else location,
        is_remote=remote,
        description=(details.get("JobSummary") or "").strip(),
        salary_range=_salary(d.get("PositionRemuneration") or []),
        apply_url=apply,
        listing_url=d.get("PositionURI") or apply,
    )
    job.generate_id()
    return job


async def scrape(titles: list[str], locations: list[str], limit: int = 20) -> list[JobListing]:
    key, email = os.getenv("USAJOBS_API_KEY", "").strip(), os.getenv("USAJOBS_EMAIL", "").strip()
    if not key or not email:
        logger.info("USAJOBS: USAJOBS_API_KEY / USAJOBS_EMAIL not set, skipping")
        return []

    headers = {"Host": "data.usajobs.gov", "User-Agent": email, "Authorization-Key": key}
    seen: set[str] = set()
    out: list[JobListing] = []
    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        n = 0
        for title in titles[:MAX_TITLES]:
            for location in (locations or ["Remote"])[:MAX_LOCATIONS]:
                n += 1
                try:
                    resp = await client.get(ENDPOINT, params=_search_params(title, location))
                    resp.raise_for_status()
                    items = ((resp.json().get("SearchResult") or {}).get("SearchResultItems")) or []
                except Exception as e:
                    logger.warning(f"USAJOBS: search {n} failed: {type(e).__name__}")
                    continue
                new = 0
                for item in items:
                    job = to_listing(item)
                    if job and job.id not in seen:
                        seen.add(job.id)
                        out.append(job)
                        new += 1
                logger.info(f"USAJOBS: search {n}: {len(items)} results, {new} new")
    logger.info(f"USAJOBS done: {len(out)} jobs")
    return out[: max(limit * 3, limit)]
