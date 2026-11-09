"""Unit tests for reading existing jobs past PostgREST's row cap and for
reporting failed inserts in main.py.

Run from the scraper directory:
    python -m pytest tests/test_job_writes.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import main  # noqa: E402


class FakeQuery:
    """Just enough of the supabase-py query builder for existing_job_rows."""

    def __init__(self, rows: list[dict], max_rows: int, calls: list[tuple[int, int]]):
        self.rows = rows
        self.max_rows = max_rows
        self.calls = calls
        self.start = 0
        self.end = len(rows) - 1

    def select(self, *_):
        return self

    def eq(self, *_):
        return self

    def order(self, *_):
        return self

    def range(self, start: int, end: int):
        self.start, self.end = start, end
        return self

    def execute(self):
        self.calls.append((self.start, self.end))
        stop = min(self.end + 1, self.start + self.max_rows)
        return type("Result", (), {"data": self.rows[self.start:stop]})()


class FakeClient:
    def __init__(self, rows: list[dict], max_rows: int = 1000):
        self.rows = rows
        self.max_rows = max_rows
        self.calls: list[tuple[int, int]] = []

    def table(self, _name: str):
        return FakeQuery(self.rows, self.max_rows, self.calls)


def _rows(n: int) -> list[dict]:
    return [{"company": f"Co {i}", "role": "Designer"} for i in range(n)]


def test_reads_every_row_past_the_1000_row_cap():
    client = FakeClient(_rows(2500))
    assert len(main.existing_job_rows(client, "user")) == 2500
    assert client.calls[:3] == [(0, 999), (1000, 1999), (2000, 2999)]


def test_steps_by_what_came_back_when_the_cap_is_lower():
    client = FakeClient(_rows(1200), max_rows=500)
    assert len(main.existing_job_rows(client, "user")) == 1200


def test_no_existing_jobs():
    assert main.existing_job_rows(FakeClient([]), "user") == []


def test_error_only_when_every_attempted_insert_failed():
    assert main.insert_failure_error(inserted=0, failed=4) == "all 4 job inserts failed"
    # Nothing tried (everything below the floor) is a quiet day, not an error.
    assert main.insert_failure_error(inserted=0, failed=0) is None
    # Some rows landed: the count reports the rest.
    assert main.insert_failure_error(inserted=3, failed=1) is None
