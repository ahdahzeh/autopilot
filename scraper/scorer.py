"""Resume-based job match scorer."""

import re
from difflib import SequenceMatcher
from models import JobListing


# Role-family taxonomy. Each family is a set of tokens that can appear in a
# job title. A scraped job is only considered relevant if it shares a family
# with at least one of the user's target titles. Job board search APIs return
# loose keyword matches (e.g. "Product Manager" leaks into a "Product Designer"
# search), so we filter on the role noun rather than trusting the search.
ROLE_FAMILIES: dict[str, set[str]] = {
    "designer": {"designer", "design", "ux", "ui", "ixd"},
    "researcher": {"researcher", "research"},
    "manager": {"manager", "pm", "tpm", "epm"},
    "engineer": {"engineer", "developer", "swe", "sde", "programmer"},
    "scientist": {"scientist", "ml", "ds"},
    "analyst": {"analyst", "analytics"},
    "marketer": {"marketer", "marketing", "growth"},
    "writer": {"writer", "editor", "copywriter", "content"},
    "operations": {"operations", "ops", "operator"},
    "sales": {"sales", "account executive", "ae", "bdr", "sdr"},
    "recruiter": {"recruiter", "recruiting", "talent"},
    "founder": {"founder", "founding"},
}


def title_families(title: str) -> set[str]:
    """Return the set of role families a title belongs to."""
    lower = title.lower()
    matches = set()
    for family, tokens in ROLE_FAMILIES.items():
        for tok in tokens:
            if re.search(rf"\b{re.escape(tok)}\b", lower):
                matches.add(family)
                break
    return matches


def is_title_relevant(job_title: str, target_titles: list[str]) -> bool:
    """Check whether a scraped job title shares a role family with any target.

    Returns True if no target families could be determined (graceful fallback —
    don't drop everything when the user's target_titles are unconventional).
    """
    target_families: set[str] = set()
    for t in target_titles:
        target_families |= title_families(t)
    if not target_families:
        return True
    job_families = title_families(job_title)
    if not job_families:
        # Title we can't classify — let it through rather than over-filter.
        return True
    return bool(job_families & target_families)


def extract_keywords(text: str) -> set[str]:
    """Extract meaningful keywords from text."""
    text = text.lower()
    # Remove common stop words
    stops = {"and", "the", "a", "an", "in", "on", "at", "to", "for", "of", "with",
              "is", "are", "was", "were", "be", "been", "have", "has", "had", "do",
              "does", "did", "will", "would", "could", "should", "may", "might",
              "i", "you", "we", "they", "he", "she", "it", "my", "your", "our"}
    words = re.findall(r'\b[a-z][a-z0-9+#.]{2,}\b', text)
    return {w for w in words if w not in stops}


# Skills/tools that are especially meaningful in job matching
TECH_SKILLS = {
    "figma", "sketch", "invision", "zeplin", "framer", "principle",
    "react", "typescript", "javascript", "python", "swift", "kotlin",
    "sql", "graphql", "rest", "api", "aws", "gcp", "azure",
    "design system", "design systems", "component library",
    "user research", "usability testing", "a/b testing",
    "prototyping", "wireframing", "interaction design",
    "product thinking", "cross-functional", "agile", "scrum",
    "accessibility", "wcag", "responsive design",
    "data visualization", "analytics", "metrics",
    "b2b", "b2c", "saas", "fintech", "healthtech", "edtech",
}


def score_job(job: JobListing, resume_text: str, target_titles: list[str]) -> int:
    """Score a job 0-10 based on resume match.

    Returns an integer 0-10 to store in match_score column.
    """
    if not resume_text:
        return 0

    resume_keywords = extract_keywords(resume_text)
    score = 0.0

    # 1. Title similarity (up to 4 points)
    best_title_sim = 0.0
    for target in target_titles:
        sim = SequenceMatcher(None, job.title.lower(), target.lower()).ratio()
        best_title_sim = max(best_title_sim, sim)
    score += best_title_sim * 4

    # 2. Job description keyword overlap (up to 4 points)
    if job.description:
        job_keywords = extract_keywords(job.description)
        if job_keywords:
            overlap = len(resume_keywords & job_keywords) / len(job_keywords)
            score += overlap * 4

    # 3. Tech skill matches (up to 2 bonus points)
    resume_lower = resume_text.lower()
    desc_lower = (job.title + " " + job.description).lower()
    skill_matches = sum(1 for s in TECH_SKILLS if s in resume_lower and s in desc_lower)
    score += min(skill_matches * 0.4, 2.0)

    return max(0, min(10, round(score)))
