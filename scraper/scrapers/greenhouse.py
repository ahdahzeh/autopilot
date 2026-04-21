"""Greenhouse public job-board scraper.

Endpoint: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
No auth, returns all active jobs with description, location, and apply URL.
"""

from __future__ import annotations

import httpx
from loguru import logger

from models import JobListing, TargetCompany
from scrapers.ats_common import (
    company_display,
    fetch_companies,
    is_remote_text,
    matches_location,
    parse_salary_from_text,
    strip_html,
)


BASE = "https://boards-api.greenhouse.io/v1/boards"


async def _fetch_one(company: TargetCompany, client: httpx.AsyncClient) -> list[JobListing]:
    url = f"{BASE}/{company.slug}/jobs?content=true"
    resp = await client.get(url)
    if resp.status_code == 404:
        logger.warning(f"greenhouse:{company.slug} -> 404 (check board token)")
        return []
    resp.raise_for_status()
    payload = resp.json()

    display = company_display(company)
    out: list[JobListing] = []
    for j in payload.get("jobs", []) or []:
        title = (j.get("title") or "").strip()
        if not title:
            continue
        location = (j.get("location") or {}).get("name", "") or ""
        description = strip_html(j.get("content"))
        remote = is_remote_text(location) or is_remote_text(title) or is_remote_text(description[:500])
        apply_url = j.get("absolute_url") or ""

        job = JobListing(
            source="Greenhouse",
            title=title,
            company=display,
            location=location,
            is_remote=remote,
            description=description,
            salary_range=parse_salary_from_text(description),
            apply_url=apply_url,
            listing_url=apply_url,
        )
        job.generate_id()
        out.append(job)
    return out


async def scrape(
    titles: list[str],
    locations: list[str],
    limit: int = 20,
    companies: list[TargetCompany] | None = None,
) -> list[JobListing]:
    raw = await fetch_companies(companies or [], "greenhouse", _fetch_one, limit)

    # Location pre-filter (title filter handled downstream by is_title_relevant)
    filtered = [j for j in raw if matches_location(j.location, locations, j.is_remote)]
    logger.info(f"greenhouse: {len(raw)} -> {len(filtered)} after location filter")
    return filtered[:limit]
