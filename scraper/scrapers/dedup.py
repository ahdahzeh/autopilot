"""Job Deduplicator — exact + fuzzy matching, Supabase history."""

from difflib import SequenceMatcher
from loguru import logger
from models import JobListing


def normalize_company(name: str) -> str:
    name = name.lower().strip()
    for suffix in [", inc.", ", inc", " inc.", " inc", ", llc", " llc",
                   ", ltd", " ltd", ", co.", " co.", " corporation", " corp."]:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    name = "".join(c for c in name if c.isalnum() or c == " ")
    return " ".join(name.split())


def normalize_title(title: str) -> str:
    title = title.lower().strip()
    for old, new in {"sr.": "senior", "sr ": "senior ", "jr.": "junior",
                     "jr ": "junior ", "assoc.": "associate", "mgr": "manager",
                     "dir.": "director"}.items():
        title = title.replace(old, new)
    return " ".join(title.split())


def is_fuzzy_duplicate(a: JobListing, b: JobListing, threshold: float = 0.85) -> bool:
    comp_sim = SequenceMatcher(None, normalize_company(a.company), normalize_company(b.company)).ratio()
    title_sim = SequenceMatcher(None, normalize_title(a.title), normalize_title(b.title)).ratio()
    return comp_sim >= threshold and title_sim >= threshold


def pick_best(dupes: list[JobListing]) -> JobListing:
    return max(dupes, key=lambda j: (len(j.description), bool(j.salary_range)))


def deduplicate(jobs: list[JobListing], existing_keys: set[str] | None = None) -> list[JobListing]:
    """Deduplicate a batch of scraped jobs.

    Args:
        jobs: Freshly scraped jobs
        existing_keys: Set of "company|title" keys already in Supabase for this user
    """
    if not jobs:
        return []

    logger.info(f"Deduplicating {len(jobs)} listings...")

    # Step 1: Exact ID dedup within batch
    id_map = {}
    for job in jobs:
        if not job.id:
            job.generate_id()
        if job.id in id_map:
            id_map[job.id] = pick_best([id_map[job.id], job])
        else:
            id_map[job.id] = job
    after_exact = list(id_map.values())
    logger.info(f"  After exact dedup: {len(after_exact)} (removed {len(jobs) - len(after_exact)})")

    # Step 2: Fuzzy cross-platform dedup
    unique = []
    for job in after_exact:
        is_dupe = False
        for i, existing in enumerate(unique):
            if is_fuzzy_duplicate(job, existing):
                unique[i] = pick_best([existing, job])
                is_dupe = True
                break
        if not is_dupe:
            unique.append(job)
    logger.info(f"  After fuzzy dedup: {len(unique)} (removed {len(after_exact) - len(unique)})")

    # Step 3: Filter out jobs already in Supabase
    if existing_keys:
        before = len(unique)
        unique = [
            j for j in unique
            if f"{normalize_company(j.company)}|{normalize_title(j.title)}" not in existing_keys
        ]
        logger.info(f"  After history dedup: {len(unique)} (removed {before - len(unique)} existing)")

    logger.info(f"Dedup complete: {len(jobs)} -> {len(unique)}")
    return unique
