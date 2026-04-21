"""Shared data models for the scraper service."""

import hashlib
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class JobListing(BaseModel):
    """A single scraped job listing."""

    id: str = Field(default="")
    source: str
    title: str
    company: str
    location: str = ""
    is_remote: bool = False
    description: str = ""
    years_experience: Optional[int] = None
    salary_range: str = ""
    apply_url: str = ""
    listing_url: str = ""
    date_scraped: datetime = Field(default_factory=datetime.now)
    priority: str = "Medium"
    status: str = "New"

    def generate_id(self) -> str:
        raw = f"{self.company.lower().strip()}|{self.title.lower().strip()}|{self.source}"
        self.id = hashlib.md5(raw.encode()).hexdigest()[:12]
        return self.id

    def is_excluded_company(self, excluded: list[str]) -> bool:
        company_lower = self.company.lower().strip()
        return any(exc.lower().strip() in company_lower for exc in excluded)

    def is_excluded_title(self, excluded: list[str]) -> bool:
        title_lower = self.title.lower().strip()
        return any(exc.lower().strip() in title_lower for exc in excluded if exc.strip())


class TargetCompany(BaseModel):
    """A company whose public ATS board we'll hit directly."""

    ats_type: str  # "greenhouse" | "lever" | "ashby"
    slug: str
    name: str = ""


class ScrapeRequest(BaseModel):
    """Request from the Vercel cron endpoint."""

    user_id: str
    target_titles: list[str] = []
    target_locations: list[str] = []
    salary_floor: int = 0
    excluded_companies: list[str] = []
    excluded_titles: list[str] = []
    min_match_score: int = 0
    sources: list[str] = ["linkedin", "builtin"]
    daily_job_limit: int = 20
    resume_text: str = ""
    companies: list[TargetCompany] = []
