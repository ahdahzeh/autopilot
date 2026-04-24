"""Per-source hit-rate logger.

Writes one row per source to `public.source_stats` after each scrape pass so we
can track which sources actually return usable jobs vs. which ones are timing
out, returning empty, or getting deduped to zero.

Designed to be best-effort: any failure here (table missing, transient 5xx,
bad payload) logs a warning and returns. The main /scrape response is NEVER
affected by a stats-write error.

Mirrors the `haiku_columns_available()` probe pattern in main.py — we check
once per cold start whether the table exists, and if not we skip writes for
the life of the process.
"""

from loguru import logger


# Probe once per cold start. Migration 017 creates `source_stats`, but we
# don't want a pre-migration Railway instance to spam warnings for every
# scrape, and we don't want a missing table to leak stack traces into logs.
_source_stats_checked = False
_source_stats_available = False


def source_stats_available(supabase) -> bool:
    """Return True if `public.source_stats` exists and is writable.

    Cached for the life of the process. First call does a HEAD select; any
    exception is interpreted as "table not available, skip writes."
    """
    global _source_stats_checked, _source_stats_available
    if _source_stats_checked:
        return _source_stats_available
    try:
        supabase.table("source_stats").select("source", count=None, head=True).limit(1).execute()
        _source_stats_available = True
        logger.info("source_stats table detected — per-source hit rates will be logged")
    except Exception as e:
        _source_stats_available = False
        logger.warning(f"source_stats table unavailable ({e}) — skipping hit-rate logging")
    _source_stats_checked = True
    return _source_stats_available


def write_source_stats(
    supabase,
    user_id: str,
    rows: list[dict],
) -> None:
    """Best-effort batch insert of per-source stats.

    `rows` is a list of dicts with keys: source, jobs_returned, jobs_after_dedup,
    jobs_inserted, error. `user_id` and `scraped_at` (server default now()) are
    attached here. Failures are swallowed — caller should not await a meaningful
    return value.
    """
    if not rows:
        return
    if not source_stats_available(supabase):
        return

    payload = [
        {
            "user_id": user_id,
            "source": r.get("source", ""),
            "jobs_returned": int(r.get("jobs_returned", 0) or 0),
            "jobs_after_dedup": int(r.get("jobs_after_dedup", 0) or 0),
            "jobs_inserted": int(r.get("jobs_inserted", 0) or 0),
            "error": r.get("error"),
        }
        for r in rows
    ]

    try:
        supabase.table("source_stats").insert(payload).execute()
        logger.info(f"source_stats: wrote {len(payload)} rows for user {user_id}")
    except Exception as e:
        # Never let a stats failure bubble up into the /scrape response.
        logger.warning(f"source_stats write failed ({len(payload)} rows): {e}")
