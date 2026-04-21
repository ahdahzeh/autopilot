"""Lever public postings scraper.

Endpoint: https://api.lever.co/v0/postings/{site}?mode=json
No auth. Each posting has categories{team,commitment,location}, description,
applyUrl, and sometimes salaryRange.
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


BASE = "https://api.lever.co/v0/postings"


async def _fetch_one(company: TargetCompany, client: httpx.AsyncClient) -> list[JobListing]:
    url = f"{BASE}/{company.slug}?mode=json"
    resp = await client.get(url)
    if resp.status_code == 404:
        logger.warning(f"lever:{company.slug} -> 404 (check site slug)")
        return []
    resp.raise_for_status()
    payload = resp.json()

    display = company_display(company)
    out: list[JobListing] = []
    postings = payload if isinstance(payload, list) else payload.get("postings") or []

    for p in postings:
        title = (p.get("text") or "").strip()
        if not title:
            continue
        cats = p.get("categories") or {}
        location = cats.get("location") or ""
        allLocations = p.get("allLocations") or ([location] if location else [])
        if isinstance(allLocations, list) and allLocations:
            location = ", ".join([str(x) for x in allLocations if x])

        # Lever splits description into lists + descriptionPlain; use plain when available
        description_plain = p.get("descriptionPlain") or strip_html(p.get("description"))
        lists = p.get("lists") or []
        for l in lists:
            header = l.get("text") or ""
            content = strip_html(l.get("content"))
            if header or content:
                description_plain += f"\n\n{header}\n{content}".strip()
        description = description_plain.strip()

        remote = (
            is_remote_text(location)
            or cats.get("commitment", "").lower() == "remote"
            or (p.get("workplaceType") or "").lower() == "remote"
        )

        sal = ""
        salary_range = p.get("salaryRange") or {}
        if salary_range:
            sal = numeric_salary_range(
                salary_range.get("min"),
                salary_range.get("max"),
                salary_range.get("currency", "USD"),
            )
        if not sal:
            sal = parse_salary_from_text(description)

        apply_url = p.get("hostedUrl") or p.get("applyUrl") or ""

        job = JobListing(
            source="Lever",
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
    raw = await fetch_companies(companies or [], "lever", _fetch_one, limit)
    filtered = [j for j in raw if matches_location(j.location, locations, j.is_remote)]
    logger.info(f"lever: {len(raw)} -> {len(filtered)} after location filter")
    return filtered[:limit]
