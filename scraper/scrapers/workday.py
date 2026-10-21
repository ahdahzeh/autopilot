"""Workday public career-site scraper.

Every public Workday career site (https://<tenant>.<wdN>.myworkdayjobs.com/<site>)
fronts the unauthenticated JSON API its own front end uses:

  POST .../wday/cxs/<tenant>/<site>/jobs
       {"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": "..."}
       -> {"total": N, "jobPostings": [{title, externalPath, locationsText,
                                        postedOn, bulletFields}]}
  GET  .../wday/cxs/<tenant>/<site><externalPath>
       -> {"jobPostingInfo": {title, location, additionalLocations,
                              jobDescription (HTML), externalUrl, jobReqId,
                              timeType, postedOn, startDate, ...}}

Unlike Greenhouse/Lever/Ashby there is no "give me every job" call: Accenture
alone lists 2,000+ postings and the page size is capped at 20 (limit > 20 is a
400), so we search per user title instead. searchText is an AND over every word
of the query, matched against title + description and ranked by relevance, so
the first page is the one worth reading (Mastercard, 2026-10-20: "Security
Analyst" matched all 137 analyst roles because every JD carries a "Corporate
Security Responsibility" paragraph). Descriptions only come back from the
detail call, so details are fetched for the few postings that survive the
title + location pre-filters, round-robin across companies, up to a small cap.

Slug contract (shared with the web app): target_companies.ats_type = 'workday',
slug = '<tenant>/<wdN>/<site>', for example
'barclays/wd3/External_Career_Site_Barclays'. A tenant's robots.txt lists its
site IDs ("Allow: /<site>/"), which is how the seed list was discovered.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
from urllib.parse import urlsplit

import httpx
from loguru import logger

from models import JobListing, TargetCompany
from scorer import is_title_relevant
from scrapers.ats_common import (
    Deadline,
    company_display,
    is_remote_text,
    matches_location,
    parse_salary_from_text,
    strip_html,
)


PAGE_SIZE = 20  # Workday rejects anything larger with HTTP 400
# Searches per company. The Per Scholas profiles carry 6-8 titles with the
# help-desk ones first and the security ones last; at a cap of 4 the first real
# run (2026-10-20) never searched "SOC Analyst" or "Data Analyst" at all.
# Budget check for the ingest runner (SOURCE_TIMEOUT_SECONDS=120, ~45 tenants):
# 45 x 6 searches at ~1.1s each (request plus pacing) over 6 lanes is ~50s,
# which leaves half the budget for the detail pass.
MAX_QUERIES = int(os.getenv("WORKDAY_MAX_QUERIES", "6"))
MAX_PAGES = int(os.getenv("WORKDAY_MAX_PAGES", "1"))  # pages per search
# Tenants fetched at once. Requests within a tenant stay sequential and paced,
# so this only bounds our own egress, never the load on any one tenant.
CONCURRENCY = 6
PACE_SECONDS = 0.3  # gap between consecutive requests to the same tenant
TIMEOUT = httpx.Timeout(15.0, connect=8.0)

# Workday tenants sit behind a WAF that throttles cold API calls. On 2026-10-20
# Accenture's tenant answered 429 to every request carrying our usual
# "autopilot/1.0" User-Agent and let a browser UA through (still with the
# occasional 429), so this scraper presents a browser UA like the Playwright
# sources do, retries one 429 after a pause, and skips the tenant on a repeat.
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# main.py applies DEFAULT_SOURCE_TIMEOUT (SOURCE_TIMEOUT_SECONDS, 60s unless the
# runner raises it) to this source. Stop issuing requests this many seconds
# before it so the partial result set is returned rather than cancelled.
DEADLINE_MARGIN_SECONDS = 8.0

# Postings whose locationsText is "N Locations" need the detail call to learn
# the actual cities.
_MULTI_LOCATION_RE = re.compile(r"^\s*\d+\s+locations?\s*$", re.I)

# Words that carry no role meaning when matching a posting title against the
# user's queries. Seniority words are stripped from queries too: Workday ANDs
# every word, so "Junior SOC Analyst" would only match postings that literally
# say "junior".
_SENIORITY_WORDS = {
    "junior", "jr", "jr.", "senior", "sr", "sr.", "entry", "level", "entry-level",
    "associate", "lead", "staff", "principal", "i", "ii", "iii", "iv", "1", "2", "3",
    "intern", "internship", "mid", "mid-level", "experienced", "early", "career",
}
_STOP_WORDS = {
    "the", "of", "and", "or", "a", "an", "in", "for", "to", "with", "at", "on",
    "it", "is", "&", "-", "/", "it/is",
} | _SENIORITY_WORDS

# Words that name a grade rather than a role, so sharing one with a query proves
# nothing: "IT Support Specialist" would otherwise pull in "Specialist, Product
# Management" (Mastercard, first real run 2026-10-20). Only the title gate
# ignores them; they stay in the search text, where Workday ANDs them in.
_GENERIC_ROLE_WORDS = {
    "specialist", "associate", "coordinator", "representative", "consultant",
    "professional", "officer", "assistant", "generalist",
}


def parse_slug(slug: str) -> tuple[str, str, str]:
    """'<tenant>/<wdN>/<site>' -> (tenant, wdN, site).

    Also accepts a pasted career-site URL such as
    https://barclays.wd3.myworkdayjobs.com/en-US/External_Career_Site_Barclays
    so a slug typed from the browser still works. Raises ValueError otherwise.
    """
    raw = (slug or "").strip()
    if "myworkdayjobs.com" in raw:
        parts = urlsplit(raw if "://" in raw else f"https://{raw}")
        host_bits = parts.hostname.split(".") if parts.hostname else []
        path_bits = [p for p in parts.path.split("/") if p]
        # Drop a leading locale segment like en-US.
        if path_bits and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", path_bits[0]):
            path_bits = path_bits[1:]
        if len(host_bits) >= 4 and path_bits:
            return host_bits[0], host_bits[1], path_bits[0]
        raise ValueError(f"unrecognised Workday URL: {slug!r}")
    bits = [b for b in raw.split("/") if b]
    if len(bits) != 3 or not re.fullmatch(r"wd\d+", bits[1]):
        raise ValueError(f"workday slug must be '<tenant>/<wdN>/<site>', got {slug!r}")
    return bits[0], bits[1], bits[2]


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9+#.]+", (text or "").lower()) if w]


def significant_words(text: str) -> set[str]:
    return {w for w in _words(text) if w not in _STOP_WORDS and len(w) > 1}


def build_queries(titles: list[str], max_queries: int = MAX_QUERIES) -> list[str]:
    """Turn the user's titles into at most max_queries Workday searches.

    Seniority words are dropped (see _SENIORITY_WORDS) and duplicates collapse,
    first occurrence wins, so target_titles (which main.py puts first) take
    priority over expanded variants when the cap bites.
    """
    out: list[str] = []
    seen: set[str] = set()
    for t in titles or []:
        words = [w for w in _words(t) if w not in _SENIORITY_WORDS]
        q = " ".join(words).strip()
        if not q or q in seen:
            continue
        seen.add(q)
        out.append(q)
        if len(out) >= max_queries:
            break
    return out


def title_matches_queries(title: str, queries: list[str], titles: list[str]) -> bool:
    """Cheap relevance gate run before spending a detail request.

    Workday guarantees the query words appear somewhere in the posting, not in
    its title, so require the title to share a meaningful word with one of the
    queries and to pass the shared role-family filter from scorer.py.
    """
    title_words = significant_words(title) - _GENERIC_ROLE_WORDS
    if not title_words:
        return False
    if not any(title_words & (significant_words(q) - _GENERIC_ROLE_WORDS) for q in queries):
        return False
    return is_title_relevant(title, titles)


def _location_known(locations_text: str) -> bool:
    return bool(locations_text) and not _MULTI_LOCATION_RE.match(locations_text)


# Workday tenants are global, and their remote postings name the country:
# "United Kingdom - Remote", "Japan - Remote, Tokyo", "Canada - Remote ON".
# matches_location treats a "Remote" target as "any remote job", which is fine
# for the US-centric Greenhouse/Lever/Ashby boards but shipped UK and Japan
# roles to a New York user on the first real run (2026-10-20). A remote
# posting counts for a remote target only when it names the US, or names no
# country at all.
_US_MARKERS = (
    "usa", "u.s.", "united states", "us -", "us,", "us remote", "remote us",
    "remote - us", "remote (us", "- us", "(us)", "americas", "nationwide",
)
_NON_US_COUNTRIES = (
    "united kingdom", "uk", "gbr", "england", "scotland", "ireland", "canada", "mexico",
    "brazil", "argentina", "colombia", "chile", "costa rica", "peru", "india", "japan",
    "australia", "new zealand", "singapore", "philippines", "malaysia", "indonesia",
    "thailand", "vietnam", "china", "hong kong", "taiwan", "korea", "germany", "france",
    "spain", "portugal", "italy", "netherlands", "belgium", "poland", "romania", "czech",
    "hungary", "bulgaria", "serbia", "ukraine", "austria", "switzerland", "sweden",
    "denmark", "norway", "finland", "israel", "turkey", "egypt", "south africa", "kenya",
    "nigeria", "uae", "dubai", "saudi", "qatar", "emea", "apac", "latam", "europe",
)


def remote_counts_for_target(location: str) -> bool:
    low = f" {(location or '').lower()} "
    if any(m in low for m in _US_MARKERS):
        return True
    # US state abbreviations after a comma ("Remote, NY") or a US city name
    # are common; a bare country name without any of those is the signal.
    if re.search(r",\s*[A-Z]{2}\b", location or ""):
        return True
    return not any(re.search(rf"\b{re.escape(c)}\b", low) for c in _NON_US_COUNTRIES)


def location_ok(location: str, targets: list[str], is_remote: bool) -> bool:
    """matches_location, minus the "Remote" target for remote jobs outside the US.

    The remote target has to be removed rather than just is_remote cleared:
    matches_location also passes on the literal substring "remote", which
    "United Kingdom - Remote" contains.
    """
    if is_remote and not remote_counts_for_target(location):
        targets = [t for t in targets if t.lower().strip() not in ("remote", "anywhere")]
        if not targets:
            return False
        return matches_location(location, targets, False)
    return matches_location(location, targets, is_remote)


def _job_url(tenant: str, wd: str, site: str, external_path: str) -> str:
    return f"https://{tenant}.{wd}.myworkdayjobs.com/{site}{external_path}"


class _Tenant:
    """One company's career site plus the per-tenant pacing/throttle state."""

    def __init__(self, company: TargetCompany):
        self.company = company
        self.tenant, self.wd, self.site = parse_slug(company.slug)
        self.base = f"https://{self.tenant}.{self.wd}.myworkdayjobs.com/wday/cxs/{self.tenant}/{self.site}"
        self.label = f"workday:{company.slug}"
        self.throttled = False
        self.requests = 0

    async def _request(
        self, client: httpx.AsyncClient, deadline: Deadline, method: str, url: str, **kw
    ) -> httpx.Response | None:
        """One paced request with a single 429 retry. None = give up quietly."""
        for attempt in range(2):
            if deadline.expired() or self.throttled:
                return None
            if self.requests:
                await asyncio.sleep(PACE_SECONDS)
            self.requests += 1
            resp = await client.request(method, url, timeout=deadline.clamp(15.0), **kw)
            if resp.status_code != 429:
                return resp
            if attempt == 0:
                retry_after = resp.headers.get("retry-after")
                try:
                    pause = min(float(retry_after), 10.0) if retry_after else 3.0
                except ValueError:
                    pause = 3.0
                if pause >= deadline.remaining():
                    break
                await asyncio.sleep(pause)
        self.throttled = True
        logger.warning(f"{self.label} throttled (429 twice), skipping the rest of this tenant")
        return None

    async def search(
        self, client: httpx.AsyncClient, deadline: Deadline, query: str, offset: int
    ) -> list[dict] | None:
        body = {"appliedFacets": {}, "limit": PAGE_SIZE, "offset": offset, "searchText": query}
        resp = await self._request(client, deadline, "POST", f"{self.base}/jobs", json=body)
        if resp is None:
            return None
        if resp.status_code == 404:
            # Tenant exists but the site ID is wrong, or the tenant is gone.
            logger.warning(f"{self.label} -> 404 (check tenant/wdN/site in the slug)")
            self.throttled = True  # nothing else will work either
            return None
        resp.raise_for_status()
        if "json" not in resp.headers.get("content-type", ""):
            raise ValueError(f"non-JSON response ({resp.headers.get('content-type')})")
        return resp.json().get("jobPostings") or []

    async def detail(self, client: httpx.AsyncClient, deadline: Deadline, external_path: str) -> dict | None:
        resp = await self._request(client, deadline, "GET", f"{self.base}{external_path}")
        if resp is None or resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json().get("jobPostingInfo") or None


def _to_listing(tenant: _Tenant, posting: dict, info: dict | None) -> JobListing:
    info = info or {}
    title = (info.get("title") or posting.get("title") or "").strip()
    primary = (info.get("location") or "").strip() or (posting.get("locationsText") or "").strip()
    extra = [str(x).strip() for x in (info.get("additionalLocations") or []) if str(x).strip()]
    location = "; ".join([primary, *extra]) if extra else primary
    if _MULTI_LOCATION_RE.match(location or ""):
        # Detail call failed or lacked locations: keep the hint rather than drop the job.
        location = posting.get("locationsText") or location
    # Workday location strings often omit the country ("Bogota-Tinkko", "Remote").
    # The detail payload knows it; surface non-US countries so the remote check
    # and the reader both see where the job really is.
    country = (info.get("country") or {}).get("descriptor") or ""
    alpha2 = (((info.get("jobRequisitionLocation") or {}).get("country") or {}).get("alpha2Code") or "").upper()
    if country and alpha2 and alpha2 != "US" and country.lower() not in location.lower():
        location = f"{location} ({country})" if location else country

    description = strip_html(info.get("jobDescription"))
    remote = (
        is_remote_text(location)
        or is_remote_text(title)
        or (info.get("remoteType") or "").lower() == "remote"
        or is_remote_text(description[:500])
    )
    apply_url = (info.get("externalUrl") or "").strip() or _job_url(
        tenant.tenant, tenant.wd, tenant.site, posting.get("externalPath") or ""
    )
    job = JobListing(
        source="Workday",
        title=title,
        company=company_display(tenant.company),
        location=location,
        is_remote=remote,
        description=description,
        salary_range=parse_salary_from_text(description),
        apply_url=apply_url,
        listing_url=apply_url,
    )
    job.generate_id()
    return job


async def _search_company(
    tenant: _Tenant,
    client: httpx.AsyncClient,
    deadline: Deadline,
    queries: list[str],
    titles: list[str],
    locations: list[str],
) -> list[dict]:
    """Run the per-title searches for one tenant and return pre-filtered postings.

    Each returned dict is the raw posting plus "_known" (True when its
    locationsText already satisfied the location filter, False when it needs
    the detail call to decide).
    """
    seen_paths: set[str] = set()
    candidates: list[dict] = []
    for query in queries:
        for page in range(MAX_PAGES):
            if tenant.throttled or deadline.expired():
                return candidates
            postings = await tenant.search(client, deadline, query, page * PAGE_SIZE)
            if postings is None:
                return candidates
            for p in postings:
                path = p.get("externalPath") or ""
                title = (p.get("title") or "").strip()
                if not path or not title or path in seen_paths:
                    continue
                seen_paths.add(path)
                if not title_matches_queries(title, queries, titles):
                    continue
                loc_text = (p.get("locationsText") or "").strip()
                if _location_known(loc_text):
                    if not location_ok(loc_text, locations, is_remote_text(loc_text)):
                        continue
                    p["_known"] = True
                else:
                    p["_known"] = False
                candidates.append(p)
            if len(postings) < PAGE_SIZE:
                break  # last page for this query
    return candidates


async def scrape(
    titles: list[str],
    locations: list[str],
    limit: int = 20,
    companies: list[TargetCompany] | None = None,
    budget_seconds: float | None = None,
    client: httpx.AsyncClient | None = None,
) -> list[JobListing]:
    tenants: list[_Tenant] = []
    for c in companies or []:
        if (c.ats_type or "").lower() != "workday":
            continue
        try:
            tenants.append(_Tenant(c))
        except ValueError as e:
            logger.warning(f"workday: skipping {c.slug!r}: {e}")
    if not tenants:
        logger.info("workday: no tracked companies, skipping")
        return []

    queries = build_queries(titles)
    if not queries:
        logger.info("workday: no usable title queries, skipping")
        return []

    if budget_seconds is None:
        budget_seconds = float(os.getenv("SOURCE_TIMEOUT_SECONDS", "60")) - DEADLINE_MARGIN_SECONDS
    deadline = Deadline(budget_seconds)

    # Shuffle so the same tenants are not starved every day when the deadline
    # cuts a run short. Detail fetches are capped at 2x limit (like the other
    # ATS scrapers' soft cap) and never below one page's worth.
    random.shuffle(tenants)
    detail_cap = max(limit * 2, PAGE_SIZE)
    logger.info(
        f"workday: {len(tenants)} companies x {len(queries)} queries "
        f"(budget {deadline.seconds:.0f}s, detail cap {detail_cap})"
    )

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(
            timeout=TIMEOUT,
            headers={"User-Agent": UA, "Accept": "application/json"},
            follow_redirects=True,
        )
    sem = asyncio.Semaphore(CONCURRENCY)
    try:
        async def _one(t: _Tenant) -> list[dict]:
            async with sem:
                try:
                    return await _search_company(t, client, deadline, queries, titles, locations)
                except Exception as e:
                    logger.warning(f"{t.label} failed: {e}")
                    return []

        async def _details(t: _Tenant, postings: list[dict]) -> list[JobListing]:
            out: list[JobListing] = []
            async with sem:
                for p in postings:
                    if deadline.expired() or t.throttled:
                        break
                    try:
                        info = await t.detail(client, deadline, p["externalPath"])
                    except Exception as e:
                        logger.warning(f"{t.label} detail failed for {p.get('externalPath')}: {e}")
                        info = None
                    if info is None and not p["_known"]:
                        continue  # cannot place a multi-location job without details
                    job = _to_listing(t, p, info)
                    # Re-check with the full location (additionalLocations and the
                    # country the detail payload revealed), not just locationsText.
                    if info is not None and not location_ok(job.location, locations, job.is_remote):
                        continue
                    out.append(job)
            return out

        per_tenant = await asyncio.gather(*[_one(t) for t in tenants])
        total_candidates = sum(len(c) for c in per_tenant)

        # Round-robin across tenants, postings whose location already matched
        # ahead of the "N Locations" unknowns, so one huge tenant cannot eat
        # the whole detail budget.
        queues = [
            (t, sorted(cands, key=lambda p: not p["_known"]))
            for t, cands in zip(tenants, per_tenant)
            if cands
        ]
        chosen: dict[int, list[dict]] = {}  # id(tenant) -> postings to detail
        picked = 0
        while queues and picked < detail_cap:
            next_round: list[tuple[_Tenant, list[dict]]] = []
            for t, q in queues:
                chosen.setdefault(id(t), []).append(q.pop(0))
                picked += 1
                if picked >= detail_cap:
                    break
                if q:
                    next_round.append((t, q))
            queues = next_round
        tenant_by_id = {id(t): t for t in tenants}
        batches = await asyncio.gather(
            *[_details(tenant_by_id[tid], ps) for tid, ps in chosen.items()]
        )
    finally:
        if own_client:
            await client.aclose()

    jobs: list[JobListing] = []
    for b in batches:
        jobs.extend(b)
    throttled = sum(1 for t in tenants if t.throttled)
    requests = sum(t.requests for t in tenants)
    logger.info(
        f"workday: {total_candidates} candidates -> {picked} detailed -> {len(jobs)} jobs "
        f"({requests} requests, {throttled} tenants throttled/404, "
        f"{deadline.remaining():.0f}s budget left)"
    )
    return jobs[:limit]
