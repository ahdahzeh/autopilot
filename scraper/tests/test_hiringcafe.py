"""HiringCafe scraper: field mapping, filtering and log redaction against saved pages.

Fixtures (scraper/tests/fixtures/):
  hiringcafe_classic_search.html  the SSR search page skeleton with four real hits
                                  captured from hiringcafe.com/classic on 2026-10-20
                                  (other users' ids and company enrichment trimmed)
  hiringcafe_challenge.html       the Cloudflare "Performing security verification"
                                  page the site returns to a flagged client
"""

import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

SCRAPER_DIR = Path(__file__).resolve().parents[1]
if str(SCRAPER_DIR) not in sys.path:
    sys.path.insert(0, str(SCRAPER_DIR))

from loguru import logger  # noqa: E402

from scrapers import hiringcafe  # noqa: E402
from scrapers.hiringcafe import (  # noqa: E402
    ChallengePage,
    LocationSpec,
    build_description,
    format_location,
    format_salary,
    hit_to_job,
    location_spec,
    looks_like_challenge,
    matches_location,
    matches_title,
    parse_search_page,
    posted_days_ago,
    search_state,
    search_url,
    title_tokens,
    unique_specs,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SEARCH_HTML = (FIXTURES / "hiringcafe_classic_search.html").read_text()
CHALLENGE_HTML = (FIXTURES / "hiringcafe_challenge.html").read_text()
# The day the search fixture was captured. The scrape loop drops hits older
# than DAYS_BACK, so end-to-end tests pin the clock here or the fixture's four
# hits would start failing a week after capture.
FIXTURE_DAY = datetime(2026, 10, 20, 23, 59, tzinfo=timezone.utc)


@pytest.fixture
def hits():
    return parse_search_page(SEARCH_HTML)


def by_company(hits, name):
    return next(h for h in hits if h["v5_processed_job_data"]["company_name"] == name)


# ---------------------------------------------------------------------------
# Page parsing
# ---------------------------------------------------------------------------

def test_parse_search_page_returns_ssr_hits(hits):
    assert len(hits) == 4
    assert [h["job_information"]["title"] for h in hits][:2] == [
        "IT Support Specialist 1",
        "IT Tech Support Specialist",
    ]


def test_challenge_page_is_detected_and_never_parsed_as_jobs():
    assert looks_like_challenge(CHALLENGE_HTML)
    assert looks_like_challenge("<html></html>", {"cf-mitigated": "challenge"})
    # The real page also loads a Cloudflare script; its data block must win.
    assert not looks_like_challenge(SEARCH_HTML)
    with pytest.raises(ChallengePage):
        parse_search_page(CHALLENGE_HTML)


def test_page_without_next_data_raises():
    with pytest.raises(ValueError):
        parse_search_page("<html><body><h1>HiringCafe - 404</h1></body></html>")


# ---------------------------------------------------------------------------
# Field mapping: the exact failure from prod (title in company, age in role,
# hiringcafe.com as the apply link) must not come back.
# ---------------------------------------------------------------------------

def test_hit_maps_title_company_location_apply_link_and_salary(hits):
    job = hit_to_job(by_company(hits, "Lehman College"))
    assert job.source == "HiringCafe"
    assert job.title == "IT Support Assistant- Network & Security Support Specialist (Provisional)"
    assert job.company == "Lehman College"
    assert job.location == "Bronx, New York"
    assert job.apply_url.startswith("https://cuny.jobs/")
    assert "hiringcafe.com" not in job.apply_url
    assert job.salary_range == "$49,211 - $55,608"
    assert job.is_remote is False
    assert job.years_experience == 2  # 1.5 rounded
    assert "Requirements: High school diploma or GED" in job.description
    assert job.id  # generate_id ran


def test_remote_hit_keeps_remote_in_location_and_flag(hits):
    job = hit_to_job(by_company(hits, "Colure Health"))
    assert job.is_remote is True
    assert job.location == "Remote (New York City or United States)"
    assert job.salary_range == "$54,080 - $70,720"


def test_hit_without_listed_pay_has_empty_salary(hits):
    job = hit_to_job(by_company(hits, "EquipmentShare"))
    assert job.salary_range == ""
    assert job.location == "Columbia, Missouri"


def test_format_salary_falls_back_to_hourly_times_2080():
    assert format_salary({"hourly_min_compensation": 25, "hourly_max_compensation": 30}) == "$52,000 - $62,400"
    assert format_salary({"yearly_min_compensation": 60000, "yearly_max_compensation": 60000}) == "$60,000 - $60,000"
    assert format_salary({}) == ""


def test_format_location_variants():
    assert format_location({"formatted_workplace_location": "United States", "workplace_type": "Remote"}) == "Remote (United States)"
    assert format_location({"formatted_workplace_location": "", "workplace_cities": ["Queens, New York, US"], "workplace_type": "Hybrid"}) == "Queens, New York, US"
    assert format_location({"workplace_type": "Remote"}) == "Remote (United States)"


def test_build_description_is_compact_and_capped():
    v5 = {"core_job_title": "IT Support Specialist", "seniority_level": "Entry Level", "commitment": ["Full Time"],
          "requirements_summary": "x" * 5000, "technical_tools": ["Windows"]}
    desc = build_description(v5)
    assert desc.startswith("IT Support Specialist (Entry Level; Full Time)")
    assert len(desc) <= hiringcafe.MAX_DESCRIPTION


def test_expired_or_incomplete_hits_are_dropped(hits):
    expired = json.loads(json.dumps(hits[0]))
    expired["is_expired"] = True
    assert hit_to_job(expired) is None
    no_url = json.loads(json.dumps(hits[0]))
    no_url["apply_url"] = ""
    assert hit_to_job(no_url) is None


# ---------------------------------------------------------------------------
# Title filter: the search is fuzzy, so off-role hits must be dropped here.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("target,candidate,expected", [
    ("IT Support Specialist", "IT Support Specialist 1", True),
    ("IT Support Specialist", "Junior IT Support Specialist", True),
    ("IT Support Specialist", "Information Technology Support Specialist", True),
    ("IT Support Specialist", "IT Tech Support Specialist", True),
    ("IT Support Specialist", "Lead Specialist - IT ETRM Systems Dev", False),
    ("IT Support Specialist", "Principal Specialist - IT SAP Controlling and Project Systems", False),
    ("IT Support Specialist", "Assistant Store Manager", False),
    ("SOC Analyst", "SOC Analyst T1", True),
    ("SOC Analyst", "Security Operations Center Analyst", True),
    # Employers post the same job without "Center"; the first review run
    # dropped these three real remote hits on 2026-10-20.
    ("SOC Analyst", "Security Operations Analyst", True),
    ("SOC Analyst", "IT & Security Operations Analyst", True),
    ("SOC Analyst", "Analyst, Security Operations - USA Remote", True),
    ("Security Operations Center Analyst", "SOC Analyst", True),
    ("SOC Analyst", "Senior Product Manager, SOC Experience", False),
    ("SOC Analyst", "GRC Analyst", False),
    ("SOC Analyst", "Manager, Security Operations Center", False),
    ("SOC Analyst", "Security Analyst", False),
    ("NOC Technician", "Network Operations Center Technician", True),
    ("Data Analyst", "Data Analyst & IT Support Specialist", True),
    ("Data Analyst", "Senior Data Analytics Analyst", True),
    ("Data Analyst", "Shipping Management", False),
    ("Help Desk Technician", "Helpdesk Tech II", True),
    ("Cybersecurity Analyst", "Cyber Security Analyst - SOC", True),
    ("Business Intelligence Analyst", "BI Analyst", True),
    ("Prep", "Prep", True),
])
def test_matches_title(target, candidate, expected):
    assert matches_title(target, candidate) is expected


# The rows that filled a New York IT support user's feed between 2026-10-16
# and 2026-10-20 (Haiku scored all 56 of them 0-2). None may pass the filter
# for any of the tech titles the Per Scholas tracks target.
PROD_JUNK_TITLES = [
    "Assistant Store Manager",
    "Prep",
    "Certified Nursing Assistant (CNA) On-call",
    "Brookings Caregiver",
    "Deputy Medical Examiner - Forensic",
]


@pytest.mark.parametrize("junk", PROD_JUNK_TITLES)
@pytest.mark.parametrize("target", [
    "IT Support Specialist", "Help Desk Technician", "SOC Analyst", "GRC Analyst", "Data Analyst",
])
def test_prod_junk_titles_never_match_a_tech_target(target, junk):
    assert matches_title(target, junk) is False


def test_matches_title_accepts_core_job_title_as_second_candidate():
    # The site's normalised title can match when the raw one is decorated.
    assert matches_title("IT Support Assistant", "ITSA - Network & Security (Provisional)", "IT Support Assistant")


def test_title_tokens_drop_seniority_and_expand_abbreviations():
    assert title_tokens("Senior IT Support Specialist II") == ["information", "technology", "support", "specialist"]
    assert title_tokens("Junior SOC Analyst") == ["security", "operations", "analyst"]
    assert title_tokens("Security Operations Centre Analyst") == ["security", "operations", "analyst"]


# ---------------------------------------------------------------------------
# Age filter: the server ignores dateFetchedPastNDays, so the cut is made here.
# ---------------------------------------------------------------------------

def test_posted_days_ago_reads_the_iso_date_then_millis():
    now = FIXTURE_DAY
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date": "2026-10-20T04:34:41.000Z"}}, now) == 0
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date": "2026-10-12T23:00:00.000Z"}}, now) == 8
    millis = int((now - timedelta(days=30)).timestamp() * 1000)
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date_millis": millis}}, now) == 30
    # The ISO string wins when both are present.
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date": "2026-10-19T00:00:00Z",
                                                      "estimated_publish_date_millis": millis}}, now) == 1
    # A clock skew in the future is not a negative age.
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date": "2026-10-21T12:00:00.000Z"}}, now) == 0


def test_posted_days_ago_is_none_without_a_usable_date():
    assert posted_days_ago({}, FIXTURE_DAY) is None
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date": ""}}, FIXTURE_DAY) is None
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date": "last week"}}, FIXTURE_DAY) is None
    assert posted_days_ago({"v5_processed_job_data": {"estimated_publish_date_millis": 0}}, FIXTURE_DAY) is None


def test_fixture_hits_are_all_fresh_on_their_capture_day(hits):
    assert [posted_days_ago(h, FIXTURE_DAY) for h in hits] == [0, 1, 1, 0]


# ---------------------------------------------------------------------------
# Location filter and request shapes
# ---------------------------------------------------------------------------

def test_location_spec_classification():
    assert location_spec("New York").kind == "metro"
    assert location_spec("nyc").city == "New York City"
    assert location_spec("Washington DC") == LocationSpec("metro", "Washington DC", "Washington", "DC", 38.90719, -77.03687)
    assert location_spec("Remote").kind == "remote"
    assert location_spec("United States").kind == "remote"
    assert location_spec("Columbus, OH").kind == "text"
    assert location_spec("").kind == "anywhere"


def test_unique_specs_dedupes_aliases_and_defaults_to_anywhere():
    specs = unique_specs(["New York", "NYC", "Remote", "remote"])
    assert [s.kind for s in specs] == ["metro", "remote"]
    assert unique_specs([])[0].kind == "anywhere"


def test_search_state_for_a_city_uses_the_site_radius_shape():
    state = search_state("IT Support Specialist", location_spec("New York"))
    assert state["searchQuery"] == "IT Support Specialist"
    assert state["sortBy"] == "date" and state["dateFetchedPastNDays"] == 7
    assert "workplaceTypes" not in state
    loc = state["locations"][0]
    assert loc["types"] == ["locality"]
    assert loc["formatted_address"] == "New York City, NY, US"
    assert loc["geometry"]["location"] == {"lat": 40.71427, "lon": -74.00597}
    assert loc["options"] == {"ignore_radius": False, "radius": 50, "radius_unit": "miles"}
    assert loc["workplace_types"] == []
    assert loc["address_components"][1] == {"long_name": "New York", "short_name": "NY", "types": ["administrative_area_level_1"]}


def test_search_state_for_remote_is_us_remote_only():
    state = search_state("SOC Analyst", location_spec("Remote"))
    assert state["workplaceTypes"] == ["Remote"]
    loc = state["locations"][0]
    assert loc["types"] == ["country"] and loc["formatted_address"] == "United States"
    assert loc["workplace_types"] == ["Remote"]
    assert loc["options"] == {"flexible_regions": ["anywhere_in_continent", "anywhere_in_world"]}


def test_search_url_is_the_classic_page_with_compact_json():
    url = search_url(search_state("Data Analyst", location_spec("Remote")))
    assert url.startswith("https://hiringcafe.com/classic?searchState=%7B%22searchQuery%22%3A%22Data%20Analyst%22")
    assert " " not in url and "%20%22" not in url


def test_matches_location_for_a_metro_uses_coordinates(hits):
    nyc = location_spec("New York")
    assert matches_location(by_company(hits, "Lehman College"), nyc)      # Bronx
    assert matches_location(by_company(hits, "Colure Health"), nyc)       # remote, NYC point
    assert not matches_location(by_company(hits, "EquipmentShare"), nyc)  # Columbia, MO
    assert not matches_location(by_company(hits, "Transdev North America"), nyc)  # Lombard, IL


def test_matches_location_accepts_a_single_point_or_garbage_in_geoloc():
    nyc = location_spec("New York")
    v5 = {"formatted_workplace_location": "Somewhere", "workplace_type": "Onsite"}
    # Algolia allows _geoloc to be one object rather than a list.
    assert matches_location({"_geoloc": {"lat": 40.7128, "lon": -74.006}, "v5_processed_job_data": v5}, nyc)
    assert not matches_location({"_geoloc": {"lat": 34.05, "lon": -118.24}, "v5_processed_job_data": v5}, nyc)
    # Odd entries are skipped instead of raising out of the scrape loop.
    assert not matches_location({"_geoloc": [None, "40.7,-74.0", {"lat": "40.7", "lon": None}], "v5_processed_job_data": v5}, nyc)
    assert matches_location({"_geoloc": [None, {"lat": 40.7128, "lon": -74.006}], "v5_processed_job_data": v5}, nyc)


def test_matches_location_metro_falls_back_to_text_without_coordinates():
    hit = {"_geoloc": [], "v5_processed_job_data": {
        "formatted_workplace_location": "Barcelona or New York City or Beijing",
        "workplace_cities": ["Barcelona, Catalonia, ES", "New York City, New York, US"],
        "workplace_states": ["New York, US"], "workplace_type": "Hybrid"}}
    assert matches_location(hit, location_spec("New York"))
    far = {"_geoloc": [], "v5_processed_job_data": {"formatted_workplace_location": "Pomona, California, United States",
                                                    "workplace_cities": ["Pomona, California, US"], "workplace_type": "Onsite"}}
    assert not matches_location(far, location_spec("New York"))


def test_matches_location_remote_requires_remote_in_the_us(hits):
    remote = location_spec("Remote")
    assert matches_location(by_company(hits, "Colure Health"), remote)
    assert not matches_location(by_company(hits, "Lehman College"), remote)  # onsite
    hybrid_us = {"v5_processed_job_data": {"workplace_type": "Hybrid", "workplace_countries": ["US"]}}
    assert not matches_location(hybrid_us, remote)
    remote_abroad = {"v5_processed_job_data": {"workplace_type": "Remote", "workplace_countries": ["GB"], "boundless_workplace_countries": ["GB"]}}
    assert not matches_location(remote_abroad, remote)
    worldwide = {"v5_processed_job_data": {"workplace_type": "Remote", "is_workplace_worldwide_ok": True}}
    assert matches_location(worldwide, remote)


def test_matches_location_text_fallback_for_unknown_places():
    hit = {"v5_processed_job_data": {"formatted_workplace_location": "Washington, District of Columbia, United States",
                                     "workplace_states": ["District of Columbia, US"], "workplace_type": "Onsite"}}
    assert matches_location(hit, LocationSpec("text", "Washington, D.C."))
    assert not matches_location(hit, LocationSpec("text", "Columbus, OH"))


# ---------------------------------------------------------------------------
# End to end through scrape(): a saved page goes through the real loop.
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, text, status_code=200, headers=None):
        self.text = text
        self.status_code = status_code
        self.headers = headers or {}


def run_scrape(monkeypatch, responses, titles, locations, limit=20, now=FIXTURE_DAY):
    calls = []

    async def fake_get(client, url):
        calls.append(url)
        resp = responses[min(len(calls) - 1, len(responses) - 1)]
        return resp

    monkeypatch.setattr(hiringcafe, "_get", fake_get)
    monkeypatch.setattr(hiringcafe, "_now", lambda: now)
    monkeypatch.setattr(hiringcafe.asyncio, "sleep", _no_sleep)
    jobs = asyncio.run(hiringcafe.scrape(titles, locations, limit=limit))
    return jobs, calls


async def _no_sleep(*_args, **_kwargs):
    return None


def test_scrape_filters_by_title_and_location_and_maps_fields(monkeypatch):
    jobs, calls = run_scrape(monkeypatch, [FakeResponse(SEARCH_HTML)], ["IT Support Specialist"], ["New York", "Remote"])
    assert len(calls) == 2
    by_title = {j.title: j for j in jobs}
    # New York search keeps the Bronx and NYC-remote hits only; the remote
    # search re-finds Colure Health, which is deduped by apply URL.
    assert set(by_title) == {
        "IT Support Assistant- Network & Security Support Specialist (Provisional)",
        "IT Tech Support Specialist",
    }
    assert by_title["IT Tech Support Specialist"].company == "Colure Health"
    assert by_title["IT Tech Support Specialist"].location == "Remote (New York City or United States)"
    for job in jobs:
        assert job.company and job.apply_url.startswith("https://")
        assert "hiringcafe.com" not in job.apply_url


def test_scrape_respects_limit(monkeypatch):
    jobs, calls = run_scrape(monkeypatch, [FakeResponse(SEARCH_HTML)], ["IT Support Specialist"], ["New York", "Remote"], limit=1)
    assert len(jobs) == 1
    assert len(calls) == 1


def test_scrape_drops_hits_older_than_the_window(monkeypatch):
    # Age the Lehman College hit by seven weeks; it still matches the title
    # and the New York metro, and must still be left out.
    lehman_date = "2026-10-20T04:34:41.000Z"
    assert SEARCH_HTML.count(lehman_date) == 1
    stale_html = SEARCH_HTML.replace(lehman_date, "2026-09-01T04:34:41.000Z")
    jobs, _ = run_scrape(monkeypatch, [FakeResponse(stale_html)], ["IT Support Specialist"], ["New York"])
    assert [j.company for j in jobs] == ["Colure Health"]


def test_scrape_drops_everything_once_the_fixture_ages_out(monkeypatch):
    # Same page, clock moved three weeks past capture: nothing is fresh.
    jobs, _ = run_scrape(monkeypatch, [FakeResponse(SEARCH_HTML)], ["IT Support Specialist"], ["New York"],
                         now=FIXTURE_DAY + timedelta(days=21))
    assert jobs == []


def test_scrape_keeps_hits_that_carry_no_date(monkeypatch):
    # Rebuild the page with every date removed from the __NEXT_DATA__ blob.
    m = hiringcafe.NEXT_DATA_RE.search(SEARCH_HTML)
    data = json.loads(m.group(1))
    for hit in data["props"]["pageProps"]["ssrHits"]:
        hit["v5_processed_job_data"].pop("estimated_publish_date", None)
        hit["v5_processed_job_data"].pop("estimated_publish_date_millis", None)
    page = SEARCH_HTML[:m.start(1)] + json.dumps(data) + SEARCH_HTML[m.end(1):]
    assert all(posted_days_ago(h, FIXTURE_DAY) is None for h in parse_search_page(page))
    jobs, _ = run_scrape(monkeypatch, [FakeResponse(page)], ["IT Support Specialist"], ["New York"],
                         now=FIXTURE_DAY + timedelta(days=365))
    assert {j.company for j in jobs} == {"Lehman College", "Colure Health"}


def _stub_browser(monkeypatch, html):
    """The Chromium fallback, without a browser or the network."""
    seen = []

    async def fake_html(self, url, wait_s=20.0):
        seen.append(url)
        return html

    async def fake_close(self):
        return None

    monkeypatch.setattr(hiringcafe._Browser, "html", fake_html)
    monkeypatch.setattr(hiringcafe._Browser, "close", fake_close)
    return seen


def test_scrape_returns_nothing_when_the_browser_is_challenged_too(monkeypatch):
    browser_calls = _stub_browser(monkeypatch, CHALLENGE_HTML)
    jobs, calls = run_scrape(
        monkeypatch,
        [FakeResponse(CHALLENGE_HTML, status_code=403, headers={"cf-mitigated": "challenge"})],
        ["IT Support Specialist", "Data Analyst"],
        ["New York"],
    )
    assert jobs == []
    # One retry, one browser read, then the source stops instead of hammering the site.
    assert len(calls) == 2
    assert len(browser_calls) == 1


def test_scrape_reads_through_the_browser_when_plain_requests_are_challenged(monkeypatch):
    browser_calls = _stub_browser(monkeypatch, SEARCH_HTML)
    jobs, calls = run_scrape(
        monkeypatch,
        [FakeResponse(CHALLENGE_HTML, status_code=403, headers={"cf-mitigated": "challenge"})],
        ["IT Support Specialist"],
        ["New York"],
    )
    assert len(calls) == 2 and len(browser_calls) == 1
    assert {j.company for j in jobs} == {"Lehman College", "Colure Health"}


def test_scrape_skips_unparseable_pages_and_continues(monkeypatch):
    jobs, calls = run_scrape(
        monkeypatch,
        [FakeResponse("<html><body>maintenance</body></html>"), FakeResponse(SEARCH_HTML)],
        ["IT Support Specialist", "IT Support Assistant"],
        ["New York"],
    )
    assert len(calls) == 2
    assert any(j.company == "Lehman College" for j in jobs)


def test_scrape_logs_no_user_terms_above_debug(monkeypatch):
    records = []
    sink_id = logger.add(lambda m: records.append(m.record), level="DEBUG")
    try:
        run_scrape(monkeypatch, [FakeResponse(SEARCH_HTML)], ["IT Support Specialist"], ["New York", "Remote"])
    finally:
        logger.remove(sink_id)
    assert records, "expected log output"
    loud = [r["message"] for r in records if r["level"].no >= logger.level("INFO").no]
    assert loud, "expected INFO lines with counts"
    for message in loud:
        assert "IT Support Specialist" not in message
        assert "New York" not in message
    quiet = [r["message"] for r in records if r["level"].name == "DEBUG"]
    assert any("IT Support Specialist" in m for m in quiet)


def test_request_errors_keep_the_url_at_debug(monkeypatch):
    # httpx error messages quote the URL, and the URL carries the user's title.
    records = []
    sink_id = logger.add(lambda m: records.append(m.record), level="DEBUG")

    async def failing_get(client, url):
        raise httpx.ConnectError(f"connection refused for {url}")

    monkeypatch.setattr(hiringcafe, "_get", failing_get)
    monkeypatch.setattr(hiringcafe, "_now", lambda: FIXTURE_DAY)
    monkeypatch.setattr(hiringcafe.asyncio, "sleep", _no_sleep)
    try:
        jobs = asyncio.run(hiringcafe.scrape(["IT Support Specialist"], ["New York"]))
    finally:
        logger.remove(sink_id)
    assert jobs == []
    loud = [r["message"] for r in records if r["level"].no >= logger.level("INFO").no]
    assert any("request failed (ConnectError)" in m for m in loud)
    for message in loud:
        assert "IT Support Specialist" not in message and "IT%20Support" not in message
    assert any("IT%20Support%20Specialist" in r["message"] for r in records if r["level"].name == "DEBUG")
