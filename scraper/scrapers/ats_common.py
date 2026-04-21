"""Shared helpers for ATS scrapers (Greenhouse, Lever, Ashby).

All three expose a free, un-authed JSON endpoint per company. The flow is
identical across them: for each tracked company, GET the board, iterate the
listings, map to our JobListing model, return. Location/title filtering is
handled downstream in main.py.
"""

from __future__ import annotations

import asyncio
import re
from html import unescape
from typing import Any, Callable, Iterable

import httpx
from loguru import logger

from models import JobListing, TargetCompany


TIMEOUT = httpx.Timeout(10.0, connect=5.0)
CONCURRENCY = 8  # parallel company fetches per ATS
UA = "autopilot/1.0 (+https://autopilot.ahdahzeh.com)"


def strip_html(s: str | None) -> str:
    if not s:
        return ""
    # Drop scripts/styles first, then remaining tags, then collapse whitespace.
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", s, flags=re.I | re.S)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</(p|div|li|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def matches_location(loc: str, targets: list[str], is_remote: bool) -> bool:
    """Cheap substring match; downstream filters handle fine-grained policy.

    Remote jobs pass if any target is 'remote' OR if targets are empty.
    """
    if not targets:
        return True
    loc_lower = (loc or "").lower()
    for t in targets:
        t_lower = t.lower().strip()
        if not t_lower:
            continue
        if t_lower in ("remote", "anywhere") and is_remote:
            return True
        if t_lower in loc_lower or loc_lower in t_lower:
            return True
        # Common short-form hits (nyc -> new york, sf -> san francisco)
        if t_lower == "nyc" and "new york" in loc_lower:
            return True
        if t_lower == "sf" and "san francisco" in loc_lower:
            return True
    return is_remote and any(t.lower().strip() in ("remote", "anywhere") for t in targets)


def is_remote_text(text: str | None) -> bool:
    if not text:
        return False
    low = text.lower()
    return "remote" in low or "anywhere" in low or "distributed" in low


async def fetch_companies(
    companies: Iterable[TargetCompany],
    ats_type: str,
    per_company: Callable[[TargetCompany, httpx.AsyncClient], "asyncio.Future[list[JobListing]]"],
    limit: int,
) -> list[JobListing]:
    """Fan out to all companies of a given ats_type in parallel."""
    filtered = [c for c in companies if (c.ats_type or "").lower() == ats_type]
    if not filtered:
        logger.info(f"{ats_type}: no tracked companies, skipping")
        return []

    logger.info(f"{ats_type}: fetching {len(filtered)} companies")

    sem = asyncio.Semaphore(CONCURRENCY)
    results: list[JobListing] = []

    async with httpx.AsyncClient(
        timeout=TIMEOUT,
        headers={"User-Agent": UA, "Accept": "application/json"},
        follow_redirects=True,
    ) as client:

        async def _one(c: TargetCompany) -> list[JobListing]:
            async with sem:
                try:
                    jobs = await per_company(c, client)
                    return jobs
                except Exception as e:
                    logger.warning(f"{ats_type}:{c.slug} failed: {e}")
                    return []

        batches = await asyncio.gather(*[_one(c) for c in filtered])
        for batch in batches:
            results.extend(batch)
            if len(results) >= limit * 2:
                # Soft cap: collect up to 2x limit so downstream scoring/dedup
                # has headroom, but don't let a massive board balloon memory.
                break

    logger.info(f"{ats_type}: {len(results)} raw jobs across {len(filtered)} companies")
    return results[: limit * 2]


def company_display(company: TargetCompany, fallback: str = "") -> str:
    return company.name.strip() or fallback.strip() or company.slug.strip()


def parse_salary_from_text(text: str) -> str:
    """Extract a salary range from free-form JD text (best-effort).

    ATS APIs rarely return structured comp. Grab the first obvious range like
    $120k-$150k or $120,000 - $150,000. Returns empty string on no match.
    """
    if not text:
        return ""
    m = re.search(
        r"\$\s?(\d{2,3}(?:,\d{3})?|\d{2,3}k)\s*[-–to]+\s*\$?\s?(\d{2,3}(?:,\d{3})?|\d{2,3}k)",
        text,
        flags=re.I,
    )
    if not m:
        return ""
    return f"${m.group(1)} - ${m.group(2)}"


def numeric_salary_range(low: Any, high: Any, currency: str = "USD") -> str:
    try:
        lo = int(low) if low else 0
        hi = int(high) if high else 0
    except (TypeError, ValueError):
        return ""
    if not lo and not hi:
        return ""
    sym = "$" if currency.upper() == "USD" else ""
    if lo and hi:
        return f"{sym}{lo:,} - {sym}{hi:,}"
    return f"{sym}{(hi or lo):,}"
