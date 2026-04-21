"""BuiltIn Job Scraper — per-user titles/locations."""

import asyncio
import random
import re
from playwright.async_api import async_playwright
from loguru import logger
from models import JobListing

# Map user locations to BuiltIn city subdomains
BUILTIN_CITY_MAP = {
    "new york": ("builtinnyc.com", "NYC"),
    "nyc": ("builtinnyc.com", "NYC"),
    "chicago": ("builtinchicago.com", "Chicago"),
    "los angeles": ("builtinla.com", "LA"),
    "la": ("builtinla.com", "LA"),
    "san francisco": ("builtinsf.com", "SF"),
    "sf": ("builtinsf.com", "SF"),
    "austin": ("builtinaustin.com", "Austin"),
    "remote": ("builtin.com", "Remote"),
}


def map_builtin_location(loc: str) -> list[tuple[str, str, bool]]:
    """Return list of (domain, label, is_remote) for a user location."""
    lower = loc.lower().strip()
    if lower in BUILTIN_CITY_MAP:
        domain, label = BUILTIN_CITY_MAP[lower]
        results = [(domain, label, lower == "remote")]
        # Also add remote variant for non-remote cities
        if lower != "remote":
            results.append((domain, f"{label} Remote", True))
        return results
    # Unknown city — use national builtin.com
    return [("builtin.com", loc, False)]


def build_search_path(title: str, is_remote: bool) -> str:
    """Build a BuiltIn search path from a job title."""
    slug = title.lower().replace(" ", "-")
    if is_remote:
        return f"/jobs/remote/search/{slug}"
    return f"/jobs/search/{slug}"


def parse_years(text: str) -> int | None:
    patterns = [
        r'(\d+)\+?\s*(?:years?|yrs?)\s*(?:of)?\s*(?:experience|exp)',
        r'(\d+)\s*-\s*(\d+)\s*(?:years?|yrs?)',
    ]
    years = []
    for p in patterns:
        for m in re.findall(p, text.lower()):
            if isinstance(m, tuple):
                years.extend(int(y) for y in m if y)
            else:
                years.append(int(m))
    return max(years) if years else None


async def extract_builtin_jobs(page, base_url: str) -> list[dict]:
    """Extract job cards from BuiltIn DOM."""
    try:
        return await page.evaluate("""
            (baseUrl) => {
                const results = [];
                const seen = new Set();
                const titleLinks = document.querySelectorAll('a[href*="/job/"]');

                titleLinks.forEach(link => {
                    const href = link.href || '';
                    if (href.includes('/jobs/') || seen.has(href)) return;
                    seen.add(href);

                    const title = link.innerText.trim();
                    if (!title || title.length > 200 || title.length < 3) return;
                    if (/^(Easy Apply|Save|Saved|Apply)$/i.test(title)) return;

                    let card = link;
                    for (let i = 0; i < 8; i++) {
                        card = card.parentElement;
                        if (!card) break;
                        if (card.innerText.length > 100) break;
                    }
                    if (!card) return;

                    const cardText = card.innerText;
                    const lines = cardText.split('\\n').map(l => l.trim()).filter(l => l.length > 0);

                    let company = '';
                    let location = '';
                    let salary = '';
                    let workType = '';
                    let daysAgo = -1;

                    const companyLink = card.querySelector('a[href*="/company/"]');
                    if (companyLink) company = companyLink.innerText.trim();

                    for (const line of lines) {
                        if (/\\d+K.*Annually/i.test(line) || /\\$[\\d,]+\\s*-\\s*\\$[\\d,]+/.test(line)) {
                            salary = line; continue;
                        }
                        if (/^(In-Office|Hybrid|Remote|Onsite)$/i.test(line)) {
                            workType = line; continue;
                        }
                        if (/^[A-Z][a-z]+.*,\\s*[A-Z]{2}$/.test(line) && !location) {
                            location = line; continue;
                        }
                        const daysMatch = line.match(/(\\d+)\\s*Days?\\s*Ago/i);
                        const hoursMatch = line.match(/(\\d+)\\s*Hours?\\s*Ago/i);
                        if (daysMatch) { daysAgo = parseInt(daysMatch[1]); continue; }
                        if (hoursMatch) { daysAgo = 0; continue; }
                    }

                    if (!company) {
                        const titleIndex = lines.indexOf(title);
                        if (titleIndex > 0) {
                            for (let i = titleIndex - 1; i >= 0; i--) {
                                const c = lines[i];
                                if (c.length > 1 && c.length < 100 &&
                                    !/ago$/i.test(c) && !/^(Save|Easy Apply|Reposted|Saved)$/i.test(c)) {
                                    company = c; break;
                                }
                            }
                        }
                    }

                    results.push({
                        title, company, location: location || workType,
                        salary, url: href, daysAgo,
                    });
                });
                return results;
            }
        """, base_url)
    except Exception as e:
        logger.debug(f"  Extraction failed: {e}")
        return []


async def scrape(titles: list[str], locations: list[str], limit: int = 20) -> list[JobListing]:
    logger.info(f"BuiltIn: scraping {len(titles)} titles x {len(locations)} locations")
    all_jobs = []
    seen = set()

    # Build search combos: (domain, label, is_remote) x titles
    combos = []
    for loc in locations:
        combos.extend(map_builtin_location(loc))
    # Dedupe domains
    combos = list({(d, l, r) for d, l, r in combos})

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
    context = await browser.new_context(
        viewport={"width": 1440, "height": 900},
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )
    page = await context.new_page()

    try:
        for title in titles:
            for domain, label, is_remote in combos:
                if len(all_jobs) >= limit:
                    break

                base_url = f"https://www.{domain}"
                search_path = build_search_path(title, is_remote)
                url = f"{base_url}{search_path}"
                logger.info(f"  '{title}' on {label}")

                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                    await asyncio.sleep(4)

                    for _ in range(3):
                        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        await asyncio.sleep(1.5)

                    cards = await extract_builtin_jobs(page, base_url)
                    new_count = 0

                    for card in cards:
                        if len(all_jobs) >= limit:
                            break
                        key = f"{card.get('title', '')}|{card.get('company', '')}"
                        if key in seen or not card.get("title"):
                            continue
                        seen.add(key)

                        # Skip stale listings (>7 days)
                        if card.get("daysAgo", -1) > 7:
                            continue

                        job = JobListing(
                            source="BuiltIn",
                            title=card["title"],
                            company=card.get("company", ""),
                            location=card.get("location", label),
                            is_remote=is_remote or "remote" in card.get("location", "").lower(),
                            salary_range=card.get("salary", ""),
                            apply_url=card.get("url", ""),
                            listing_url=card.get("url", ""),
                        )
                        job.generate_id()
                        all_jobs.append(job)
                        new_count += 1

                    logger.info(f"    {len(cards)} cards, {new_count} new")

                except Exception as e:
                    logger.error(f"    Failed: {e}")

                await asyncio.sleep(random.uniform(2, 4))
    finally:
        await browser.close()
        await pw.stop()

    logger.info(f"BuiltIn done: {len(all_jobs)} jobs")
    return all_jobs
