"""HiringCafe job scraper: one HTTP GET per search, read from the page's __NEXT_DATA__.

hiring.cafe now redirects to hiringcafe.com, whose search page is rendered on
the server (Next.js getServerSideProps). The first page of results ships inside
the <script id="__NEXT_DATA__"> blob as props.pageProps.ssrHits, with the title,
employer, formatted location, workplace type, parsed compensation and the real
apply URL as structured fields. So this scraper is a plain HTTP client: no
Chromium, no DOM heuristics, no guessing which line of a card is the title.

Why the DOM path had to go (prod rows 2026-10-16 to 2026-10-20): the card
markup put the posting age first, so the old "first line is the title" code
stored "1h" as the role and the title as the company on every row, pointed
apply_link at hiringcafe.com instead of the employer, and never sent a location
filter, so a New York user got Pomona, La Crosse and Brookings. Haiku scored
all 56 rows 0-2.

Filtering happens twice on purpose. The request carries the location (a city
with the site's own 50 mile radius, or United States plus workplaceTypes
["Remote"]) so the server does the heavy lifting, and every hit is then checked
again here against the requested title and location, because the search is a
fuzzy full-text match ("SOC Analyst" also returns "Senior Product Manager, SOC
Experience") and a silently ignored filter is exactly how the feed filled with
junk before.

The date window is one such ignored filter. The server honours sortBy="date"
and the locality (checked 2026-10-20: 64 hits for New York against 1461
nationwide, and the page order changes with sortBy), but dateFetchedPastNDays
changes nothing: 1, 3, 7, 30 and 365 days all returned the same 64 hits, and
the first page ran back 159 days. So the age cut is made here from each hit's
estimated_publish_date, the same 7 day rule BuiltIn applies to its age badge.
Without it the first review run returned five "SOC Analyst" remote jobs that
were 8 to 19 days old and New York data analyst roles 48 days old.

Cloudflare fronts hiringcafe.com. The plain client with Chrome's navigation
headers passed every search on 2026-10-20, and so did headless Chromium that
day, so a browser would add 400 MB of memory and nothing else. The site does
sometimes answer with a challenge page instead of results (one is saved as a
test fixture): it is detected, retried once, and then logged as a warning
while the source yields nothing rather than junk.

Logs: the GitHub Actions logs for this repo are public, so titles, locations
and anything else a user typed only ever go out at DEBUG. INFO carries counts
and timings.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Mapping
from urllib.parse import quote

import httpx
from loguru import logger

from models import JobListing
from scrapers.ats_common import numeric_salary_range


SEARCH_URL = "https://hiringcafe.com/classic"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
# The headers a Chrome page navigation sends. Cloudflare's bot score weighs
# them: the same GET without them came back as a challenge page.
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}
TIMEOUT = httpx.Timeout(20.0, connect=10.0)

# Cap on title x location searches per run. Each one is a ~700 KB GET that
# takes about a second, so the cap keeps a 10-title x 3-location user inside
# the source budget instead of letting the first titles spend all of it.
MAX_SEARCHES = int(os.getenv("HIRINGCAFE_MAX_SEARCHES", "15"))
# Sent as dateFetchedPastNDays (which the server ignores, see the module
# docstring) and enforced here against estimated_publish_date. Same window as
# BuiltIn's MAX_AGE_DAYS: the daily run only wants fresh posts.
DAYS_BACK = 7
# The radius the site itself attaches to a city (its defaultRadius), and the
# slack allowed when a hit's coordinates are checked again here: a listing's
# point is a city centroid and the server may use a bounding box, so a 50 mile
# search can legitimately return a 60 mile suburb.
CITY_RADIUS_MILES = 50
RADIUS_SLACK = 1.5
MAX_DESCRIPTION = 3000


class ChallengePage(Exception):
    """The response was a Cloudflare challenge page instead of search results."""


@dataclass(frozen=True)
class LocationSpec:
    """How one user location is sent to the site and checked on the way back.

    kind is "remote" (United States, remote-only), "metro" (a city with
    coordinates and the 50 mile radius), "text" (an unknown place: nationwide
    search, then the card's city/state must mention it) or "anywhere".
    """

    kind: str
    label: str
    city: str = ""
    state: str = ""
    lat: float = 0.0
    lon: float = 0.0


US_COUNTRY = {
    "address_components": [{"long_name": "United States", "short_name": "US", "types": ["country"]}],
    "formatted_address": "United States",
    "geometry": {"location": {"lat": 0, "lon": 0}},
    "id": "user_country",
    "options": {"flexible_regions": ["anywhere_in_continent", "anywhere_in_world"]},
    "types": ["country"],
}

# City centroids for the places users actually type. The site wants a locality
# object with coordinates (it geocodes in the browser against its own place
# index, which we cannot call), so the common metros are carried here. Any
# other place falls back to a nationwide search plus a text match.
METROS: dict[str, tuple[str, str, float, float]] = {
    # key: (city as the site formats it, state code, lat, lon)
    "new york": ("New York City", "NY", 40.71427, -74.00597),
    "washington dc": ("Washington", "DC", 38.90719, -77.03687),
    "chicago": ("Chicago", "IL", 41.85003, -87.65005),
    "los angeles": ("Los Angeles", "CA", 34.05223, -118.24368),
    "san francisco": ("San Francisco", "CA", 37.77493, -122.41942),
    "austin": ("Austin", "TX", 30.26715, -97.74306),
    "boston": ("Boston", "MA", 42.35843, -71.05977),
    "seattle": ("Seattle", "WA", 47.60621, -122.33207),
    "atlanta": ("Atlanta", "GA", 33.749, -84.38798),
    "miami": ("Miami", "FL", 25.77427, -80.19366),
    "dallas": ("Dallas", "TX", 32.78306, -96.80667),
    "houston": ("Houston", "TX", 29.76328, -95.36327),
    "philadelphia": ("Philadelphia", "PA", 39.95233, -75.16379),
    "denver": ("Denver", "CO", 39.73915, -104.9847),
    "phoenix": ("Phoenix", "AZ", 33.44838, -112.07404),
    "san diego": ("San Diego", "CA", 32.71571, -117.16472),
}
METRO_ALIASES = {
    "nyc": "new york",
    "new york city": "new york",
    "new york, ny": "new york",
    "manhattan": "new york",
    "brooklyn": "new york",
    "queens": "new york",
    "bronx": "new york",
    "jersey city": "new york",
    "newark": "new york",
    "washington": "washington dc",
    "washington, dc": "washington dc",
    "washington d.c.": "washington dc",
    "washington, d.c.": "washington dc",
    "dc": "washington dc",
    "la": "los angeles",
    "sf": "san francisco",
    "bay area": "san francisco",
    "philly": "philadelphia",
}
REMOTE_WORDS = {"remote", "anywhere", "us remote", "remote us", "remote (us)", "united states", "usa", "us"}

STATE_NAMES = {
    "ny": "new york", "nj": "new jersey", "ct": "connecticut", "dc": "district of columbia",
    "ca": "california", "tx": "texas", "il": "illinois", "wa": "washington", "ma": "massachusetts",
    "pa": "pennsylvania", "ga": "georgia", "fl": "florida", "co": "colorado", "az": "arizona",
    "va": "virginia", "md": "maryland", "nc": "north carolina", "oh": "ohio", "mi": "michigan",
    "mn": "minnesota", "or": "oregon", "nv": "nevada", "tn": "tennessee", "mo": "missouri",
    "wi": "wisconsin", "ut": "utah", "in": "indiana",
}


def location_spec(loc: str) -> LocationSpec:
    raw = (loc or "").strip()
    key = re.sub(r"\s+", " ", raw.lower())
    if not key:
        return LocationSpec("anywhere", raw)
    if key in REMOTE_WORDS:
        return LocationSpec("remote", raw)
    key = METRO_ALIASES.get(key, key)
    metro = METROS.get(key)
    if metro:
        city, state, lat, lon = metro
        return LocationSpec("metro", raw, city=city, state=state, lat=lat, lon=lon)
    return LocationSpec("text", raw)


def search_state(query: str, spec: LocationSpec, days: int = DAYS_BACK) -> dict:
    """The searchState the site's own URL carries, trimmed to what we need.

    Shapes come from the site's client code: a locality gets a radius block
    and empty workplace_types, a country gets flexible_regions, and a remote
    search sets workplaceTypes both on the location and at the top level.
    """
    state: dict = {"searchQuery": query, "sortBy": "date", "dateFetchedPastNDays": days}
    if spec.kind == "metro":
        state["locations"] = [{
            "address_components": [
                {"long_name": spec.city, "short_name": spec.city, "types": ["locality"]},
                {
                    "long_name": STATE_NAMES.get(spec.state.lower(), spec.state).title(),
                    "short_name": spec.state,
                    "types": ["administrative_area_level_1"],
                },
                {"long_name": "United States", "short_name": "US", "types": ["country"]},
            ],
            "formatted_address": f"{spec.city}, {spec.state}, US",
            "geometry": {"location": {"lat": spec.lat, "lon": spec.lon}},
            "id": "autopilot_" + re.sub(r"[^a-z0-9]+", "_", spec.city.lower()),
            "options": {"ignore_radius": False, "radius": CITY_RADIUS_MILES, "radius_unit": "miles"},
            "types": ["locality"],
            "workplace_types": [],
        }]
        return state
    country = dict(US_COUNTRY)
    if spec.kind == "remote":
        country["workplace_types"] = ["Remote"]
        state["workplaceTypes"] = ["Remote"]
    state["locations"] = [country]
    return state


def search_url(state: dict) -> str:
    return f"{SEARCH_URL}?searchState={quote(json.dumps(state, separators=(',', ':')))}"


# ---------------------------------------------------------------------------
# Page parsing
# ---------------------------------------------------------------------------

NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
# The challenge page is a few KB with one of these in its <title>/<h1>; the
# real page also loads a Cloudflare script, so the markers alone are not enough.
CHALLENGE_MARKERS = ("just a moment", "performing security verification")


def looks_like_challenge(html: str, headers: Mapping[str, str] | None = None) -> bool:
    if headers and (headers.get("cf-mitigated") or "").lower() == "challenge":
        return True
    head = html[:4000].lower()
    return any(m in head for m in CHALLENGE_MARKERS) and "__NEXT_DATA__" not in html


def parse_search_page(html: str) -> list[dict]:
    """Return the ssrHits from a search page. Raises ChallengePage or ValueError."""
    if looks_like_challenge(html):
        raise ChallengePage("Cloudflare challenge page")
    m = NEXT_DATA_RE.search(html)
    if not m:
        raise ValueError("no __NEXT_DATA__ script in page")
    data = json.loads(m.group(1))
    props = (data.get("props") or {}).get("pageProps") or {}
    if props.get("ssrError"):
        raise ValueError("page reported ssrError")
    hits = props.get("ssrHits")
    if not isinstance(hits, list):
        raise ValueError("pageProps.ssrHits missing")
    return hits


# ---------------------------------------------------------------------------
# Title and location matching
# ---------------------------------------------------------------------------

# Abbreviations spelled out on both sides before comparing, so "SOC Analyst"
# meets "Security Operations Center Analyst" and "IT Support" meets
# "Information Technology Support". "Center" is dropped from the long forms:
# employers post the same job as "Security Operations Analyst" (three of the
# first fifty remote hits on 2026-10-20), and requiring the word lost them all.
TITLE_ALIASES = [
    (re.compile(r"\bsecurity operations cent(?:er|re)\b"), "security operations"),
    (re.compile(r"\bnetwork operations cent(?:er|re)\b"), "network operations"),
    (re.compile(r"\bsoc\b"), "security operations"),
    (re.compile(r"\bnoc\b"), "network operations"),
    (re.compile(r"\bi\.t\.?(?=\s|$)"), "information technology"),
    (re.compile(r"\bit\b"), "information technology"),
    (re.compile(r"\bbi\b"), "business intelligence"),
    (re.compile(r"\bqa\b"), "quality assurance"),
    (re.compile(r"\bgrc\b"), "governance risk and compliance"),
    (re.compile(r"\bhelpdesk\b"), "help desk"),
    (re.compile(r"\bservicedesk\b"), "service desk"),
    (re.compile(r"\bcyber[\s-]+security\b"), "cybersecurity"),
    (re.compile(r"\binfosec\b"), "information security"),
    (re.compile(r"\bsys[\s-]?admin\b"), "system administrator"),
    (re.compile(r"\bdev[\s-]?ops\b"), "devops"),
]
# Seniority, numbering and filler that should not decide a match: the scorer
# weighs seniority against the resume, the title filter only asks "is this
# the same job".
TITLE_STOP = {
    "a", "an", "and", "the", "of", "or", "for", "in", "at", "to", "with", "on",
    "jr", "junior", "sr", "senior", "entry", "level", "associate", "lead", "staff",
    "principal", "intern", "internship", "i", "ii", "iii", "iv", "v", "1", "2", "3", "4",
}


def title_tokens(text: str) -> list[str]:
    low = (text or "").lower()
    for pattern, replacement in TITLE_ALIASES:
        low = pattern.sub(replacement, low)
    return [t for t in re.findall(r"[a-z0-9+#]+", low) if t not in TITLE_STOP]


def _token_match(need: str, have: str) -> bool:
    if need == have:
        return True
    # Prefix tolerance for inflections: technician/tech, analyst/analytics.
    return len(need) >= 4 and len(have) >= 4 and (have.startswith(need) or need.startswith(have))


def matches_title(target: str, *candidates: str) -> bool:
    """True when some candidate title contains every meaningful word of the target."""
    need = title_tokens(target)
    if not need:
        return True
    for cand in candidates:
        have = title_tokens(cand)
        if have and all(any(_token_match(n, h) for h in have) for n in need):
            return True
    return False


LOCATION_STOP = {"usa", "us", "u", "s", "united", "states", "metro", "area", "greater", "the", "city", "remote", "hybrid"}


def location_words(text: str) -> list[str]:
    low = (text or "").lower().replace("d.c.", "dc")
    return [w for w in re.findall(r"[a-z0-9]+", low) if w not in LOCATION_STOP]


def mentions_location(words: Iterable[str], texts: Iterable[str]) -> bool:
    """True when every word (or the state it abbreviates) appears in the texts."""
    hay = re.sub(r"[^a-z0-9 ]+", " ", " ".join(t for t in texts if t).lower())
    for w in words:
        alternatives = {w, STATE_NAMES.get(w, w)}
        if not any(re.search(rf"\b{re.escape(a)}\b", hay) for a in alternatives):
            return False
    return True


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def _location_texts(v5: dict) -> list[str]:
    texts = [v5.get("formatted_workplace_location") or ""]
    for key in ("workplace_cities", "workplace_counties", "workplace_states"):
        texts.extend(str(x) for x in (v5.get(key) or []))
    return texts


def matches_location(hit: dict, spec: LocationSpec) -> bool:
    v5 = hit.get("v5_processed_job_data") or {}
    if spec.kind == "anywhere":
        return True
    workplace = (v5.get("workplace_type") or "").lower()
    countries = {str(c).upper() for c in (v5.get("workplace_countries") or [])}
    boundless = {str(c).upper() for c in (v5.get("boundless_workplace_countries") or [])}
    if spec.kind == "remote":
        us_ok = "US" in countries or "US" in boundless or bool(v5.get("is_workplace_worldwide_ok"))
        return workplace == "remote" and us_ok
    if spec.kind == "metro":
        # Every live hit so far carried a list of {lat, lon} points, but the
        # index is Algolia-shaped and Algolia also allows a single object, so
        # accept either rather than let one odd hit raise out of the loop.
        points = hit.get("_geoloc") or []
        if isinstance(points, dict):
            points = [points]
        for point in points:
            if not isinstance(point, dict):
                continue
            lat, lon = point.get("lat"), point.get("lon")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                continue
            if haversine_miles(spec.lat, spec.lon, lat, lon) <= CITY_RADIUS_MILES * RADIUS_SLACK:
                return True
        # No point in range (nationwide listings carry no coordinates, and a
        # multi-city listing may carry a point for only one of its cities):
        # fall back to the text the site shows, which names every city.
        return mentions_location(location_words(f"{spec.city} {spec.state}"), _location_texts(v5))
    return mentions_location(location_words(spec.label), _location_texts(v5))


def _now() -> datetime:
    """Current UTC time; a seam so tests can pin the clock to a fixture's capture day."""
    return datetime.now(timezone.utc)


def posted_days_ago(hit: dict, now: datetime) -> int | None:
    """Whole days since the hit's estimated_publish_date, or None when it has none.

    The ISO string is on every hit seen so far; the _millis twin is tried
    second because trimmed fixtures and older hits lack it.
    """
    v5 = hit.get("v5_processed_job_data") or {}
    published: datetime | None = None
    raw = v5.get("estimated_publish_date")
    if isinstance(raw, str) and raw.strip():
        try:
            published = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
        except ValueError:
            published = None
    if published is None:
        millis = v5.get("estimated_publish_date_millis")
        if isinstance(millis, (int, float)) and millis > 0:
            published = datetime.fromtimestamp(millis / 1000, tz=timezone.utc)
    if published is None:
        return None
    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    return max(0, (now - published).days)


# ---------------------------------------------------------------------------
# Hit -> JobListing
# ---------------------------------------------------------------------------

COUNTRY_SUFFIX_RE = re.compile(r",\s*united states$", re.I)


def format_location(v5: dict) -> str:
    formatted = (v5.get("formatted_workplace_location") or "").strip()
    if not formatted:
        formatted = ", ".join(str(c) for c in (v5.get("workplace_cities") or []))
    formatted = COUNTRY_SUFFIX_RE.sub("", formatted)
    if (v5.get("workplace_type") or "").lower() == "remote":
        return f"Remote ({formatted})" if formatted else "Remote (United States)"
    return formatted


def format_salary(v5: dict) -> str:
    lo, hi = v5.get("yearly_min_compensation"), v5.get("yearly_max_compensation")
    if lo is None and hi is None:
        # The site converts hourly pay to yearly itself; this only runs when
        # it did not, using the standard 2,080 hour year.
        h_lo, h_hi = v5.get("hourly_min_compensation"), v5.get("hourly_max_compensation")
        lo = h_lo * 2080 if isinstance(h_lo, (int, float)) else None
        hi = h_hi * 2080 if isinstance(h_hi, (int, float)) else None
    if lo is None and hi is None:
        return ""
    currency = v5.get("listed_compensation_currency") or "USD"
    return numeric_salary_range(round(lo) if lo else 0, round(hi) if hi else 0, currency)


def build_description(v5: dict) -> str:
    """A compact JD from the structured fields; the site ships no full text on cards."""
    parts = []
    head = v5.get("core_job_title") or ""
    extras = [x for x in (v5.get("seniority_level"), ", ".join(v5.get("commitment") or [])) if x]
    if head or extras:
        parts.append(f"{head} ({'; '.join(extras)})" if extras else head)
    workplace = ", ".join(x for x in (v5.get("workplace_type"), v5.get("formatted_workplace_location")) if x)
    if workplace:
        parts.append(f"Workplace: {workplace}")
    if v5.get("job_category"):
        parts.append(f"Category: {v5['job_category']}")
    if v5.get("requirements_summary"):
        parts.append(f"Requirements: {v5['requirements_summary']}")
    yoe = v5.get("min_industry_and_role_yoe")
    if isinstance(yoe, (int, float)):
        parts.append(f"Minimum experience: {yoe:g} years")
    if v5.get("role_activities"):
        parts.append("Responsibilities: " + "; ".join(str(x) for x in v5["role_activities"]))
    if v5.get("technical_tools"):
        parts.append("Tools: " + ", ".join(str(x) for x in v5["technical_tools"]))
    if v5.get("licenses_or_certifications"):
        parts.append("Certifications: " + ", ".join(str(x) for x in v5["licenses_or_certifications"]))
    return "\n".join(parts)[:MAX_DESCRIPTION]


def hit_to_job(hit: dict) -> JobListing | None:
    info = hit.get("job_information") or {}
    v5 = hit.get("v5_processed_job_data") or {}
    title = (info.get("title") or info.get("job_title_raw") or "").strip()
    company = (v5.get("company_name") or "").strip()
    apply_url = (hit.get("apply_url") or "").strip()
    if not title or not company or not apply_url or hit.get("is_expired"):
        return None
    yoe = v5.get("min_industry_and_role_yoe")
    job = JobListing(
        source="HiringCafe",
        title=title,
        company=company,
        location=format_location(v5),
        is_remote=(v5.get("workplace_type") or "").lower() == "remote",
        description=build_description(v5),
        years_experience=int(round(yoe)) if isinstance(yoe, (int, float)) else None,
        salary_range=format_salary(v5),
        apply_url=apply_url,
        listing_url=apply_url,
    )
    job.generate_id()
    return job


# ---------------------------------------------------------------------------
# Scrape
# ---------------------------------------------------------------------------

async def _get(client: httpx.AsyncClient, url: str) -> httpx.Response:
    """One GET; a seam so tests can feed saved pages through the real loop."""
    return await client.get(url)


def unique_specs(locations: Iterable[str]) -> list[LocationSpec]:
    specs: list[LocationSpec] = []
    seen: set[tuple] = set()
    for loc in locations:
        spec = location_spec(loc)
        key = (spec.kind, spec.city, spec.state, spec.label.lower() if spec.kind == "text" else "")
        if key in seen:
            continue
        seen.add(key)
        specs.append(spec)
    return specs or [LocationSpec("anywhere", "")]


async def scrape(titles: list[str], locations: list[str], limit: int = 20) -> list[JobListing]:
    started = time.monotonic()
    specs = unique_specs(locations)
    pairs = [(title, spec) for title in titles if (title or "").strip() for spec in specs]
    if len(pairs) > MAX_SEARCHES:
        logger.info(f"HiringCafe: truncating {len(pairs)} title x location searches to {MAX_SEARCHES}")
        pairs = pairs[:MAX_SEARCHES]
    logger.info(f"HiringCafe: {len(titles)} titles x {len(specs)} locations, running {len(pairs)} searches")

    now = _now()
    jobs: list[JobListing] = []
    seen: set[str] = set()

    async with httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS, follow_redirects=True) as client:
        for i, (title, spec) in enumerate(pairs, 1):
            if len(jobs) >= limit:
                break
            url = search_url(search_state(title, spec))
            logger.debug(f"  HiringCafe search {i}: '{title}' in '{spec.label or 'anywhere'}' ({spec.kind})")

            hits: list[dict] | None = None
            challenged = False
            # One retry: a challenge or a dropped connection is sometimes a
            # single bad request rather than a blocked session.
            for attempt in range(2):
                try:
                    resp = await _get(client, url)
                except httpx.HTTPError as e:
                    # The URL (and so the user's title) is part of the message.
                    logger.warning(f"  HiringCafe search {i}: request failed ({type(e).__name__})")
                    logger.debug(f"  HiringCafe search {i}: {e}")
                    await asyncio.sleep(2)
                    continue
                if looks_like_challenge(resp.text, resp.headers):
                    challenged = True
                    await asyncio.sleep(5)
                    continue
                if resp.status_code != 200:
                    logger.warning(f"  HiringCafe search {i}: HTTP {resp.status_code}")
                    break
                try:
                    hits = parse_search_page(resp.text)
                    challenged = False
                except ChallengePage:
                    challenged = True
                    await asyncio.sleep(5)
                    continue
                except (ValueError, json.JSONDecodeError) as e:
                    logger.warning(f"  HiringCafe search {i}: could not read results ({e})")
                break

            if challenged:
                logger.warning(
                    "HiringCafe: Cloudflare challenge page returned twice; stopping this source "
                    "so the feed gets nothing rather than junk"
                )
                break
            if hits is None:
                await asyncio.sleep(random.uniform(0.5, 1.5))
                continue

            fresh = matched = new = 0
            for hit in hits:
                if len(jobs) >= limit:
                    break
                # Age first: the server ignores the date window we send, and a
                # hit without a date is kept rather than guessed at.
                days = posted_days_ago(hit, now)
                if days is not None and days > DAYS_BACK:
                    continue
                fresh += 1
                info = hit.get("job_information") or {}
                v5 = hit.get("v5_processed_job_data") or {}
                if not matches_title(title, info.get("title") or "", v5.get("core_job_title") or ""):
                    continue
                if not matches_location(hit, spec):
                    continue
                matched += 1
                job = hit_to_job(hit)
                if job is None:
                    continue
                key = job.apply_url.lower()
                if key in seen or job.id in seen:
                    continue
                seen.add(key)
                seen.add(job.id)
                jobs.append(job)
                new += 1
            logger.info(
                f"  HiringCafe search {i}/{len(pairs)}: {len(hits)} hits, {fresh} within {DAYS_BACK} days, "
                f"{matched} on target, {new} new"
            )
            await asyncio.sleep(random.uniform(0.5, 1.5))

    logger.info(f"HiringCafe done: {len(jobs)} jobs in {time.monotonic() - started:.1f}s")
    return jobs
