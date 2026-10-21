"""Unit tests for the global insert floor (MIN_INSERT_SCORE) in main.py.

Run from the scraper directory:
    python -m pytest tests/test_score_floor.py
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# Importing main reads the env once, so make sure a developer's shell does not
# change what "default" means in these tests.
os.environ.pop("MIN_INSERT_SCORE", None)
os.environ.pop("MIN_INSERT_SCORE_HEURISTIC", None)

import main  # noqa: E402


def test_default_floor_is_three_and_heuristic_floor_is_off():
    assert main.MIN_INSERT_SCORE == 3
    assert main.MIN_INSERT_SCORE_HEURISTIC == 0


def test_haiku_scored_jobs_face_the_max_of_user_and_global_floor():
    # User left min_match_score at its default of 0: the global floor holds.
    assert main.insert_floor(user_min=0, haiku_scored=True, has_resume=True) == 3
    # User's own threshold is stricter than the global one: theirs wins.
    assert main.insert_floor(user_min=5, haiku_scored=True, has_resume=True) == 5
    # User's threshold is looser than the global one: the global one wins.
    assert main.insert_floor(user_min=2, haiku_scored=True, has_resume=True) == 3


def test_global_floor_is_overridable():
    assert main.insert_floor(0, True, True, global_min=4) == 4
    assert main.insert_floor(0, True, True, global_min=0) == 0


def test_heuristic_only_jobs_only_face_the_users_own_threshold_by_default():
    assert main.insert_floor(user_min=0, haiku_scored=False, has_resume=True) == 0
    assert main.insert_floor(user_min=2, haiku_scored=False, has_resume=True) == 2


def test_heuristic_floor_knob_never_applies_without_a_resume():
    # With a resume the heuristic carries some signal, so the knob applies.
    assert main.insert_floor(0, False, True, heuristic_min=1) == 1
    # Without one score_job returns 0 for everything; the knob must not
    # silently zero out a new user's feed.
    assert main.insert_floor(0, False, False, heuristic_min=1) == 0
    assert main.insert_floor(0, False, False, global_min=9, heuristic_min=9) == 0


def test_negative_or_missing_user_min_is_treated_as_zero():
    assert main.insert_floor(-4, True, True) == 3
    assert main.insert_floor(None, False, True) == 0  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "raw, expected",
    [(78, 8), (100, 10), (35, 4), (26, 3), (25, 2), (24, 2), (0, 0)],
)
def test_resolve_score_rounds_haiku_to_the_0_10_scale(raw, expected):
    haiku = {"score": raw, "reasoning": "why", "matched_skills": ["a", "b", "c"], "concerns": []}
    score, reasoning, skills, concerns = main.resolve_score(haiku, heuristic=1)
    assert score == expected
    assert (reasoning, skills, concerns) == ("why", ["a", "b", "c"], [])


def test_resolve_score_falls_back_to_heuristic_with_empty_extras():
    assert main.resolve_score(None, heuristic=2) == (2, "", [], [])


def decide(haiku_raw, heuristic, user_min, has_resume):
    """Mirror of the insert loop's decision: True when the job is inserted."""
    haiku = None if haiku_raw is None else {"score": haiku_raw, "reasoning": "", "matched_skills": [], "concerns": []}
    score, *_ = main.resolve_score(haiku, heuristic)
    return score >= main.insert_floor(user_min, haiku is not None, has_resume)


def test_insert_decisions_on_a_typical_batch_with_default_floor():
    # Haiku-scored: 78 and 35 and 26 are inserted, 25 and 0 are not.
    assert decide(78, 1, 0, True)
    assert decide(35, 1, 0, True)
    assert decide(26, 1, 0, True)
    assert not decide(25, 1, 0, True)
    assert not decide(0, 1, 0, True)
    # Heuristic-only rows below the top-20 batch keep flowing at 1 or 2.
    assert decide(None, 1, 0, True)
    assert decide(None, 2, 0, True)


def test_user_without_resume_still_gets_their_heuristic_zero_jobs():
    # Haiku never runs without a resume, so every score is a heuristic 0.
    assert decide(None, 0, 0, False)


def test_users_own_min_match_score_still_applies_everywhere():
    assert not decide(None, 2, 3, True)
    assert not decide(None, 0, 1, False)
    assert not decide(45, 0, 5, True)
    assert decide(55, 0, 5, True)


def test_short_user_is_a_stable_8_char_hash_that_is_not_the_id():
    uid = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    tag = main.short_user(uid)
    assert len(tag) == 8 and tag == main.short_user(uid)
    assert tag not in uid and uid not in tag
    assert main.short_user("") == main.short_user(None)  # type: ignore[arg-type]
