import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402


def test_india_locations_are_blocked():
    for loc in ["Pune", "Bengaluru", "Hyderabad, Telangana, India", "Pune Division, Maharashtra, India", "Remote - India"]:
        assert main._blocked_country(loc), loc


def test_us_and_unplaceable_locations_pass():
    for loc in ["New York, NY", "Remote", "Remote (US)", "Hyderabad, MD", "", "2 Locations", "Toronto, Ontario, Canada"]:
        assert not main._blocked_country(loc), loc
