"""LinkedIn Job Scraper: public guest search, per-user titles/locations."""

import asyncio
import hashlib
import math
import os
import random
import re
import time
from datetime import date
from typing import NamedTuple
from urllib.parse import urlencode
from playwright.async_api import async_playwright
from loguru import logger
from models import JobListing

# Cap the title×location matrix. With 7 titles × 3 locations = 21 searches at
# ~15s each plus detail fetches, one LinkedIn pass can easily run 5+ minutes,
# far past any reasonable caller timeout. MAX_SEARCHES caps total unique
# search URLs; MAX_DETAIL_CARDS_PER_SEARCH caps per-search detail fetches
# (the expensive part). Both tunable via env.
MAX_SEARCHES = int(os.getenv("LINKEDIN_MAX_SEARCHES", "6"))
MAX_DETAIL_CARDS_PER_SEARCH = int(os.getenv("LINKEDIN_MAX_DETAILS", "3"))

# main.py cancels the whole LinkedIn pass at LINKEDIN_TIMEOUT_SECONDS and keeps
# nothing from it (asyncio.wait_for drops the coroutine's partial results), so
# a pass that ran six searches and timed out on the seventh detail fetch
# inserted zero jobs. We read the same env var and stop launching new work
# SOFT_BUDGET_MARGIN_SECONDS before the hard deadline.
LINKEDIN_TIMEOUT_SECONDS = int(os.getenv("LINKEDIN_TIMEOUT_SECONDS", "90"))

# Playwright actions (click and friends) wait up to 30s for their target to be
# actionable. LinkedIn's guest pages lay a sign-in overlay over the "See more
# jobs" and "Show more" buttons, so every click waited the full 30s (measured
# 2026-10-20: 30.0s on the search page and 30.0s on each detail page), four
# stalls per search with three details. That is how a pass that started on
# time still hit the 180s hard timeout and lost everything. The description
# text is complete without the click, so a short bound costs nothing.
ACTION_TIMEOUT_MS = 2000
GOTO_TIMEOUT_MS = 15000

# One step (a search page or one detail page) is bounded by its goto, at most
# 7s of pacing sleeps and one bounded click, so under 25s. The margin covers
# the step already running when the soft deadline passes, the pacing sleep
# after it and browser teardown. A navigation also never gets more time than
# is left (step_timeout_ms), so a slow page cannot carry the pass over.
SOFT_BUDGET_MARGIN_SECONDS = 35


def soft_budget_seconds(hard_timeout: int, margin: int = SOFT_BUDGET_MARGIN_SECONDS) -> int:
    """Seconds of new work the pass may start before returning what it has."""
    return max(30, hard_timeout - margin)


def step_timeout_ms(deadline: float, now: float | None = None, cap_ms: int = GOTO_TIMEOUT_MS) -> int:
    """Navigation timeout clamped to the time left before `deadline` (floor 1s)."""
    now = time.monotonic() if now is None else now
    return max(1000, min(cap_ms, int((deadline - now) * 1000)))


# LinkedIn's geo for the whole United States. The guest search honours geoId
# over the free-text location (probed 2026-10-20: location=India plus this
# geoId returned US jobs, and location=Remote with no geoId returned Sydney,
# Singapore, Cologne and Rennes), so this is what makes "Remote" mean US-remote.
US_GEO_ID = "103644278"

# Remote work-type facet (1 on-site, 2 remote, 3 hybrid). Sent for every
# remote search as the product rule requires. Note the guest endpoint ignored
# it in the 2026-10-20 probe (identical results with f_WT=1/2/3 and f_WRA), so
# the geoId plus the country post-filter below are what actually hold the line.
REMOTE_WORK_TYPE = "2"


class SearchLocation(NamedTuple):
    """One LinkedIn search location.

    label:  free-text location LinkedIn resolves when geo_id is None
    geo_id: authoritative LinkedIn geo; wins over label when set
    remote: whether to add the remote work-type facet
    """

    label: str
    geo_id: str | None = None
    remote: bool = False


US_REMOTE = SearchLocation("United States", US_GEO_ID, True)

LINKEDIN_LOCATION_MAP: dict[str, SearchLocation] = {
    "new york": SearchLocation("New York City Metropolitan Area"),
    "new york city": SearchLocation("New York City Metropolitan Area"),
    "nyc": SearchLocation("New York City Metropolitan Area"),
    "washington": SearchLocation("Washington DC-Baltimore Area"),
    "washington dc": SearchLocation("Washington DC-Baltimore Area"),
    "dc": SearchLocation("Washington DC-Baltimore Area"),
    "dmv": SearchLocation("Washington DC-Baltimore Area"),
    "atlanta": SearchLocation("Atlanta Metropolitan Area"),
    "chicago": SearchLocation("Chicago, Illinois"),
    "miami": SearchLocation("Miami, Florida"),
    "los angeles": SearchLocation("Los Angeles Metropolitan Area"),
    "la": SearchLocation("Los Angeles Metropolitan Area"),
    "san francisco": SearchLocation("San Francisco Bay Area"),
    "sf": SearchLocation("San Francisco Bay Area"),
    "austin": SearchLocation("Austin, Texas"),
    # "Remote" means US-remote. Anything else a user types that reads as
    # remote-in-the-US lands here too, instead of reaching LinkedIn as free
    # text (which is the worldwide-results path).
    "remote": US_REMOTE,
    "anywhere": US_REMOTE,
    "united states": US_REMOTE,
    "usa": US_REMOTE,
    "us": US_REMOTE,
}

# "Remote (US)", "US Remote", "Remote - United States", "remote, usa" ...
_REMOTE_US_RE = re.compile(r"^\W*(?:remote\b.*\b(?:us|usa|u\.s\.a?\.?|united states)|(?:us|usa|u\.s\.a?\.?|united states)\b.*\bremote)\W*$")


def map_location(loc: str) -> SearchLocation:
    lower = " ".join(loc.lower().split())
    mapped = LINKEDIN_LOCATION_MAP.get(lower)
    if mapped is not None:
        return mapped
    if _REMOTE_US_RE.match(lower):
        return US_REMOTE
    return SearchLocation(loc.strip())


def dedupe_locations(locations: list[SearchLocation]) -> list[SearchLocation]:
    """Order-preserving dedup. A set here would make the search order, and so
    the daily rotation, depend on Python's per-process string hashing."""
    seen: set[SearchLocation] = set()
    out: list[SearchLocation] = []
    for loc in locations:
        if loc in seen:
            continue
        seen.add(loc)
        out.append(loc)
    return out


def build_url(keywords: str, location: SearchLocation | str, time_filter: str = "r86400") -> str:
    if isinstance(location, str):
        location = map_location(location)
    params: list[tuple[str, str]] = [("keywords", keywords), ("location", location.label)]
    if location.geo_id:
        params.append(("geoId", location.geo_id))
    if location.remote:
        params.append(("f_WT", REMOTE_WORK_TYPE))
    params += [("f_TPR", time_filter), ("position", "1"), ("pageNum", "0")]
    return "https://www.linkedin.com/jobs/search/?" + urlencode(params)


# ---------------------------------------------------------------------------
# Country post-filter.
#
# LinkedIn location strings look like "Pune Division, Maharashtra, India",
# "Greater Hyderabad Area", "Toronto, Ontario, Canada", "New York, NY" or just
# "United States". A job is "clearly outside the US" when it carries a non-US
# country, region or well-known city marker AND nothing marks it as US. US
# markers are checked first so "Vancouver, WA", "Ontario, CA", "Paris, TX" and
# "New Mexico" stay US. Ambiguous names with no US tell ("Georgia", "Jersey")
# are left out on purpose; a false keep costs one job, a false drop costs a
# real match.
# ---------------------------------------------------------------------------

US_STATE_NAMES = {
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
    "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
    "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
    "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
    "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota",
    "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
    "wisconsin", "wyoming", "district of columbia", "puerto rico",
}
US_STATE_ABBREVS = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
    "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
    "VA", "WA", "WV", "WI", "WY", "DC", "PR",
}

# Country and region names: checked before cities so "London, Ontario, Canada"
# resolves to canada, not uk. Values are the country key a user's own target
# location must share for the job to be kept.
NON_US_COUNTRY_MARKERS: dict[str, str] = {
    "india": "india",
    "canada": "canada",
    "united kingdom": "uk", "uk": "uk", "u.k.": "uk", "england": "uk", "scotland": "uk",
    "wales": "uk", "northern ireland": "uk", "great britain": "uk",
    "ireland": "ireland",
    "australia": "australia",
    "new zealand": "new zealand",
    "germany": "germany", "deutschland": "germany",
    "france": "france",
    "spain": "spain",
    "portugal": "portugal",
    "italy": "italy",
    "netherlands": "netherlands", "the netherlands": "netherlands",
    "belgium": "belgium",
    "switzerland": "switzerland",
    "austria": "austria",
    "sweden": "sweden", "norway": "norway", "denmark": "denmark", "finland": "finland",
    "poland": "poland", "czech republic": "czechia", "czechia": "czechia",
    "romania": "romania", "hungary": "hungary", "ukraine": "ukraine", "greece": "greece",
    "turkey": "turkey", "türkiye": "turkey",
    "israel": "israel",
    # Lives here, not with the cities, so it is matched before "wales".
    "new south wales": "australia",
    "united arab emirates": "uae", "uae": "uae",
    "saudi arabia": "saudi arabia", "qatar": "qatar",
    "egypt": "egypt", "nigeria": "nigeria", "kenya": "kenya", "ghana": "ghana",
    "south africa": "south africa",
    "pakistan": "pakistan", "bangladesh": "bangladesh", "sri lanka": "sri lanka", "nepal": "nepal",
    "philippines": "philippines",
    "singapore": "singapore", "malaysia": "malaysia", "indonesia": "indonesia",
    "vietnam": "vietnam", "thailand": "thailand",
    "japan": "japan", "china": "china", "hong kong": "hong kong", "taiwan": "taiwan",
    "south korea": "south korea", "korea": "south korea",
    "mexico": "mexico",
    "brazil": "brazil", "argentina": "argentina", "colombia": "colombia", "chile": "chile",
    "peru": "peru", "costa rica": "costa rica", "uruguay": "uruguay",
    # Remote-region strings ("Remote - EMEA"). Users do not target these, so
    # they are always dropped for a US-remote search.
    "emea": "emea", "apac": "apac", "latam": "latam", "europe": "europe",
    "european union": "europe", "middle east": "middle east",
}

# Well-known non-US cities and sub-national regions LinkedIn sometimes shows
# without the country ("Greater Hyderabad Area", "Pune/Pimpri-Chinchwad Area").
NON_US_CITY_MARKERS: dict[str, str] = {
    # India
    "maharashtra": "india", "telangana": "india", "karnataka": "india", "tamil nadu": "india",
    "gujarat": "india", "west bengal": "india", "kerala": "india", "haryana": "india",
    "uttar pradesh": "india", "rajasthan": "india", "andhra pradesh": "india",
    "madhya pradesh": "india", "pune": "india", "pimpri-chinchwad": "india", "hyderabad": "india",
    "bengaluru": "india", "bangalore": "india", "mumbai": "india", "chennai": "india",
    "kolkata": "india", "noida": "india", "gurugram": "india", "gurgaon": "india",
    "ahmedabad": "india", "jaipur": "india", "kochi": "india", "coimbatore": "india",
    "indore": "india", "nagpur": "india", "lucknow": "india", "chandigarh": "india",
    "thiruvananthapuram": "india", "new delhi": "india", "delhi": "india",
    # Canada
    "ontario": "canada", "quebec": "canada", "québec": "canada", "british columbia": "canada",
    "alberta": "canada", "manitoba": "canada", "saskatchewan": "canada", "nova scotia": "canada",
    "newfoundland": "canada", "toronto": "canada", "vancouver": "canada", "montreal": "canada",
    "montréal": "canada", "calgary": "canada", "edmonton": "canada", "ottawa": "canada",
    "mississauga": "canada", "winnipeg": "canada",
    # UK and Ireland
    "london": "uk", "greater london": "uk", "manchester": "uk", "birmingham": "uk",
    "edinburgh": "uk", "glasgow": "uk", "dublin": "ireland",
    # Europe
    "berlin": "germany", "munich": "germany", "hamburg": "germany", "frankfurt": "germany",
    "paris": "france", "lyon": "france", "madrid": "spain", "barcelona": "spain",
    "lisbon": "portugal", "milan": "italy", "rome": "italy", "amsterdam": "netherlands",
    "rotterdam": "netherlands", "brussels": "belgium", "zurich": "switzerland",
    "zürich": "switzerland", "vienna": "austria", "stockholm": "sweden", "oslo": "norway",
    "copenhagen": "denmark", "helsinki": "finland", "warsaw": "poland", "krakow": "poland",
    "prague": "czechia", "bucharest": "romania", "budapest": "hungary", "kyiv": "ukraine",
    "athens": "greece", "istanbul": "turkey", "tel aviv": "israel",
    # Middle East and Africa
    "dubai": "uae", "abu dhabi": "uae", "riyadh": "saudi arabia", "doha": "qatar",
    "cairo": "egypt", "lagos": "nigeria", "nairobi": "kenya", "accra": "ghana",
    "johannesburg": "south africa", "cape town": "south africa",
    # South and South-East Asia
    "karachi": "pakistan", "lahore": "pakistan", "islamabad": "pakistan", "dhaka": "bangladesh",
    "colombo": "sri lanka", "manila": "philippines", "metro manila": "philippines",
    "cebu": "philippines", "kuala lumpur": "malaysia", "jakarta": "indonesia",
    "ho chi minh": "vietnam", "hanoi": "vietnam", "bangkok": "thailand",
    # East Asia and Oceania
    "tokyo": "japan", "shanghai": "china", "beijing": "china", "shenzhen": "china",
    "taipei": "taiwan", "seoul": "south korea", "sydney": "australia", "melbourne": "australia",
    "brisbane": "australia", "perth": "australia", "victoria": "australia",
    "queensland": "australia", "western australia": "australia",
    "auckland": "new zealand", "wellington": "new zealand",
    # Latin America
    "mexico city": "mexico", "guadalajara": "mexico", "monterrey": "mexico",
    "são paulo": "brazil", "sao paulo": "brazil", "rio de janeiro": "brazil",
    "buenos aires": "argentina", "bogotá": "colombia", "bogota": "colombia",
    "medellín": "colombia", "medellin": "colombia", "santiago": "chile", "lima": "peru",
    "san josé": "costa rica", "san jose, costa rica": "costa rica", "montevideo": "uruguay",
}


def _has_marker(text: str, marker: str) -> bool:
    return re.search(rf"(?<![a-z]){re.escape(marker)}(?![a-z])", text) is not None


def _longest_first(markers: dict[str, str]) -> list[tuple[str, str]]:
    # "New South Wales" must resolve before "wales", "Northern Ireland" before
    # "ireland": a longer phrase is always the more specific claim.
    return sorted(markers.items(), key=lambda kv: -len(kv[0]))


_COUNTRY_MARKERS = _longest_first(NON_US_COUNTRY_MARKERS)
_CITY_MARKERS = _longest_first(NON_US_CITY_MARKERS)


def _looks_us(lower: str) -> bool:
    if "united states" in lower or re.search(r"(?<![a-z])(usa|u\.s\.a?\.?)(?![a-z])", lower):
        return True
    for part in re.split(r"[,/]", lower):
        part = part.strip()
        if part in US_STATE_NAMES or part.replace(".", "").upper() in US_STATE_ABBREVS:
            return True
    return any(_has_marker(lower, name) for name in US_STATE_NAMES)


def country_of(location: str) -> str | None:
    """Country key when `location` is clearly outside the US, else None.

    None also covers empty strings and anything we cannot place, because
    dropping an unplaceable job is worse than keeping it.
    """
    lower = " ".join((location or "").lower().split())
    if not lower or _looks_us(lower):
        return None
    for marker, country in _COUNTRY_MARKERS:
        if _has_marker(lower, marker):
            return country
    for marker, country in _CITY_MARKERS:
        if _has_marker(lower, marker):
            return country
    return None


# Region keys a user may target ("Europe", "Remote - EMEA"). Cards carry a
# country, never a region, so a targeted region cannot be matched key for key;
# it says the user wants non-US results, so the post-filter stands down.
REGION_KEYS = {"emea", "apac", "latam", "europe", "middle east"}
ANY_COUNTRY = "*"


def allowed_countries(user_locations: list[str]) -> set[str]:
    """Non-US countries the user explicitly targets ("Pune" -> {"india"}).

    Includes ANY_COUNTRY when a target is a whole region, since every country
    in it is then explicitly wanted.
    """
    allowed = {c for c in (country_of(loc) for loc in user_locations) if c}
    if allowed & REGION_KEYS:
        allowed.add(ANY_COUNTRY)
    return allowed


def is_allowed_location(job_location: str, allowed: set[str]) -> bool:
    country = country_of(job_location)
    return country is None or ANY_COUNTRY in allowed or country in allowed


def brief_error(e: BaseException) -> str:
    """Exception type plus the first line of its message.

    Playwright appends a call log to its errors ("navigating to <url>"), and a
    search URL carries the user's titles and locations, so only the first line
    may go to the public log at ERROR; the full text is for DEBUG.
    """
    lines = str(e).strip().splitlines()
    return f"{type(e).__name__}: {lines[0]}" if lines else type(e).__name__


# ---------------------------------------------------------------------------
# Daily rotation of the search matrix.
#
# Before 2026-10-20 the matrix was cut to its first MAX_SEARCHES pairs every
# day, so a user with 7 titles × 3 locations only ever had titles 1 and 2
# searched; one IT-support user got 0 LinkedIn jobs in 4 days. Now the window
# slides each day, so every pair runs within a few days, and a per-user phase
# keeps users from all starting at the same corner.
#
# The slide is by the number of searches a day actually runs, not by
# MAX_SEARCHES: main.py hands LinkedIn its share of the user's daily limit
# (often 5 jobs), each search fetches up to 3 details, so a run normally stops
# after 2 searches. Sliding by 6 would have skipped pairs 3-6 of every window
# forever; sliding by 2 runs the whole matrix in ceil(N / 2) days. The rest of
# the window is only reached when searches come back thin.
# ---------------------------------------------------------------------------


def searches_per_day(limit: int, details_per_search: int, max_searches: int) -> int:
    """Searches a run normally gets through before `limit` jobs are collected."""
    if max_searches <= 0:
        return 1
    if limit <= 0 or details_per_search <= 0:
        return max_searches
    return max(1, min(max_searches, math.ceil(limit / details_per_search)))


def select_pairs(
    titles: list[str],
    locations: list[SearchLocation],
    max_searches: int,
    day: date,
    user_id: str = "",
    step: int | None = None,
) -> tuple[list[tuple[str, SearchLocation]], int]:
    """Return (pairs to run today, start offset into the full matrix).

    Deterministic for a given (titles, locations, day, user_id, step). Each
    day's window is the next `max_searches` pairs of the matrix starting
    `step` pairs after yesterday's start (wrapping around), so the first
    `step` pairs of ceil(N / step) consecutive days cover the whole matrix.
    `step` defaults to the window size; `max_searches` <= 0 means no cap.

    The matrix rotates whenever it has more pairs than a day's searches, not
    only when it exceeds the cap: a 2 x 2 user whose run stops after 2
    searches would otherwise have pairs 3 and 4 skipped every day, the same
    starvation the cap caused for 7 x 3 users (4 of 17 prod users on
    2026-10-20 had 3-6 pairs).
    """
    pairs = [(title, loc) for title in titles for loc in locations]
    n = len(pairs)
    window = n if max_searches <= 0 else min(max_searches, n)
    step = window if not step or step <= 0 else min(step, window)
    if n <= step:
        return pairs, 0
    phase = int(hashlib.sha256(user_id.encode()).hexdigest()[:8], 16) % n if user_id else 0
    start = ((day.toordinal() * step) + phase) % n
    rotated = pairs[start:] + pairs[:start]
    return rotated[:window], start


def parse_years(text: str) -> int | None:
    patterns = [
        r'(\d+)\+?\s*(?:years?|yrs?)\s*(?:of)?\s*(?:experience|exp)',
        r'(\d+)\s*-\s*(\d+)\s*(?:years?|yrs?)',
    ]
    years = []
    for p in patterns:
        for m in re.findall(p, text.lower()):
            if isinstance(m, tuple):
                years.extend(int(y) for y in m if y)
            else:
                years.append(int(m))
    return max(years) if years else None


async def scroll_and_load(page, max_scrolls=1):
    # The guest results page already renders 60 cards server-side and we fetch
    # at most MAX_DETAIL_CARDS_PER_SEARCH details per search, so one scroll is
    # plenty; three cost ~10s of a budget that is better spent on more searches.
    for _ in range(max_scrolls):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(1.5)
        btn = await page.query_selector(
            "button.infinite-scroller__show-more-button, button[aria-label='See more jobs']"
        )
        if btn:
            try:
                await btn.click()
                await asyncio.sleep(2)
            except Exception:
                pass


async def extract_cards(page) -> list[dict]:
    # One evaluate for the whole list. Until 2026-10-20 this made four
    # Playwright round trips per card (title, company, location, link); at 90
    # cards that was ~100s per search, most of the whole LinkedIn budget.
    try:
        cards = await page.evaluate(
            """
            () => {
                let items = document.querySelectorAll('ul.jobs-search__results-list > li');
                if (!items.length) items = document.querySelectorAll('.base-search-card');
                if (!items.length) items = document.querySelectorAll('div.base-card');
                const text = (el) => (el ? (el.innerText || el.textContent || '') : '');
                const out = [];
                for (const card of items) {
                    const title = text(card.querySelector("h3.base-search-card__title, h3[class*='title']"));
                    if (!title.trim()) continue;
                    const link = card.querySelector("a[href*='/jobs/view/'], a.base-card__full-link");
                    out.push({
                        title,
                        company: text(card.querySelector("h4.base-search-card__subtitle, a[class*='subtitle']")),
                        location: text(card.querySelector("span.job-search-card__location, span[class*='location']")),
                        url: ((link && link.getAttribute('href')) || '').split('?')[0],
                    });
                }
                return out;
            }
            """
        )
    except Exception as e:
        logger.warning(f"Card extraction failed: {e}")
        return []

    jobs = []
    for c in cards or []:
        if not isinstance(c, dict):
            continue
        clean = {k: " ".join(str(c.get(k) or "").split()) for k in ("title", "company", "location")}
        if clean["title"]:
            jobs.append({**clean, "url": str(c.get("url") or "").strip()})
    return jobs


async def get_detail(page, url: str, deadline: float | None = None) -> dict:
    if not url:
        return {"description": "", "salary_range": ""}
    try:
        timeout = step_timeout_ms(deadline) if deadline is not None else GOTO_TIMEOUT_MS
        await page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        await asyncio.sleep(random.uniform(2, 4))

        show_more = await page.query_selector("button.show-more-less-html__button")
        if show_more:
            try:
                await show_more.click()
                await asyncio.sleep(0.5)
            except Exception:
                pass

        for sel in [".show-more-less-html__markup", ".description__text", "section.description"]:
            el = await page.query_selector(sel)
            if el:
                text = await el.inner_text()
                if len(text) > 100:
                    return {"description": text.strip(), "salary_range": ""}

        return {"description": "", "salary_range": ""}
    except Exception as e:
        logger.warning(f"Detail failed for {url}: {brief_error(e)}")
        logger.debug(f"Detail error for {url}: {e}")
        return {"description": "", "salary_range": ""}


async def scrape(
    titles: list[str],
    locations: list[str],
    limit: int = 20,
    user_id: str = "",
    today: date | None = None,
) -> list[JobListing]:
    search_locs = dedupe_locations([map_location(loc) for loc in locations])
    allowed = allowed_countries(locations)
    step = searches_per_day(limit, MAX_DETAIL_CARDS_PER_SEARCH, MAX_SEARCHES)
    pairs, offset = select_pairs(titles, search_locs, MAX_SEARCHES, today or date.today(), user_id, step=step)
    total_pairs = len(titles) * len(search_locs)

    budget = soft_budget_seconds(LINKEDIN_TIMEOUT_SECONDS)
    started = time.monotonic()
    deadline = started + budget

    # Counts only at INFO: the runner's log is public, and titles/locations are
    # the user's search terms. The terms themselves go to DEBUG.
    logger.info(
        f"LinkedIn: {len(titles)} titles x {len(search_locs)} locations = {total_pairs} pairs, "
        f"running up to {len(pairs)} (rotation offset {offset}, step {step}/day, "
        f"max details/search {MAX_DETAIL_CARDS_PER_SEARCH}, limit {limit}, soft budget {budget}s, "
        f"non-US countries allowed: {len(allowed)})"
    )

    all_jobs: list[JobListing] = []
    seen: set[str] = set()
    searches_run = 0
    dropped_outside = 0

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
    context = await browser.new_context(
        viewport={"width": 1920, "height": 1080},
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )
    page = await context.new_page()
    # Bounds the clicks in scroll_and_load and get_detail (see ACTION_TIMEOUT_MS).
    page.set_default_timeout(ACTION_TIMEOUT_MS)

    try:
        for i, (title, location) in enumerate(pairs, 1):
            if len(all_jobs) >= limit:
                break
            if time.monotonic() > deadline:
                logger.warning(
                    f"LinkedIn: soft budget {budget}s reached after {searches_run}/{len(pairs)} searches, "
                    f"returning {len(all_jobs)} jobs before the hard timeout drops them"
                )
                break
            url = build_url(title, location)
            logger.debug(f"  search {i}: '{title}' in {location.label} (geoId={location.geo_id}, remote={location.remote})")
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=step_timeout_ms(deadline))
                await asyncio.sleep(random.uniform(1.5, 3))
                await scroll_and_load(page)
                searches_run += 1

                cards = await extract_cards(page)
                new_cards = [c for c in cards if c["url"] and c["url"] not in seen]
                for c in new_cards:
                    seen.add(c["url"])
                kept = [c for c in new_cards if is_allowed_location(c["location"], allowed)]
                dropped = len(new_cards) - len(kept)
                dropped_outside += dropped
                for c in new_cards:
                    if c not in kept:
                        logger.debug(f"    dropped (outside targeted countries): {c['location']}")

                logger.info(
                    f"  search {i}/{len(pairs)}: {len(cards)} cards, {len(new_cards)} new, "
                    f"{dropped} outside targeted countries"
                )

                for card in kept[:MAX_DETAIL_CARDS_PER_SEARCH]:
                    if len(all_jobs) >= limit or time.monotonic() > deadline:
                        break
                    await asyncio.sleep(random.uniform(1.5, 3))
                    detail = await get_detail(page, card["url"], deadline)
                    yoe = parse_years(detail["description"]) if detail["description"] else None

                    # The guest endpoint ignores the remote facet, so a remote
                    # search still returns on-site postings; flag by what the
                    # card says rather than by what we asked for.
                    card_text = f"{card['title']} {card['location']}".lower()
                    is_remote = "remote" in card_text or card["location"].strip().lower() == "united states"

                    job = JobListing(
                        source="LinkedIn",
                        title=card["title"],
                        company=card["company"],
                        location=card["location"],
                        is_remote=is_remote,
                        description=detail["description"],
                        years_experience=yoe,
                        salary_range=detail["salary_range"],
                        apply_url=card["url"],
                        listing_url=card["url"],
                    )
                    job.generate_id()
                    all_jobs.append(job)

            except Exception as e:
                # A goto timeout's message carries the search URL, and so the
                # user's search terms (probed 2026-10-20); first line only here.
                logger.error(f"    search {i} failed: {brief_error(e)}")
                logger.debug(f"    search {i} error detail: {e}")

            await asyncio.sleep(random.uniform(1.5, 3))
    finally:
        await browser.close()
        await pw.stop()

    elapsed = time.monotonic() - started
    logger.info(
        f"LinkedIn done: {len(all_jobs)} jobs from {searches_run} searches in {elapsed:.0f}s "
        f"({dropped_outside} cards dropped as outside targeted countries)"
    )
    return all_jobs
