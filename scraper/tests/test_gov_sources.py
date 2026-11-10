import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scrapers import nycjobs, usajobs  # noqa: E402

NYC_ROW = {
    "job_id": "798548",
    "agency": "CONSUMER AND WORKER PROTECTION",
    "business_title": "Help Desk Technician",
    "work_location": "42 Broadway, N.Y.",
    "salary_range_from": "38173",
    "salary_range_to": "45149.16",
    "salary_frequency": "Annual",
    "job_description": "Support staff laptops.",
}

USA_ITEM = {
    "MatchedObjectDescriptor": {
        "PositionTitle": "IT Specialist (CUSTSPT)",
        "OrganizationName": "Department of Veterans Affairs",
        "PositionLocationDisplay": "New York, New York",
        "PositionURI": "https://www.usajobs.gov/job/123",
        "ApplyURI": ["https://www.usajobs.gov/job/123/apply"],
        "PositionRemuneration": [{"MinimumRange": "62000", "MaximumRange": "80000", "RateIntervalCode": "PA"}],
        "UserArea": {"Details": {"JobSummary": "Help desk for a medical center.", "RemoteIndicator": False}},
    }
}


def test_nyc_mapping():
    job = nycjobs.to_listing(NYC_ROW)
    assert job.title == "Help Desk Technician"
    assert job.company == "NYC Consumer and Worker Protection"
    assert job.location == "42 Broadway, New York, NY"
    assert job.salary_range == "$38,173 - $45,149"
    assert job.apply_url == "https://cityjobs.nyc.gov/job/798548"


def test_nyc_only_runs_for_nyc_targets():
    assert nycjobs.targets_nyc(["New York, NY", "Remote"])
    assert nycjobs.targets_nyc(["Brooklyn"])
    assert not nycjobs.targets_nyc(["Remote", "Chicago, IL"])
    assert asyncio.run(nycjobs.scrape(["IT Support"], ["Remote"])) == []


def test_usajobs_mapping_and_params():
    job = usajobs.to_listing(USA_ITEM)
    assert job.title == "IT Specialist (CUSTSPT)"
    assert job.company == "Department of Veterans Affairs"
    assert job.apply_url.endswith("/apply")
    assert job.salary_range == "$62,000 - $80,000"
    assert usajobs._search_params("SOC Analyst", "Remote")["RemoteIndicator"] == "True"
    assert usajobs._search_params("SOC Analyst", "New York, NY")["LocationName"] == "New York, NY"


def test_usajobs_skips_without_key(monkeypatch):
    monkeypatch.delenv("USAJOBS_API_KEY", raising=False)
    assert asyncio.run(usajobs.scrape(["IT Specialist"], ["Remote"])) == []


def test_nyc_title_matching_is_strict():
    targets = ["IT Support Specialist", "Help Desk Technician", "SOC Analyst", "Data Analyst"]
    assert nycjobs.title_matches("Help Desk Technician", targets)
    assert nycjobs.title_matches("Information Technology Support Specialist", targets)
    assert nycjobs.title_matches("Security Operations Center Analyst", targets)
    assert nycjobs.title_matches("Data Content Analyst II", targets)
    for off in ["Mediator and Intake Specialist", "Instructor", "Customer Service Representative", "Program Manager"]:
        assert not nycjobs.title_matches(off, targets), off
