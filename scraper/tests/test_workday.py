"""Unit tests for scrapers/workday.py.

Fixtures are trimmed from real cxs responses captured on 2026-10-20 from
mastercard/wd1/CorporateCareers and crowdstrike/wd5/crowdstrikecareers. The
network is replaced with httpx.MockTransport, so these run offline.

Run from the scraper directory:  python -m pytest tests/test_workday.py -q
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import TargetCompany  # noqa: E402
from scrapers import workday  # noqa: E402
from scrapers.ats_common import Deadline  # noqa: E402


# ── fixtures ──────────────────────────────────────────────────────────────────

MC = "mastercard/wd1/CorporateCareers"
CS = "crowdstrike/wd5/crowdstrikecareers"

MC_SEARCH = {
    "total": 6,
    "jobPostings": [
        {
            # Title shares no word with the queries: dropped before any detail call.
            "title": "Manager, Technology Control Testing, Services Technology Risk",
            "externalPath": "/job/New-York-City-New-York/Manager--Technology-Control-Testing--Services-Technology-Risk_R-294203",
            "locationsText": "New York City, New York",
            "postedOn": "Posted Today",
            "bulletFields": ["R-294203"],
        },
        {
            # "N Locations": needs the detail call to learn the cities.
            "title": "Associate Analyst, Business Operations",
            "externalPath": "/job/Purchase-New-York/Associate-Analyst--Business-Operations_R-294062-1",
            "locationsText": "2 Locations",
            "postedOn": "Posted Today",
            "bulletFields": ["R-294062-1"],
        },
        {
            "title": "Senior Analyst, Marketing",
            "externalPath": "/job/Purchase-New-York/Senior-Analyst--Marketing_R-293555-1",
            "locationsText": "Purchase, New York",
            "postedOn": "Posted Today",
            "bulletFields": ["R-293555-1"],
        },
        {
            # Right role word, wrong city: dropped before the detail call.
            "title": "Creative Strategy Analyst",
            "externalPath": "/job/Dubai-United-Arab-Emirates/Creative-Strategy-Analyst_R-293100",
            "locationsText": "Dubai, United Arab Emirates",
            "postedOn": "Posted 3 Days Ago",
            "bulletFields": ["R-293100"],
        },
        {
            "title": "Manager, Product Management – Operational Reports",
            "externalPath": "/job/OFallon-Missouri/Manager--Product-Management---Operational-Reports_R-294024",
            "locationsText": "O'Fallon, Missouri",
            "postedOn": "Posted Today",
            "bulletFields": ["R-294024"],
        },
        {
            # Multi-location whose detail reveals no New York office: dropped after details.
            "title": "Security Analyst, Services Technology Risk",
            "externalPath": "/job/Boston-Massachusetts/Security-Analyst--Services-Technology-Risk_R-290001",
            "locationsText": "6 Locations",
            "postedOn": "Posted 7 Days Ago",
            "bulletFields": ["R-290001"],
        },
    ],
    "facets": [],
    "userAuthenticated": False,
}

MC_DETAILS = {
    "/job/Purchase-New-York/Associate-Analyst--Business-Operations_R-294062-1": {
        "jobPostingInfo": {
            "id": "ac29f63d355c10010aec7e36c4830000",
            "title": "Associate Analyst, Business Operations",
            "jobDescription": (
                "<p><span><b>Our Purpose</b></span></p><p></p><p><i>Mastercard powers economies and "
                "empowers people in 200&#43; countries.</i></p><p><b>Title and Summary</b></p>"
                "<p>Associate Analyst, Business Operations</p><ul><li>Build reports in Excel and SQL</li>"
                "<li>Support the service desk intake process</li></ul>"
                "<p>Pay Ranges: Purchase, New York: $63,000 - $101,000 USD</p>"
            ),
            "location": "Purchase, New York",
            "additionalLocations": ["Boston, Massachusetts"],
            "postedOn": "Posted Today",
            "startDate": "2026-10-20",
            "timeType": "Full time",
            "jobReqId": "R-294062-1",
            "jobPostingId": "Associate-Analyst--Business-Operations_R-294062-1",
            "jobPostingSiteId": "CorporateCareers",
            "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09"},
            "canApply": True,
            "posted": True,
            "includeResumeParsing": True,
            "jobRequisitionLocation": {
                "descriptor": "Purchase, New York",
                "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09", "alpha2Code": "US"},
            },
            "externalUrl": "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Purchase-New-York/Associate-Analyst--Business-Operations_R-294062-1",
        },
        "hiringOrganization": {"name": "US: Mastercard International Incor", "url": ""},
        "similarJobs": [],
        "userAuthenticated": False,
    },
    "/job/Purchase-New-York/Senior-Analyst--Marketing_R-293555-1": {
        "jobPostingInfo": {
            "id": "ac29f63d355c10010aec7e36c4830001",
            "title": "Senior Analyst, Marketing",
            "jobDescription": "<p>Marketing analytics role.</p><p>Pay Ranges: $106,000 - $175,000 USD</p>",
            "location": "Purchase, New York",
            "postedOn": "Posted Today",
            "startDate": "2026-10-20",
            "timeType": "Full time",
            "jobReqId": "R-293555-1",
            "jobPostingId": "Senior-Analyst--Marketing_R-293555-1",
            "jobPostingSiteId": "CorporateCareers",
            "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09"},
            "canApply": True,
            "posted": True,
            "jobRequisitionLocation": {
                "descriptor": "Purchase, New York",
                "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09", "alpha2Code": "US"},
            },
            # No externalUrl on purpose: exercises the constructed fallback URL.
        },
        "hiringOrganization": {"name": "US: Mastercard International Incor", "url": ""},
        "similarJobs": [],
        "userAuthenticated": False,
    },
    "/job/Boston-Massachusetts/Security-Analyst--Services-Technology-Risk_R-290001": {
        "jobPostingInfo": {
            "id": "ac29f63d355c10010aec7e36c4830002",
            "title": "Security Analyst, Services Technology Risk",
            "jobDescription": "<p>SOC monitoring and control testing.</p>",
            "location": "Boston, Massachusetts",
            "additionalLocations": [
                "Atlanta, Georgia (675 Ponce De Leon Ave NE)",
                "Chicago, Illinois",
                "Arlington, Virginia",
                "Seattle, Washington",
                "O'Fallon, Missouri",
            ],
            "postedOn": "Posted 7 Days Ago",
            "timeType": "Full time",
            "jobReqId": "R-290001",
            "jobPostingSiteId": "CorporateCareers",
            "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09"},
            "jobRequisitionLocation": {
                "descriptor": "Boston, Massachusetts",
                "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09", "alpha2Code": "US"},
            },
            "externalUrl": "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Boston-Massachusetts/Security-Analyst--Services-Technology-Risk_R-290001",
        },
        "hiringOrganization": {"name": "US: Mastercard International Incor", "url": ""},
        "similarJobs": [],
        "userAuthenticated": False,
    },
}

CS_SEARCH = {
    "total": 4,
    "jobPostings": [
        {
            # Remote, but in the UK: a "Remote" target must not pick it up.
            "title": "Sr. Analyst, Falcon Complete (Remote, GBR)",
            "externalPath": "/job/United-Kingdom---Remote/Sr-Analyst--Falcon-Complete--Remote--GBR-_R30342",
            "locationsText": "United Kingdom - Remote",
            "postedOn": "Posted 2 Days Ago",
            "bulletFields": ["R30342"],
        },
        {
            "title": "Analyst I, Falcon Complete (Remote, PST/MST)",
            "externalPath": "/job/USA---Remote/Associate-Analyst--Falcon-Complete_R30082",
            "locationsText": "USA - Remote",
            "postedOn": "Posted 10 Days Ago",
            "bulletFields": ["R30082"],
        },
        {
            "title": "Associate Analyst, Falcon Complete (Remote)",
            "externalPath": "/job/Japan---Remote-Tokyo/Associate-Analyst--Falcon-Complete------Remote-_R30389",
            "locationsText": "Japan - Remote, Tokyo",
            "postedOn": "Posted Yesterday",
            "bulletFields": ["R30389"],
        },
        {
            # Bare "Remote" passes the pre-filter; the detail payload says Japan.
            "title": "Associate Analyst, Falcon Complete (Remote, Japanese Speaking)",
            "externalPath": "/job/Remote/Associate-Analyst--Falcon-Complete--Japanese-Speaking-_R30052",
            "locationsText": "Remote",
            "postedOn": "Posted Yesterday",
            "bulletFields": ["R30052"],
        },
    ],
    "facets": [],
    "userAuthenticated": False,
}

CS_DETAILS = {
    "/job/USA---Remote/Associate-Analyst--Falcon-Complete_R30082": {
        "jobPostingInfo": {
            "id": "f1",
            "title": "Analyst I, Falcon Complete (Remote, PST/MST)",
            "jobDescription": (
                "<p>As a global leader in cybersecurity, CrowdStrike protects the people, processes and "
                "technologies that drive modern organizations.</p><p><b>About the Role:</b></p>"
                "<p>Falcon Complete is our managed detection and response (MDR) team.</p>"
                "<p>CrowdStrike, Inc. is committed to equal pay for equal work. The base salary range for "
                "this position in the U.S. is $85,000 - $120,000 per year.</p>"
            ),
            "location": "USA - Remote",
            "postedOn": "Posted 10 Days Ago",
            "timeType": "Full time",
            "jobReqId": "R30082",
            "jobPostingSiteId": "crowdstrikecareers",
            "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09"},
            "jobRequisitionLocation": {
                "descriptor": "USA - Remote",
                "country": {"descriptor": "United States of America", "id": "bc33aa3152ec42d4995f4791a106ed09", "alpha2Code": "US"},
            },
            "externalUrl": "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/USA---Remote/Associate-Analyst--Falcon-Complete_R30082",
        },
        "hiringOrganization": {"name": "CrowdStrike, Inc.", "url": ""},
        "similarJobs": [],
        "userAuthenticated": False,
    },
    "/job/Remote/Associate-Analyst--Falcon-Complete--Japanese-Speaking-_R30052": {
        "jobPostingInfo": {
            "id": "f2",
            "title": "Associate Analyst, Falcon Complete (Remote, Japanese Speaking)",
            "jobDescription": "<p>Japanese speaking MDR analyst.</p>",
            "location": "Remote",
            "postedOn": "Posted Yesterday",
            "timeType": "Full time",
            "jobReqId": "R30052",
            "jobPostingSiteId": "crowdstrikecareers",
            "country": {"descriptor": "Japan", "id": "jp"},
            "jobRequisitionLocation": {
                "descriptor": "Remote",
                "country": {"descriptor": "Japan", "id": "jp", "alpha2Code": "JP"},
            },
            "externalUrl": "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers/job/Remote/Associate-Analyst--Falcon-Complete--Japanese-Speaking-_R30052",
        },
        "hiringOrganization": {"name": "CrowdStrike, Inc.", "url": ""},
        "similarJobs": [],
        "userAuthenticated": False,
    },
}

TITLES = ["Security Analyst", "Junior SOC Analyst", "Data Analyst", "Security Analyst"]
LOCATIONS = ["New York", "Remote"]


class Recorder:
    """MockTransport handler that serves the fixtures and records every request."""

    def __init__(self, fail_first_search_with: int | None = None, always: int | None = None):
        self.requests: list[httpx.Request] = []
        self.searches: list[tuple[str, str, int]] = []  # (tenant, searchText, offset)
        self.details: list[str] = []
        self.fail_first_search_with = fail_first_search_with
        self.always = always
        self._failed_once = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.always is not None:
            return httpx.Response(self.always, json={"errorCode": f"HTTP_{self.always}"})
        host = request.url.host
        tenant = host.split(".")[0]
        path = request.url.path
        prefix = f"/wday/cxs/{tenant}/"
        assert path.startswith(prefix), path
        rest = path[len(prefix):]
        site, _, tail = rest.partition("/")
        search, details = (MC_SEARCH, MC_DETAILS) if tenant == "mastercard" else (CS_SEARCH, CS_DETAILS)

        if request.method == "POST" and tail == "jobs":
            body = json.loads(request.content)
            self.searches.append((tenant, body["searchText"], body["offset"]))
            assert body["limit"] == 20 and body["appliedFacets"] == {}
            if self.fail_first_search_with and not self._failed_once:
                self._failed_once = True
                return httpx.Response(self.fail_first_search_with, headers={"retry-after": "0"}, json={})
            if body["offset"] > 0:
                return httpx.Response(200, json={"total": 0, "jobPostings": []})
            return httpx.Response(200, json=search)

        if request.method == "GET":
            external_path = "/" + tail
            self.details.append(external_path)
            payload = details.get(external_path)
            if payload is None:
                return httpx.Response(404, json={"errorCode": "S21", "message": "not found: Job_Posting_Anchor_ID"})
            return httpx.Response(200, json=payload)

        return httpx.Response(500, json={})


def run_scrape(handler, companies, titles=TITLES, locations=LOCATIONS, limit=20, budget=30.0):
    async def _go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await workday.scrape(
                titles=titles, locations=locations, limit=limit, companies=companies,
                budget_seconds=budget, client=client,
            )
    return asyncio.run(_go())


@pytest.fixture(autouse=True)
def no_pacing(monkeypatch):
    monkeypatch.setattr(workday, "PACE_SECONDS", 0)


def companies(*slugs):
    names = {MC: "Mastercard", CS: "CrowdStrike"}
    return [TargetCompany(ats_type="workday", slug=s, name=names.get(s, "")) for s in slugs]


# ── pure helpers ──────────────────────────────────────────────────────────────

def test_parse_slug_contract_form():
    assert workday.parse_slug("barclays/wd3/External_Career_Site_Barclays") == (
        "barclays", "wd3", "External_Career_Site_Barclays"
    )


def test_parse_slug_accepts_pasted_url_and_drops_locale():
    url = "https://barclays.wd3.myworkdayjobs.com/en-US/External_Career_Site_Barclays/job/London/Analyst_JR-1"
    assert workday.parse_slug(url) == ("barclays", "wd3", "External_Career_Site_Barclays")
    assert workday.parse_slug("nasdaq.wd1.myworkdayjobs.com/Global_External_Site") == (
        "nasdaq", "wd1", "Global_External_Site"
    )


@pytest.mark.parametrize("bad", ["barclays", "barclays/External", "barclays/wdx/External", "", "a/b/c/d"])
def test_parse_slug_rejects_garbage(bad):
    with pytest.raises(ValueError):
        workday.parse_slug(bad)


def test_build_queries_strips_seniority_dedupes_and_caps():
    titles = [
        "Junior SOC Analyst", "SOC Analyst", "Senior Security Analyst", "Security Analyst I",
        "Help Desk Technician", "Desktop Support Technician", "Entry Level Data Analyst",
    ]
    assert workday.build_queries(titles, max_queries=4) == [
        "soc analyst", "security analyst", "help desk technician", "desktop support technician",
    ]
    assert workday.build_queries(["Senior", "", "  "]) == []


def test_title_gate_requires_shared_word_and_role_family():
    queries = ["help desk technician", "data analyst"]
    titles = ["Help Desk Technician", "Data Analyst"]
    assert workday.title_matches_queries("Desktop Support Technician II", queries, titles)
    assert workday.title_matches_queries("Business Intelligence Analyst", queries, titles)
    assert not workday.title_matches_queries("Manager, Product Management", queries, titles)
    # Shares "analyst" with a query but belongs to a different role family than the targets.
    assert not workday.title_matches_queries("Marketing Analyst Manager", ["security analyst"], ["Security Engineer"])
    # A grade word alone ("specialist") is not a match; a role word ("support") is.
    assert not workday.title_matches_queries(
        "Specialist, Product Management, Data Provider Solutions", ["it support specialist"], ["IT Support Specialist"]
    )
    assert workday.title_matches_queries("Technical Support Specialist", ["it support specialist"], ["IT Support Specialist"])
    assert workday.title_matches_queries("Service Desk Analyst I", ["it help desk", "soc analyst"], ["IT Help Desk", "Jr. SOC Analyst"])


def test_build_queries_default_cap_covers_a_per_scholas_profile():
    # The real cyber profile seen in prod on 2026-10-20: security titles sit 5th and 6th.
    titles = [
        "IT Support Specialist", "IT Help Desk", "IT Systems Analyst", "Desktop Support Technician",
        "Jr. Cybersecurity Analyst", "Jr. SOC Analyst", "ATS Systems Administrator",
    ]
    queries = workday.build_queries(titles)
    assert "cybersecurity analyst" in queries and "soc analyst" in queries
    assert len(queries) == 6


@pytest.mark.parametrize(
    "location,expected",
    [
        ("USA - Remote", True),
        ("Remote", True),
        ("Remote, NY", True),
        ("USA - Remote; Canada - Remote ON", True),
        ("United Kingdom - Remote", False),
        ("Japan - Remote, Tokyo", False),
        ("Canada - Remote ON", False),
        ("Remote (Japan)", False),
    ],
)
def test_remote_counts_for_target(location, expected):
    assert workday.remote_counts_for_target(location) is expected


def test_location_ok_drops_literal_remote_substring_outside_us():
    assert not workday.location_ok("United Kingdom - Remote", ["New York", "Remote"], True)
    assert workday.location_ok("USA - Remote", ["New York", "Remote"], True)
    assert workday.location_ok("Purchase, New York", ["New York"], False)
    assert not workday.location_ok("Dubai, United Arab Emirates", ["New York", "Remote"], False)


@pytest.mark.parametrize(
    "location,tenant,tagged",
    [
        # Real locationsText values from the 2026-10-21 survey of every tracked site.
        ("NYC - 1211 Ave of the Americas", "dowjones", True),
        ("NYC Global HQ", "doubleverify", True),
        ("New York, 745 7th Avenue", "barclays", True),
        ("Brooklyn, New York", "etsy", True),
        ("NYP/Weill Cornell Medical Center", "nyp", True),
        ("Ambulatory NYP/CU", "nyp", True),
        ("NYP/Hudson Valley", "nyp", False),
        ("NYP/Westchester", "nyp", False),
        ("111 East 210th Street", "montefiore", True),
        ("1825 Eastchester Road", "montefiore", True),
        ("555 Taxter Road", "montefiore", False),
        ("A - 66 West 12th Street", "newschool", True),
        ("New York, NY", "msk", False),  # already says it
        ("Purchase, New York", "mastercard", False),  # New York State, not the city
        ("2 Locations", "nyp", False),
        ("London, 1 Churchill Place", "barclays", False),
    ],
)
def test_tag_nyc(location, tenant, tagged):
    out = workday.tag_nyc(location, tenant)
    assert (out == f"{location} ({workday.NYC_TAG})") is tagged
    if not tagged:
        assert out == location


def test_nyc_tag_lets_a_new_york_target_match_campus_names():
    loc = workday.tag_nyc("NYP/Columbia University Irving Medical Center", "nyp")
    assert workday.location_ok(loc, ["New York"], False)
    assert workday.location_ok(loc, ["New York, NY"], False)
    assert not workday.location_ok("NYP/Columbia University Irving Medical Center", ["New York"], False)


def test_deadline_counts_down_and_clamps():
    d = Deadline(0)
    assert d.expired() and d.remaining() == 0.0 and d.clamp(15.0) == 0.1
    d = Deadline(60)
    assert not d.expired() and 59 < d.remaining() <= 60 and d.clamp(15.0) == 15.0


# ── end to end against fixtures ───────────────────────────────────────────────

def test_scrape_parses_filters_and_fetches_details_once():
    rec = Recorder()
    jobs = run_scrape(rec, companies(MC, CS))

    by_title = {j.title: j for j in jobs}
    assert set(by_title) == {
        "Associate Analyst, Business Operations",
        "Senior Analyst, Marketing",
        "Analyst I, Falcon Complete (Remote, PST/MST)",
    }

    multi = by_title["Associate Analyst, Business Operations"]
    assert multi.location == "Purchase, New York; Boston, Massachusetts"
    assert multi.company == "Mastercard"
    assert multi.source == "Workday"
    assert multi.salary_range == "$63,000 - $101,000"
    assert "Build reports in Excel and SQL" in multi.description and "<" not in multi.description
    assert multi.apply_url.endswith("/job/Purchase-New-York/Associate-Analyst--Business-Operations_R-294062-1")
    assert multi.is_remote is False
    assert multi.id

    # No externalUrl in that detail payload: the public URL is rebuilt from the slug.
    marketing = by_title["Senior Analyst, Marketing"]
    assert marketing.apply_url == (
        "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers"
        "/job/Purchase-New-York/Senior-Analyst--Marketing_R-293555-1"
    )
    assert marketing.salary_range == "$106,000 - $175,000"

    remote = by_title["Analyst I, Falcon Complete (Remote, PST/MST)"]
    assert remote.is_remote is True
    assert remote.location == "USA - Remote"
    assert remote.salary_range == "$85,000 - $120,000"

    # Three distinct queries ("Security Analyst" twice collapses; "Junior" is stripped).
    assert sorted({q for _, q, _ in rec.searches}) == ["data analyst", "security analyst", "soc analyst"]
    assert all(off == 0 for _, _, off in rec.searches)
    assert sum(1 for t, _, _ in rec.searches if t == "mastercard") == 3
    assert sum(1 for t, _, _ in rec.searches if t == "crowdstrike") == 3

    # Details fetched exactly once per surviving candidate, none for postings
    # the title or location pre-filter dropped (Dubai, Missouri, UK, Japan).
    assert sorted(rec.details) == sorted([
        "/job/Purchase-New-York/Associate-Analyst--Business-Operations_R-294062-1",
        "/job/Purchase-New-York/Senior-Analyst--Marketing_R-293555-1",
        "/job/Boston-Massachusetts/Security-Analyst--Services-Technology-Risk_R-290001",
        "/job/USA---Remote/Associate-Analyst--Falcon-Complete_R30082",
        "/job/Remote/Associate-Analyst--Falcon-Complete--Japanese-Speaking-_R30052",
    ])
    assert len(rec.requests) == 6 + 5


def test_scrape_ignores_non_workday_companies_and_bad_slugs():
    rec = Recorder()
    cos = companies(MC) + [
        TargetCompany(ats_type="greenhouse", slug="stripe", name="Stripe"),
        TargetCompany(ats_type="workday", slug="not-a-workday-slug", name="Broken"),
    ]
    jobs = run_scrape(rec, cos)
    assert {j.company for j in jobs} == {"Mastercard"}
    assert {t for t, _, _ in rec.searches} == {"mastercard"}


def test_scrape_searches_a_site_once_when_rows_repeat():
    # scrape.ts sends every active row and vertical packs copy global rows into
    # each subscriber's own, so one career site can arrive several times.
    once, twice = Recorder(), Recorder()
    run_scrape(once, companies(MC))
    run_scrape(twice, companies(MC) + companies(MC) + [
        TargetCompany(ats_type="workday", slug="Mastercard/wd1/corporatecareers", name="Mastercard"),
    ])
    assert len(twice.searches) == len(once.searches) > 0


def test_scrape_respects_limit():
    rec = Recorder()
    jobs = run_scrape(rec, companies(MC, CS), limit=1)
    assert len(jobs) == 1


def test_one_429_is_retried_then_succeeds():
    rec = Recorder(fail_first_search_with=429)
    jobs = run_scrape(rec, companies(MC))
    assert {j.title for j in jobs} == {"Associate Analyst, Business Operations", "Senior Analyst, Marketing"}
    # 3 queries + 1 retry of the first + 3 details
    assert len(rec.requests) == 3 + 1 + 3


def test_persistent_429_skips_tenant_quietly():
    rec = Recorder(always=429)
    jobs = run_scrape(rec, companies(MC))
    assert jobs == []
    assert len(rec.requests) == 2  # one attempt, one retry, then the tenant is skipped


def test_404_site_is_skipped_quietly():
    rec = Recorder(always=404)
    jobs = run_scrape(rec, companies(MC))
    assert jobs == []
    assert len(rec.requests) == 1


def test_expired_budget_returns_without_requests():
    rec = Recorder()
    jobs = run_scrape(rec, companies(MC, CS), budget=0)
    assert jobs == []
    assert rec.requests == []


def test_no_tracked_companies_or_titles_is_a_noop():
    rec = Recorder()
    assert run_scrape(rec, []) == []
    assert run_scrape(rec, companies(MC), titles=["Senior"]) == []
    assert rec.requests == []
