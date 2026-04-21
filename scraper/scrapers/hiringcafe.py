"""HiringCafe Job Scraper — per-user titles, client-side Next.js app."""

import asyncio
import json
import random
import re
from urllib.parse import quote
from playwright.async_api import async_playwright
from loguru import logger
from models import JobListing


def build_search_url(query: str, days: int = 7, location: str = "") -> str:
    search_state = {
        "query": query,
        "sortBy": "date",
        "dateFetchedPastNDays": days,
    }
    if location:
        search_state["location"] = location
    state_json = json.dumps(search_state, separators=(",", ":"))
    return f"https://hiring.cafe/?searchState={quote(state_json)}"


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


async def extract_jobs_from_page(page) -> list[dict]:
    """Extract jobs from DOM or __NEXT_DATA__."""
    jobs = []

    # Strategy 1: __NEXT_DATA__
    try:
        next_data = await page.evaluate("""
            () => {
                const el = document.querySelector('#__NEXT_DATA__');
                if (el) return JSON.parse(el.textContent);
                return null;
            }
        """)
        if next_data:
            props = next_data.get("props", {}).get("pageProps", {})
            job_list = props.get("jobs", []) or props.get("results", []) or props.get("listings", [])
            if job_list:
                for j in job_list:
                    jobs.append({
                        "title": j.get("title", ""),
                        "company": j.get("source", "") or j.get("company", "") or j.get("company_name", ""),
                        "location": j.get("location", "") or ", ".join(j.get("locations", [])),
                        "url": j.get("apply_url", "") or j.get("url", ""),
                        "description": j.get("description_clean", "") or j.get("description", ""),
                        "salary_min": j.get("salary_min"),
                        "salary_max": j.get("salary_max"),
                        "remote": j.get("remote", False),
                    })
                return jobs
    except Exception:
        pass

    # Strategy 2: DOM extraction
    try:
        elements = await page.evaluate("""
            () => {
                const results = [];
                const links = document.querySelectorAll('a[href*="/job/"], a[href*="apply"], a[href*="lever.co"], a[href*="greenhouse.io"], a[href*="ashbyhq.com"]');
                links.forEach(link => {
                    const card = link.closest('tr, div[class*="card"], div[class*="Card"], article, li');
                    if (card) {
                        const texts = card.innerText.split('\\n').map(t => t.trim()).filter(t => t.length > 0);
                        results.push({
                            href: link.href,
                            texts: texts.slice(0, 10),
                            fullText: card.innerText.substring(0, 500),
                        });
                    }
                });
                return results;
            }
        """)
        for el in elements:
            texts = el.get("texts", [])
            if len(texts) >= 2:
                jobs.append({
                    "title": texts[0],
                    "company": texts[1] if len(texts) > 1 else "",
                    "location": texts[2] if len(texts) > 2 else "",
                    "url": el.get("href", ""),
                    "description": el.get("fullText", ""),
                    "remote": "remote" in el.get("fullText", "").lower(),
                })
    except Exception:
        pass

    return jobs


async def scrape(titles: list[str], locations: list[str], limit: int = 20) -> list[JobListing]:
    logger.info(f"HiringCafe: scraping {len(titles)} titles")
    all_jobs = []
    seen_urls = set()

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(
        headless=True,
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    )
    context = await browser.new_context(
        viewport={"width": 1920, "height": 1080},
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )

    # Intercept API responses
    api_jobs = []

    async def handle_response(response):
        url = response.url
        if any(kw in url for kw in ["search", "jobs", "listings", "api"]):
            try:
                if "application/json" in (response.headers.get("content-type", "")):
                    data = await response.json()
                    if isinstance(data, list):
                        api_jobs.extend(data)
                    elif isinstance(data, dict):
                        for key in ["results", "jobs", "listings", "data", "items"]:
                            if key in data and isinstance(data[key], list):
                                api_jobs.extend(data[key])
            except Exception:
                pass

    page = await context.new_page()
    page.on("response", handle_response)

    try:
        for title in titles:
            if len(all_jobs) >= limit:
                break

            # HiringCafe doesn't filter by location well — search by title only
            url = build_search_url(title, days=7)
            logger.info(f"  Searching: '{title}'")

            try:
                await page.goto(url, wait_until="networkidle", timeout=30000)
                await asyncio.sleep(3)

                # Check for Cloudflare
                page_text = await page.inner_text("body")
                if "checking your browser" in page_text.lower():
                    logger.warning("  Cloudflare detected, waiting...")
                    await asyncio.sleep(10)

                # Process intercepted API jobs
                for item in api_jobs:
                    if len(all_jobs) >= limit:
                        break
                    if not isinstance(item, dict):
                        continue
                    title_val = item.get("title", "") or item.get("job_title", "")
                    apply_url = item.get("apply_url", "") or item.get("url", "")
                    if title_val and apply_url and apply_url not in seen_urls:
                        seen_urls.add(apply_url)
                        salary = ""
                        if item.get("salary_min") and item.get("salary_max"):
                            salary = f"${item['salary_min']:,} - ${item['salary_max']:,}"
                        job = JobListing(
                            source="HiringCafe",
                            title=title_val,
                            company=item.get("source", "") or item.get("company", ""),
                            location=item.get("location", ""),
                            is_remote=item.get("remote", False),
                            description=(item.get("description_clean", "") or item.get("description", ""))[:3000],
                            salary_range=salary,
                            apply_url=apply_url,
                            listing_url=apply_url,
                        )
                        job.generate_id()
                        all_jobs.append(job)
                api_jobs.clear()

                # Also try DOM extraction
                dom_jobs = await extract_jobs_from_page(page)
                for raw in dom_jobs:
                    if len(all_jobs) >= limit:
                        break
                    url_val = raw.get("url", "")
                    if url_val and url_val not in seen_urls:
                        seen_urls.add(url_val)
                        salary = ""
                        if raw.get("salary_min") and raw.get("salary_max"):
                            salary = f"${raw['salary_min']:,} - ${raw['salary_max']:,}"
                        job = JobListing(
                            source="HiringCafe",
                            title=raw.get("title", ""),
                            company=raw.get("company", ""),
                            location=raw.get("location", ""),
                            is_remote=raw.get("remote", False),
                            description=raw.get("description", "")[:3000],
                            salary_range=salary,
                            apply_url=url_val,
                            listing_url=url_val,
                        )
                        job.generate_id()
                        all_jobs.append(job)

                logger.info(f"    Total so far: {len(all_jobs)}")

            except Exception as e:
                logger.error(f"    Failed: {e}")

            await asyncio.sleep(random.uniform(2, 4))

    finally:
        await browser.close()
        await pw.stop()

    logger.info(f"HiringCafe done: {len(all_jobs)} jobs")
    return all_jobs
