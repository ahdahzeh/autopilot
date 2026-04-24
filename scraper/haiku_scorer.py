"""Haiku-based semantic re-scorer.

Runs after the heuristic pre-filter in scorer.py. Takes the top-N jobs by heuristic
score and calls claude-haiku-4-5 concurrently with a structured tool-use schema to
produce a 0-100 fit score plus reasoning, matched skills, and concerns.

Designed to be a drop-in supplement: if ANTHROPIC_API_KEY is missing or a single
call fails, we skip that job rather than crash the batch — the caller can fall
back to the heuristic score for unscored jobs.
"""

import asyncio
import os
from typing import Any

from loguru import logger

try:
    from anthropic import AsyncAnthropic
    from anthropic import APIStatusError, RateLimitError
except ImportError:  # pragma: no cover — defensive so import failure doesn't kill main.py
    AsyncAnthropic = None  # type: ignore
    APIStatusError = Exception  # type: ignore
    RateLimitError = Exception  # type: ignore

from models import JobListing


MODEL = "claude-haiku-4-5-20251001"
MAX_CONCURRENCY = 5
MAX_RETRIES = 2
RETRY_SLEEP_SECONDS = 2.0

# Trim very long descriptions before sending. Haiku's 200K context can handle
# full JDs, but (a) most signal is in the first ~2K chars anyway, and (b) we're
# firing 20 of these per scrape, so tokens add up fast.
MAX_DESCRIPTION_CHARS = 2000


SCORE_TOOL = {
    "name": "score_job",
    "description": (
        "Record a structured evaluation of how well a scraped job matches the candidate. "
        "Must be called exactly once per job."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "score": {
                "type": "integer",
                "description": (
                    "Fit score from 0 to 100. 0-30 = wrong role/level; 31-49 = tangential; "
                    "50-69 = plausible but imperfect; 70-84 = strong match worth applying to; "
                    "85-100 = near-perfect fit. Spread scores; don't cluster at 60."
                ),
                "minimum": 0,
                "maximum": 100,
            },
            "reasoning": {
                "type": "string",
                "description": "One concise sentence (max ~20 words) explaining the score.",
            },
            "matched_skills": {
                "type": "array",
                "description": "Exactly 3 short phrases (1-4 words each) naming the strongest overlap points between the candidate and the job.",
                "items": {"type": "string"},
                "minItems": 3,
                "maxItems": 3,
            },
            "concerns": {
                "type": "array",
                "description": "0-3 short phrases (1-4 words each) flagging mismatches or risks. Empty array if no concerns.",
                "items": {"type": "string"},
                "minItems": 0,
                "maxItems": 3,
            },
        },
        "required": ["score", "reasoning", "matched_skills", "concerns"],
    },
}


SYSTEM_PROMPT = (
    "You evaluate whether a scraped job listing is a good fit for a specific candidate. "
    "Return a 0-100 fit score where 70+ means 'strongly worth applying to' and below 40 "
    "means 'wrong role/level/industry — skip.' Calibrate scores so they spread; do not "
    "cluster everything around 60. Weigh role title + seniority heaviest, then industry "
    "alignment with the candidate's priorities, then the keyword/skill overlap. "
    "Always call the score_job tool exactly once."
)


def _build_user_prompt(
    job: JobListing,
    resume_text: str,
    target_titles: list[str],
    priority_industries: list[str],
    priority_keywords: list[str],
    negative_companies: list[str] | None = None,
) -> str:
    """Assemble the per-job user prompt. Kept compact since we fire N of these per scrape."""
    description = (job.description or "").strip()
    if len(description) > MAX_DESCRIPTION_CHARS:
        description = description[:MAX_DESCRIPTION_CHARS] + "…"

    resume = (resume_text or "").strip()
    if len(resume) > 4000:
        resume = resume[:4000] + "…"

    priority_industries_line = (
        ", ".join(priority_industries) if priority_industries else "(none specified)"
    )
    priority_keywords_line = (
        ", ".join(priority_keywords) if priority_keywords else "(none specified)"
    )
    target_titles_line = ", ".join(target_titles) if target_titles else "(none specified)"

    # Optional negative-signal block. Included only when the user has flagged
    # companies as not-a-fit via feedback, so Haiku can down-weight similar
    # companies (not just exact matches — those are already filtered upstream).
    negative_line = ""
    if negative_companies:
        negative_line = (
            "\nNEGATIVE SIGNALS:\n"
            f"User has marked these companies as not-a-fit: {', '.join(negative_companies)}\n"
        )

    return (
        "CANDIDATE RESUME:\n"
        f"{resume or '(no resume text provided)'}\n\n"
        "CANDIDATE TARGETS:\n"
        f"- Desired titles: {target_titles_line}\n"
        f"- Priority industries: {priority_industries_line}\n"
        f"- Priority keywords: {priority_keywords_line}\n"
        f"{negative_line}\n"
        "JOB LISTING:\n"
        f"- Title: {job.title}\n"
        f"- Company: {job.company}\n"
        f"- Location: {job.location or '(not listed)'}\n"
        f"- Description:\n{description or '(no description scraped)'}\n\n"
        "Call the score_job tool with your evaluation."
    )


async def _score_one(
    client: "AsyncAnthropic",
    sem: asyncio.Semaphore,
    job: JobListing,
    resume_text: str,
    target_titles: list[str],
    priority_industries: list[str],
    priority_keywords: list[str],
    negative_companies: list[str] | None = None,
) -> dict[str, Any] | None:
    """Score a single job. Returns None on unrecoverable failure (logged)."""
    user_prompt = _build_user_prompt(
        job,
        resume_text,
        target_titles,
        priority_industries,
        priority_keywords,
        negative_companies,
    )

    for attempt in range(MAX_RETRIES + 1):
        try:
            async with sem:
                response = await client.messages.create(
                    model=MODEL,
                    max_tokens=512,
                    system=SYSTEM_PROMPT,
                    tools=[SCORE_TOOL],
                    tool_choice={"type": "tool", "name": "score_job"},
                    messages=[{"role": "user", "content": user_prompt}],
                )
            break
        except RateLimitError as e:
            if attempt >= MAX_RETRIES:
                logger.warning(f"Haiku rate-limited for job {job.id} after {attempt} retries: {e}")
                return None
            sleep_for = RETRY_SLEEP_SECONDS * (attempt + 1)
            logger.warning(
                f"Haiku 429 for job {job.id} (attempt {attempt + 1}/{MAX_RETRIES + 1}); "
                f"sleeping {sleep_for}s"
            )
            await asyncio.sleep(sleep_for)
        except APIStatusError as e:
            # Retry 5xx once; anything else is game-over for this job.
            status = getattr(e, "status_code", None)
            if status and 500 <= status < 600 and attempt < MAX_RETRIES:
                logger.warning(f"Haiku {status} for job {job.id} (attempt {attempt + 1}); retrying")
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            logger.warning(f"Haiku API error for job {job.id}: {e}")
            return None
        except Exception as e:
            logger.warning(f"Haiku call failed for job {job.id}: {e}")
            return None
    else:
        return None

    # Pull the tool_use block. tool_choice forced the call, but be defensive.
    tool_input: dict[str, Any] | None = None
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", None) == "score_job":
            tool_input = getattr(block, "input", None)
            break

    if not isinstance(tool_input, dict):
        logger.warning(f"Haiku returned no score_job tool call for job {job.id}")
        return None

    try:
        score = int(tool_input.get("score", 0))
        reasoning = str(tool_input.get("reasoning", "")).strip()
        matched_skills = [str(s).strip() for s in tool_input.get("matched_skills", []) if str(s).strip()]
        concerns = [str(s).strip() for s in tool_input.get("concerns", []) if str(s).strip()]
    except (TypeError, ValueError) as e:
        logger.warning(f"Haiku returned malformed payload for job {job.id}: {e}")
        return None

    # Clamp score into range as a belt-and-suspenders check — schema says 0-100
    # but the model is not strictly bound by it.
    score = max(0, min(100, score))

    return {
        "id": job.id,
        "score": score,
        "reasoning": reasoning,
        "matched_skills": matched_skills[:3],
        "concerns": concerns[:3],
    }


async def rescore_with_haiku(
    jobs: list[JobListing],
    resume_text: str,
    target_titles: list[str],
    priority_industries: list[str] | None = None,
    priority_keywords: list[str] | None = None,
    negative_companies: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Re-score a batch of jobs with Haiku.

    Args:
        jobs: The top-N heuristic-scored JobListings (typically 20).
        resume_text: Raw resume text from the user's profile.
        target_titles: Desired role titles.
        priority_industries: Industries the user prioritizes (optional).
        priority_keywords: Extra keywords the user prioritizes (optional).
        negative_companies: Companies the user has marked not-a-fit. Fed to
            Haiku as a negative signal so it down-weights similar companies
            (optional).

    Returns:
        A list of dicts, one per successfully scored job:
            {"id": <JobListing.id>, "score": int 0-100, "reasoning": str,
             "matched_skills": [str, ...], "concerns": [str, ...]}
        Failed jobs are omitted (not placeholders). Returns [] if the SDK is
        unavailable or ANTHROPIC_API_KEY is unset — the caller should fall back
        to the heuristic score in that case.
    """
    if not jobs:
        return []

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY not set — skipping Haiku rescore, heuristic scores only")
        return []

    if AsyncAnthropic is None:
        logger.warning("anthropic SDK not installed — skipping Haiku rescore")
        return []

    priority_industries = priority_industries or []
    priority_keywords = priority_keywords or []
    negative_companies = negative_companies or []

    client = AsyncAnthropic(api_key=api_key)
    sem = asyncio.Semaphore(MAX_CONCURRENCY)

    logger.info(
        f"Haiku rescore: {len(jobs)} jobs, concurrency={MAX_CONCURRENCY}, model={MODEL}"
    )

    tasks = [
        _score_one(
            client,
            sem,
            job,
            resume_text,
            target_titles,
            priority_industries,
            priority_keywords,
            negative_companies,
        )
        for job in jobs
    ]
    raw_results = await asyncio.gather(*tasks, return_exceptions=False)

    results = [r for r in raw_results if r is not None]
    logger.info(
        f"Haiku rescore done: {len(results)}/{len(jobs)} scored "
        f"({len(jobs) - len(results)} failed/skipped)"
    )
    return results
