"""BuiltIn scraper: card parsing, location mapping and log redaction against a saved page.

Fixture scraper/tests/fixtures/builtin_search_cards.html holds six real job
cards captured on 2026-10-20: three from builtinnyc.com/jobs/search/it-support
and three from builtin.com/jobs/remote/search/it-support, with the collapsed
description blocks removed.
"""

import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

SCRAPER_DIR = Path(__file__).resolve().parents[1]
if str(SCRAPER_DIR) not in sys.path:
    sys.path.insert(0, str(SCRAPER_DIR))

from loguru import logger  # noqa: E402

from scrapers import builtin  # noqa: E402
from scrapers.builtin import (  # noqa: E402
    SearchTarget,
    build_search_path,
    card_to_job,
    location_matches,
    map_builtin_location,
    normalize_location,
    parse_builtin_cards,
    parse_posted_days,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CARDS_HTML = (FIXTURES / "builtin_search_cards.html").read_text()
WORK_TYPES = {"", "in-office", "hybrid", "remote", "onsite", "remote or hybrid"}


@pytest.fixture
def cards():
    return parse_builtin_cards(CARDS_HTML, "https://www.builtinnyc.com")


# ---------------------------------------------------------------------------
# Card parsing
# ---------------------------------------------------------------------------

def test_parses_every_card_with_each_field(cards):
    assert len(cards) == 6
    first = cards[0]
    assert first == {
        "title": "IT Support Engineer",
        "company": "Airwallex",
        "url": "https://www.builtinnyc.com/job/it-support-engineer/11711660",
        "geo": "New York, NY, USA",
        "work_type": "In-Office",
        "salary": "120K-170K Annually",
        "posted": "5 Days Ago",
        "level": "Entry level",
    }


def test_hybrid_and_remote_cards_keep_city_separate_from_arrangement(cards):
    by_company = {c["company"]: c for c in cards}
    assert by_company["CAIS"]["geo"] == "New York, NY, USA"
    assert by_company["CAIS"]["work_type"] == "Hybrid"
    assert by_company["Keeper Security, Inc."]["geo"] == "US"
    assert by_company["Keeper Security, Inc."]["work_type"] == "Remote or Hybrid"
    assert by_company["Relativity"]["geo"] == "Illinois, USA"
    assert by_company["Relativity"]["work_type"] == "Remote"
    assert by_company["Harvard-Westlake School"]["posted"] == "Yesterday"
    assert by_company["RoundTable Technology"]["posted"] == "Reposted 12 Days Ago"


def test_parser_returns_nothing_for_changed_markup():
    assert parse_builtin_cards("<html><body><div class='card'><a href='/job/x/1'>X</a></div></body></html>", "https://builtin.com") == []


# ---------------------------------------------------------------------------
# The prod failure: location held the work arrangement (or nothing) instead
# of the city. Every card in the fixture must come out with a real place.
# ---------------------------------------------------------------------------

def test_jobs_never_carry_a_bare_work_arrangement_as_location(cards):
    target = SearchTarget("builtinnyc.com", "NYC", False)
    for card in cards:
        job = card_to_job(card, target)
        assert job.location.lower() not in WORK_TYPES, (card["company"], job.location)
        assert job.location


def test_card_to_job_mapping(cards):
    by_company = {c["company"]: c for c in cards}
    nyc = SearchTarget("builtinnyc.com", "NYC", False)
    office = card_to_job(by_company["Airwallex"], nyc)
    assert office.source == "BuiltIn"
    assert office.title == "IT Support Engineer"
    assert office.company == "Airwallex"
    assert office.location == "New York, NY"
    assert office.is_remote is False
    assert office.salary_range == "120K-170K Annually"
    assert office.apply_url == "https://www.builtinnyc.com/job/it-support-engineer/11711660"
    assert office.id

    hybrid = card_to_job(by_company["CAIS"], nyc)
    assert hybrid.location == "New York, NY" and hybrid.is_remote is False

    remote_us = card_to_job(by_company["Keeper Security, Inc."], nyc)
    assert remote_us.location == "Remote or Hybrid (US)" and remote_us.is_remote is True

    remote_state = card_to_job(by_company["Relativity"], SearchTarget("builtin.com", "Remote", True))
    assert remote_state.location == "Illinois (Remote)" and remote_state.is_remote is True


@pytest.mark.parametrize("geo,work_type,expected", [
    ("New York, NY, USA", "In-Office", "New York, NY"),
    ("10001, New York, NY, USA", "In-Office", "New York, NY"),
    ("New York, NY, United States", "Hybrid", "New York, NY"),
    ("US", "Remote", "Remote (US)"),
    ("United States", "Remote", "Remote (US)"),
    ("", "Remote", "Remote (US)"),
    ("Universal City Studios, CA, USA", "Remote", "Universal City Studios, CA (Remote)"),
    ("", "", "NYC"),
    ("", "In-Office", "NYC"),
])
def test_normalize_location(geo, work_type, expected):
    assert normalize_location(geo, work_type, fallback="NYC") == expected


@pytest.mark.parametrize("text,expected", [
    ("5 Days Ago", 5),
    ("Reposted 12 Days Ago", 12),
    ("3 Minutes Ago", 0),
    ("15 Hours Ago", 0),
    ("Yesterday", 1),
    ("One Month Ago", 30),
    ("2 Weeks Ago", 14),
    ("A Week Ago", 7),
    ("", None),
    ("Saved", None),
])
def test_parse_posted_days(text, expected):
    assert parse_posted_days(text) == expected


# ---------------------------------------------------------------------------
# Location routing
# ---------------------------------------------------------------------------

def test_map_builtin_location_routes_known_cities_and_remote():
    assert map_builtin_location("New York") == [
        SearchTarget("builtinnyc.com", "NYC", False),
        SearchTarget("builtinnyc.com", "NYC Remote", True),
    ]
    assert map_builtin_location("Remote") == [SearchTarget("builtin.com", "Remote", True)]
    assert map_builtin_location("Boston")[0].domain == "builtinboston.com"


def test_unknown_city_runs_nationally_with_a_text_filter():
    assert map_builtin_location("Washington DC") == [SearchTarget("builtin.com", "Washington DC", False, "Washington DC")]


@pytest.mark.parametrize("wanted,geo,expected", [
    ("Washington DC", "Washington, DC, USA", True),
    ("Washington, D.C.", "Washington, District of Columbia, USA", True),
    ("Washington DC", "New York, NY, USA", False),
    ("Washington DC", "Seattle, WA, USA", False),
    ("Atlanta", "Atlanta, GA, USA", True),
    ("Atlanta", "US", False),
    ("Columbus, OH", "Columbus, Ohio, USA", True),
])
def test_location_matches(wanted, geo, expected):
    assert location_matches(wanted, geo) is expected


def test_build_search_path_slugs_titles():
    assert build_search_path("IT Support", False) == "/jobs/search/it-support"
    assert build_search_path("Cybersecurity Analyst", True) == "/jobs/remote/search/cybersecurity-analyst"
    assert build_search_path("SOC Analyst (Tier 1)", False) == "/jobs/search/soc-analyst-tier-1"


# ---------------------------------------------------------------------------
# End to end through scrape() with the browser replaced by the saved page.
# ---------------------------------------------------------------------------

@asynccontextmanager
async def fake_browser_page():
    yield object()


async def no_sleep(*_args, **_kwargs):
    return None


def run_scrape(monkeypatch, pages, titles, locations, limit=20):
    urls = []

    async def fake_fetch(page, url):
        urls.append(url)
        return pages[min(len(urls) - 1, len(pages) - 1)]

    monkeypatch.setattr(builtin, "_browser_page", fake_browser_page)
    monkeypatch.setattr(builtin, "fetch_search_html", fake_fetch)
    monkeypatch.setattr(builtin.asyncio, "sleep", no_sleep)
    return asyncio.run(builtin.scrape(titles, locations, limit=limit)), urls


def test_scrape_maps_cards_and_drops_stale_listings(monkeypatch):
    jobs, urls = run_scrape(monkeypatch, [CARDS_HTML], ["IT Support"], ["New York"])
    assert urls == [
        "https://www.builtinnyc.com/jobs/search/it-support",
        "https://www.builtinnyc.com/jobs/remote/search/it-support",
    ]
    companies = {j.company for j in jobs}
    # RoundTable Technology (12 days) and Avrek Law Firm (12 days) are stale.
    assert companies == {"Airwallex", "CAIS", "Keeper Security, Inc.", "Relativity", "Harvard-Westlake School"}
    for job in jobs:
        assert job.location.lower() not in WORK_TYPES
        assert job.apply_url.startswith("https://www.builtinnyc.com/job/")


def test_scrape_applies_text_filter_for_cities_without_an_edition(monkeypatch):
    jobs, urls = run_scrape(monkeypatch, [CARDS_HTML], ["IT Support"], ["Illinois"])
    assert urls == ["https://www.builtin.com/jobs/search/it-support"]
    assert [j.company for j in jobs] == ["Relativity"]
    assert jobs[0].location == "Illinois (Remote)"


def test_scrape_respects_limit(monkeypatch):
    jobs, urls = run_scrape(monkeypatch, [CARDS_HTML], ["IT Support", "Help Desk"], ["New York"], limit=2)
    assert len(jobs) == 2
    assert len(urls) == 1


def test_scrape_logs_no_user_terms_above_debug(monkeypatch):
    records = []
    sink_id = logger.add(lambda m: records.append(m.record), level="DEBUG")
    try:
        run_scrape(monkeypatch, [CARDS_HTML], ["IT Support"], ["New York"])
    finally:
        logger.remove(sink_id)
    loud = [r["message"] for r in records if r["level"].no >= logger.level("INFO").no]
    assert loud
    for message in loud:
        assert "IT Support" not in message
        assert "New York" not in message and "NYC" not in message
    assert any("IT Support" in r["message"] for r in records if r["level"].name == "DEBUG")


def test_page_load_failures_keep_the_url_at_debug(monkeypatch):
    # Playwright's errors quote the URL, whose slug is the user's title.
    records = []
    sink_id = logger.add(lambda m: records.append(m.record), level="DEBUG")

    async def failing_fetch(page, url):
        raise TimeoutError(f"Timeout 20000ms exceeded navigating to {url}")

    monkeypatch.setattr(builtin, "_browser_page", fake_browser_page)
    monkeypatch.setattr(builtin, "fetch_search_html", failing_fetch)
    monkeypatch.setattr(builtin.asyncio, "sleep", no_sleep)
    try:
        jobs = asyncio.run(builtin.scrape(["IT Support"], ["New York"]))
    finally:
        logger.remove(sink_id)
    assert jobs == []
    loud = [r["message"] for r in records if r["level"].no >= logger.level("INFO").no]
    assert any("page load failed (TimeoutError)" in m for m in loud)
    for message in loud:
        assert "it-support" not in message and "IT Support" not in message
    assert any("it-support" in r["message"] for r in records if r["level"].name == "DEBUG")
