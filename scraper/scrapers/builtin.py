"""BuiltIn job scraper: per-user titles and locations on the regional BuiltIn sites.

Cards are read with one selector per field. The title and employer links carry
data-id attributes, and every other attribute on a card sits beside a
FontAwesome icon (fa-location-dot for the city, fa-house-building for the work
arrangement, fa-sack-dollar for pay, fa-clock for the posting age), so nothing
here guesses which line of text is which.

Why (prod rows 2026-10-16 to 2026-10-20): the old card-text heuristic only
accepted a location line ending in a two-letter state code, but BuiltIn renders
"New York, NY, USA", so the city never matched and the code fell through to
the work arrangement: of 186 rows, 69 had location "", 49 "In-Office" and 40
"Hybrid". Its "walk up until the text is long enough" card detection also
overshot short cards into the whole result list, which is how one row got
another listing's title as its location.

Pages are still fetched with Playwright. The markup is server-rendered and a
plain HTTP client got the same 25 cards from a residential IP on 2026-10-20,
but Playwright is the path proven from the GitHub Actions runner (186 rows
since 2026-10-16) and the site is behind Cloudflare, so the fetch stays as it
was. Parsing is plain BeautifulSoup over page.content(), so it can be tested
from a saved page and the fetch can be swapped for httpx later without
touching the parser.

Logs: the GitHub Actions logs for this repo are public, so titles and
locations go out at DEBUG only; INFO carries counts and timings.
"""

from __future__ import annotations

import asyncio
import random
import re
import time
from contextlib import asynccontextmanager
from typing import NamedTuple
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from loguru import logger
from playwright.async_api import async_playwright

from models import JobListing

# Regional editions. BuiltIn has none for DC, Atlanta or Miami (builtindc.com
# is a 404), so those run on the national site with a text match on the
# card's city instead.
BUILTIN_CITY_MAP = {
    "new york": ("builtinnyc.com", "NYC"),
    "new york city": ("builtinnyc.com", "NYC"),
    "nyc": ("builtinnyc.com", "NYC"),
    "brooklyn": ("builtinnyc.com", "NYC"),
    "manhattan": ("builtinnyc.com", "NYC"),
    "chicago": ("builtinchicago.com", "Chicago"),
    "los angeles": ("builtinla.com", "LA"),
    "la": ("builtinla.com", "LA"),
    "san francisco": ("builtinsf.com", "SF"),
    "sf": ("builtinsf.com", "SF"),
    "austin": ("builtinaustin.com", "Austin"),
    "boston": ("builtinboston.com", "Boston"),
    "seattle": ("builtinseattle.com", "Seattle"),
    "denver": ("builtincolorado.com", "Colorado"),
    "colorado": ("builtincolorado.com", "Colorado"),
    "remote": ("builtin.com", "Remote"),
}

# Listings older than this are skipped; the daily run only wants fresh posts.
MAX_AGE_DAYS = 7


class SearchTarget(NamedTuple):
    domain: str
    label: str
    is_remote: bool
    # Set for places without a regional edition: the card's city must mention it.
    location_filter: str = ""


def map_builtin_location(loc: str) -> list[SearchTarget]:
    """Return the site searches to run for one user location."""
    lower = re.sub(r"\s+", " ", loc.lower().strip())
    if lower in BUILTIN_CITY_MAP:
        domain, label = BUILTIN_CITY_MAP[lower]
        if lower == "remote":
            return [SearchTarget(domain, label, True)]
        # The city's own remote listings too, since a local user can take them.
        return [SearchTarget(domain, label, False), SearchTarget(domain, f"{label} Remote", True)]
    return [SearchTarget("builtin.com", loc.strip(), False, loc.strip())]


def build_search_path(title: str, is_remote: bool) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    if is_remote:
        return f"/jobs/remote/search/{slug}"
    return f"/jobs/search/{slug}"


# ---------------------------------------------------------------------------
# Card parsing
# ---------------------------------------------------------------------------

def _icon_text(card, icon_class: str) -> str:
    """Text of the attribute beside a FontAwesome icon on a card.

    Pay and level are repeated inside the collapsed detail block; the first
    occurrence (the summary row) wins. The clock icon sits inside its text
    span, the others sit in a sibling box next to it.
    """
    icon = card.select_one(f"i.{icon_class}")
    if icon is None:
        return ""
    holder = icon.parent
    if holder is not None and holder.name == "span":
        return holder.get_text(" ", strip=True)
    row = holder.parent if holder is not None else None
    return row.get_text(" ", strip=True) if row is not None else ""


def parse_builtin_cards(html: str, base_url: str) -> list[dict]:
    """Extract the summary fields of every job card on a search page."""
    soup = BeautifulSoup(html, "html.parser")
    cards = []
    for card in soup.select('div[data-id="job-card"]'):
        title_el = card.select_one('a[data-id="job-card-title"]')
        if title_el is None:
            continue
        title = title_el.get_text(" ", strip=True)
        href = (title_el.get("href") or "").strip()
        if not title or not href:
            continue
        company_el = card.select_one('a[data-id="company-title"]')
        cards.append({
            "title": title,
            "company": company_el.get_text(" ", strip=True) if company_el is not None else "",
            "url": urljoin(base_url, href),
            "geo": _icon_text(card, "fa-location-dot"),
            "work_type": _icon_text(card, "fa-house-building"),
            "salary": _icon_text(card, "fa-sack-dollar"),
            "posted": _icon_text(card, "fa-clock"),
            "level": _icon_text(card, "fa-trophy"),
        })
    return cards


_NUMBER_WORDS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}
_AGE_RE = re.compile(r"(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month|year)s?\b")


def parse_posted_days(text: str) -> int | None:
    """Days since posting from BuiltIn's age badge ("5 Days Ago", "Reposted 12 Days Ago",
    "35 Minutes Ago", "Yesterday", "One Month Ago"). None when unrecognised."""
    low = (text or "").lower().replace("reposted", "").strip()
    if not low:
        return None
    if any(w in low for w in ("minute", "hour", "just now", "today")):
        return 0
    if "yesterday" in low:
        return 1
    m = _AGE_RE.search(low)
    if not m:
        return None
    n = int(m.group(1)) if m.group(1).isdigit() else _NUMBER_WORDS[m.group(1)]
    return n * {"day": 1, "week": 7, "month": 30, "year": 365}[m.group(2)]


COUNTRY_ONLY = {"us", "usa", "united states", "united states of america"}
_ZIP_PREFIX_RE = re.compile(r"^\d{5}(?:-\d{4})?,\s*")
_COUNTRY_SUFFIX_RE = re.compile(r",\s*(?:usa|us|united states)$", re.I)


def normalize_location(geo: str, work_type: str, fallback: str = "") -> str:
    """The location to store: the city/region, with the work arrangement kept
    only when the job is remote ("Illinois (Remote)", "Remote (US)")."""
    geo = _ZIP_PREFIX_RE.sub("", (geo or "").strip())
    if geo.lower() in COUNTRY_ONLY:
        geo = "US"
    else:
        geo = _COUNTRY_SUFFIX_RE.sub("", geo)
    arrangement = (work_type or "").strip()
    if "remote" in arrangement.lower():
        if not geo or geo == "US":
            return f"{arrangement} (US)"
        return f"{geo} ({arrangement})"
    return geo or fallback


STATE_NAMES = {
    "ny": "new york", "nj": "new jersey", "ct": "connecticut", "dc": "district of columbia",
    "ca": "california", "tx": "texas", "il": "illinois", "wa": "washington", "ma": "massachusetts",
    "pa": "pennsylvania", "ga": "georgia", "fl": "florida", "co": "colorado", "az": "arizona",
    "va": "virginia", "md": "maryland", "nc": "north carolina", "oh": "ohio", "mi": "michigan",
}
_LOCATION_STOP = {"usa", "us", "u", "s", "united", "states", "metro", "area", "greater", "the", "city"}


def location_matches(wanted: str, geo: str) -> bool:
    """True when every word of the user's place (a state code may appear as
    the state's name) is in the card's city text."""
    words = [w for w in re.findall(r"[a-z0-9]+", wanted.lower().replace("d.c.", "dc")) if w not in _LOCATION_STOP]
    hay = re.sub(r"[^a-z0-9 ]+", " ", (geo or "").lower())
    for w in words:
        alternatives = {w, STATE_NAMES.get(w, w)}
        if not any(re.search(rf"\b{re.escape(a)}\b", hay) for a in alternatives):
            return False
    return True


def card_to_job(card: dict, target: SearchTarget) -> JobListing:
    work_type = card.get("work_type", "")
    job = JobListing(
        source="BuiltIn",
        title=card["title"],
        company=card.get("company", ""),
        location=normalize_location(card.get("geo", ""), work_type, fallback=target.label),
        is_remote="remote" in work_type.lower() or (not work_type and target.is_remote),
        salary_range=card.get("salary", ""),
        apply_url=card.get("url", ""),
        listing_url=card.get("url", ""),
    )
    job.generate_id()
    return job


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

@asynccontextmanager
async def _browser_page():
    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
    try:
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        yield await context.new_page()
    finally:
        await browser.close()
        await pw.stop()


async def fetch_search_html(page, url: str) -> str:
    await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    try:
        # Cards are server-rendered; this only waits out a slow response.
        await page.wait_for_selector('div[data-id="job-card"]', timeout=8000)
    except Exception:
        # A no-results page, or changed markup: the parser then reports 0 cards.
        pass
    return await page.content()


async def scrape(titles: list[str], locations: list[str], limit: int = 20) -> list[JobListing]:
    started = time.monotonic()
    targets: list[SearchTarget] = []
    for loc in locations:
        for target in map_builtin_location(loc):
            if target not in targets:
                targets.append(target)
    pairs = [(title, target) for title in titles if (title or "").strip() for target in targets]
    logger.info(f"BuiltIn: {len(titles)} titles x {len(targets)} site searches, {len(pairs)} planned")

    all_jobs: list[JobListing] = []
    seen: set[str] = set()

    async with _browser_page() as page:
        for i, (title, target) in enumerate(pairs, 1):
            if len(all_jobs) >= limit:
                break
            base_url = f"https://www.{target.domain}"
            url = base_url + build_search_path(title, target.is_remote)
            logger.debug(f"  BuiltIn search {i}: '{title}' on {target.label}")

            try:
                html = await fetch_search_html(page, url)
            except Exception as e:
                # Playwright errors quote the URL, which carries the title slug.
                logger.warning(f"  BuiltIn search {i}: page load failed ({type(e).__name__})")
                logger.debug(f"  BuiltIn search {i}: {e}")
                await asyncio.sleep(random.uniform(1, 2))
                continue

            cards = parse_builtin_cards(html, base_url)
            kept = new = 0
            for card in cards:
                if len(all_jobs) >= limit:
                    break
                days = parse_posted_days(card.get("posted", ""))
                if days is not None and days > MAX_AGE_DAYS:
                    continue
                if target.location_filter and not location_matches(target.location_filter, card.get("geo", "")):
                    continue
                kept += 1
                key = f"{card['title']}|{card.get('company', '')}".lower()
                if key in seen or card["url"] in seen:
                    continue
                seen.add(key)
                seen.add(card["url"])
                all_jobs.append(card_to_job(card, target))
                new += 1

            logger.info(f"  BuiltIn search {i}/{len(pairs)}: {len(cards)} cards, {kept} fresh and in place, {new} new")
            await asyncio.sleep(random.uniform(1.5, 3))

    logger.info(f"BuiltIn done: {len(all_jobs)} jobs in {time.monotonic() - started:.1f}s")
    return all_jobs
