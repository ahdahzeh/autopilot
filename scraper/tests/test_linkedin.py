"""Unit tests for the LinkedIn scraper's pure helpers: location mapping, the
US-remote search URL, the non-US post-filter and the daily search rotation.

Run from the scraper directory:
    python -m pytest tests/test_linkedin.py
"""

import math
import os
import sys
from datetime import date, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from scrapers import linkedin as li  # noqa: E402


# ---------------------------------------------------------------------------
# Location mapping and search URL
# ---------------------------------------------------------------------------


def test_remote_maps_to_us_geo_with_remote_facet():
    loc = li.map_location("Remote")
    assert loc.label == "United States"
    assert loc.geo_id == "103644278"
    assert loc.remote is True


@pytest.mark.parametrize(
    "raw",
    [
        "Remote", " remote ", "REMOTE", "Remote (US)", "Remote - US", "US Remote",
        "Remote - United States", "remote, usa", "United States Remote", "Anywhere",
        "United States", "USA",
    ],
)
def test_remote_variants_all_become_us_remote(raw):
    assert li.map_location(raw) == li.US_REMOTE


def test_known_metro_keeps_free_text_without_geo():
    loc = li.map_location("New York")
    assert loc == li.SearchLocation("New York City Metropolitan Area", None, False)
    assert li.map_location("nyc") == loc
    assert li.map_location("washington dc") == li.map_location("dmv")


def test_unknown_location_passes_through_untouched():
    assert li.map_location("Pune") == li.SearchLocation("Pune", None, False)
    assert li.map_location("  Toronto ") == li.SearchLocation("Toronto", None, False)


def test_build_url_for_remote_has_us_geo_and_remote_work_type():
    url = li.build_url("SOC Analyst", li.map_location("Remote"))
    parsed = urlparse(url)
    q = parse_qs(parsed.query)
    assert parsed.netloc == "www.linkedin.com" and parsed.path == "/jobs/search/"
    assert q["keywords"] == ["SOC Analyst"]
    assert q["location"] == ["United States"]
    assert q["geoId"] == ["103644278"]
    assert q["f_WT"] == ["2"]
    assert q["f_TPR"] == ["r86400"]


def test_build_url_for_metro_has_neither_geo_nor_work_type():
    q = parse_qs(urlparse(li.build_url("IT Support Specialist", li.map_location("New York"))).query)
    assert q["location"] == ["New York City Metropolitan Area"]
    assert "geoId" not in q
    assert "f_WT" not in q


def test_build_url_accepts_raw_strings_for_backwards_compatibility():
    assert "geoId=103644278" in li.build_url("SOC Analyst", "Remote")
    assert "geoId" not in li.build_url("SOC Analyst", "Chicago")


def test_dedupe_locations_is_order_preserving_and_merges_remote_aliases():
    locs = li.dedupe_locations([li.map_location(x) for x in ["Remote", "New York", "United States", "nyc", "Chicago"]])
    assert locs == [
        li.US_REMOTE,
        li.SearchLocation("New York City Metropolitan Area"),
        li.SearchLocation("Chicago, Illinois"),
    ]


# ---------------------------------------------------------------------------
# Country post-filter
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "location, country",
    [
        # The exact strings that showed up in prod LinkedIn rows since 2026-10-16.
        ("Pune Division, Maharashtra, India", "india"),
        ("Hyderabad, Telangana, India", "india"),
        ("Greater Hyderabad Area", "india"),
        ("Pune/Pimpri-Chinchwad Area", "india"),
        ("Calgary, Alberta, Canada", "canada"),
        ("Toronto, Ontario, Canada", "canada"),
        ("Edmonton, Alberta, Canada", "canada"),
        ("Dubai, United Arab Emirates", "uae"),
        # What a bare location=Remote search returned in the 2026-10-20 probe.
        ("St Leonards, New South Wales, Australia", "australia"),
        ("Singapore, Singapore", "singapore"),
        ("Cologne, North Rhine-Westphalia, Germany", "germany"),
        ("Rennes, Brittany, France", "france"),
        # Country beats city: London, Ontario is Canadian, not British.
        ("London, Ontario, Canada", "canada"),
        ("London Area, United Kingdom", "uk"),
        ("Remote - EMEA", "emea"),
        ("Bengaluru, Karnataka, India", "india"),
        ("Mexico City, Mexico", "mexico"),
    ],
)
def test_clearly_non_us_locations_resolve_to_a_country(location, country):
    assert li.country_of(location) == country


@pytest.mark.parametrize(
    "location",
    [
        "New York, NY", "United States", "Tampa, FL", "Washington, DC",
        "Washington DC-Baltimore Area", "New York City Metropolitan Area",
        # US places that share a name with somewhere abroad must stay US.
        "Albuquerque, New Mexico", "New Mexico, United States", "Indianapolis, IN",
        "Indiana, United States", "Vancouver, WA", "Ontario, CA", "Paris, TX",
        "Dublin, OH", "Lima, Ohio, United States", "Berlin, Connecticut, United States",
        "Perth Amboy, NJ", "Victoria, Texas, United States", "New Brunswick, NJ",
        # Ambiguous with no US tell is left alone rather than dropped.
        "Georgia", "Greater Boston", "Columbia, SC",
        # Unknown or empty is never dropped.
        "", "   ", "Somewhere Nice",
    ],
)
def test_us_and_unplaceable_locations_are_not_flagged(location):
    assert li.country_of(location) is None


def test_remote_only_user_drops_non_us_and_keeps_us_and_blank():
    allowed = li.allowed_countries(["Remote", "New York"])
    assert allowed == set()
    assert not li.is_allowed_location("Pune Division, Maharashtra, India", allowed)
    assert not li.is_allowed_location("Toronto, Ontario, Canada", allowed)
    assert li.is_allowed_location("Tampa, FL", allowed)
    assert li.is_allowed_location("United States", allowed)
    assert li.is_allowed_location("", allowed)


def test_user_who_targets_india_keeps_india_but_still_drops_canada():
    allowed = li.allowed_countries(["Pune", "Remote"])
    assert allowed == {"india"}
    assert li.is_allowed_location("Pune Division, Maharashtra, India", allowed)
    assert li.is_allowed_location("Greater Hyderabad Area", allowed)
    assert not li.is_allowed_location("Calgary, Alberta, Canada", allowed)


@pytest.mark.parametrize(
    "target, country",
    [
        # Shapes real users typed into target_locations.
        ("hyderabad india", "india"), ("bengaluru", "india"), ("united kingdom", "uk"),
        ("uk", "uk"), ("london", "uk"), ("toronto", "canada"), ("ontario", "canada"),
        ("alberta", "canada"), ("newfoundland", "canada"), ("dubai", "uae"),
        ("amsterdam", "netherlands"), ("netherlands", "netherlands"), ("berlin", "germany"),
        ("germany", "germany"), ("dublin", "ireland"), ("ireland", "ireland"),
    ],
)
def test_explicit_non_us_targets_are_recognised(target, country):
    assert li.allowed_countries([target]) == {country}


# ---------------------------------------------------------------------------
# Daily rotation of the title x location matrix
# ---------------------------------------------------------------------------

TITLES_7 = [f"Title {i}" for i in range(7)]
LOCS_3 = [li.US_REMOTE, li.SearchLocation("New York City Metropolitan Area"), li.SearchLocation("Chicago, Illinois")]
DAY0 = date(2026, 10, 20)
USER = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


def full_matrix(titles, locs):
    return {(t, l) for t in titles for l in locs}


def test_matrix_within_cap_runs_in_full_and_in_order():
    pairs, offset = li.select_pairs(TITLES_7[:2], LOCS_3, 6, DAY0, USER)
    assert offset == 0
    assert pairs == [(t, l) for t in TITLES_7[:2] for l in LOCS_3]


def test_window_has_exactly_max_searches_distinct_pairs():
    pairs, _ = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER)
    assert len(pairs) == 6
    assert len(set(pairs)) == 6
    assert set(pairs) <= full_matrix(TITLES_7, LOCS_3)


def test_rotation_is_deterministic_for_same_day_and_user():
    a = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER)
    b = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER)
    assert a == b


def test_rotation_moves_each_day():
    today, _ = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER)
    tomorrow, _ = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0 + timedelta(days=1), USER)
    assert today != tomorrow


@pytest.mark.parametrize("user_id", ["", USER, "00000000-0000-0000-0000-000000000000", "another-user"])
@pytest.mark.parametrize("start_day", [DAY0, DAY0 + timedelta(days=1), DAY0 + timedelta(days=17)])
def test_every_pair_runs_within_ceil_n_over_k_days(user_id, start_day):
    # 7 titles x 3 locations = 21 pairs at 6 per day: four consecutive days
    # must cover the whole matrix whoever the user is and whenever we start.
    n, k = 21, 6
    days = math.ceil(n / k)
    covered = set()
    for d in range(days):
        pairs, _ = li.select_pairs(TITLES_7, LOCS_3, k, start_day + timedelta(days=d), user_id)
        covered |= set(pairs)
    assert covered == full_matrix(TITLES_7, LOCS_3)


def test_no_pair_repeats_until_the_whole_matrix_has_run():
    # Days 0-2 run 18 distinct pairs; day 3 runs the last 3 before wrapping.
    seen = []
    for d in range(3):
        pairs, _ = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0 + timedelta(days=d), USER)
        seen.extend(pairs)
    assert len(seen) == 18 and len(set(seen)) == 18
    day3, _ = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0 + timedelta(days=3), USER)
    remaining = full_matrix(TITLES_7, LOCS_3) - set(seen)
    assert remaining <= set(day3) and len(remaining) == 3


def test_eight_pairs_truncated_to_six_are_all_covered_in_two_days():
    # The exact shape from the 2026-10-16 logs: "truncating 8 title x location pairs to 6".
    titles, locs = TITLES_7[:4], LOCS_3[:2]
    day1, _ = li.select_pairs(titles, locs, 6, DAY0, USER)
    day2, _ = li.select_pairs(titles, locs, 6, DAY0 + timedelta(days=1), USER)
    assert len(day1) == 6 and len(day2) == 6
    assert set(day1) | set(day2) == full_matrix(titles, locs)


def test_users_do_not_all_start_in_the_same_corner():
    offsets = {li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, f"user-{i}")[1] for i in range(40)}
    assert len(offsets) > 1


def test_zero_cap_means_no_cap():
    pairs, _ = li.select_pairs(TITLES_7, LOCS_3, 0, DAY0, USER)
    assert len(pairs) == 21


# main.py hands LinkedIn a share of the daily limit (often 5 jobs); with 3
# detail fetches per search a run stops after 2 searches, so the daily slide
# must be 2, not MAX_SEARCHES, or pairs 3-6 of every window would never run.


@pytest.mark.parametrize(
    "limit, details, max_searches, expected",
    [(5, 3, 6, 2), (20, 3, 6, 6), (6, 3, 6, 2), (7, 3, 6, 3), (1, 3, 6, 1), (0, 3, 6, 6), (5, 0, 6, 6), (5, 3, 0, 1)],
)
def test_searches_per_day_follows_the_job_limit(limit, details, max_searches, expected):
    assert li.searches_per_day(limit, details, max_searches) == expected


def test_window_still_has_max_searches_pairs_when_sliding_by_fewer():
    pairs, _ = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER, step=2)
    assert len(pairs) == 6 and len(set(pairs)) == 6


def test_consecutive_days_slide_by_step():
    today, start_today = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER, step=2)
    tomorrow, start_tomorrow = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0 + timedelta(days=1), USER, step=2)
    assert (start_tomorrow - start_today) % 21 == 2
    # Tomorrow's first pair is the one right after the two that ran today.
    assert tomorrow[0] == today[2]


@pytest.mark.parametrize("user_id", ["", USER, "another-user"])
def test_first_step_pairs_of_each_day_cover_the_matrix_within_ceil_n_over_step_days(user_id):
    step = li.searches_per_day(limit=5, details_per_search=3, max_searches=6)
    assert step == 2
    days = math.ceil(21 / step)
    covered = set()
    for d in range(days):
        pairs, _ = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0 + timedelta(days=d), user_id, step=step)
        covered |= set(pairs[:step])
    assert covered == full_matrix(TITLES_7, LOCS_3)


def test_step_larger_than_window_is_clamped_to_the_window():
    a = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER, step=50)
    b = li.select_pairs(TITLES_7, LOCS_3, 6, DAY0, USER, step=6)
    assert a == b
