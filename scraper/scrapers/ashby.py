"""Ashby public job-board scraper.

Endpoint: https://api.ashbyhq.com/posting-api/job-board/{org_slug}?includeCompensation=true
No auth. Returns jobs with title, locationName, departmentName, jobUrl,
descriptionHtml, and optional compensation tiers.
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
    numeric_salary_range,
    parse_salary_from_text,
    strip_html,
)


BASE = "https://api.ashbyhq.com/posting-api/job-board"


def _pick_salary(job: dict) -> str:
    """Ashby compensation is a list of tiers with currency + tierSummaryValues."""
    comps = job.get("compensation") or {}
    tiers = comps.get("compensationTierSummary") or ""
    if tiers:
        return tiers
    # Newer schema: compensationTiers: [{ tierSummary, value }]
    tier_list = (comps.get("compensationTiers") or []) if isinstance(comps, dict) else []
    for t in tier_list:
        summary = t.get("tierSummary") or ""
        if summary:
            return summary
        components = t.get("components") or []
        for c in components:
            mn = c.get("minValue")
            mx = c.get("maxValue")
            if mn or mx:
                return numeric_salary_range(mn, mx, c.get("currencyCode", "USD"))
    return ""


async def _fetch_one(company: TargetCompany, client: httpx.AsyncClient) -> list[JobListing]:
    url = f"{BASE}/{company.slug}?includeCompensation=true"
    resp = await client.get(url)
    if resp.status_code == 404:
        logger.warning(f"ashby:{company.slug} -> 404 (check org slug)")
        return []
    resp.raise_for_status()
    payload = resp.json()

    display = company_display(company)
    out: list[JobListing] = []
    for j in payload.get("jobs", []) or []:
        title = (j.get("title") or "").strip()
        if not title:
            continue
        location = j.get("locationName") or ""
        secondary = j.get("secondaryLocations") or []
        if secondary:
            extra = ", ".join([s.get("locationName", "") for s in secondary if s.get("locationName")])
            if extra:
                location = f"{location}; {extra}" if location else extra

        description = strip_html(j.get("descriptionHtml") or j.get("descriptionPlain") or "")
        remote = (
            bool(j.get("isRemote"))
            or is_remote_text(location)
            or (j.get("employmentType") or "").lower() == "remote"
        )

        sal = _pick_salary(j)
        if not sal:
            sal = parse_salary_from_text(description)

        apply_url = j.get("jobUrl") or j.get("applyUrl") or ""

        job = JobListing(
            source="Ashby",
            title=title,
            company=display,
            location=location,
            is_remote=remote,
            description=description,
            salary_range=sal,
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
    raw = await fetch_companies(companies or [], "ashby", _fetch_one, limit)
    filtered = [j for j in raw if matches_location(j.location, locations, j.is_remote)]
    logger.info(f"ashby: {len(raw)} -> {len(filtered)} after location filter")
    return filtered[:limit]
