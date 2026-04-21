"""LinkedIn Job Scraper — Public Guest API, per-user titles/locations."""

import asyncio
import random
import re
from urllib.parse import quote_plus
from playwright.async_api import async_playwright
from loguru import logger
from models import JobListing

LINKEDIN_LOCATION_MAP = {
    "new york": "New York City Metropolitan Area",
    "nyc": "New York City Metropolitan Area",
    "washington": "Washington DC-Baltimore Area",
    "dc": "Washington DC-Baltimore Area",
    "atlanta": "Atlanta Metropolitan Area",
    "chicago": "Chicago, Illinois",
    "miami": "Miami, Florida",
    "los angeles": "Los Angeles Metropolitan Area",
    "la": "Los Angeles Metropolitan Area",
    "san francisco": "San Francisco Bay Area",
    "sf": "San Francisco Bay Area",
    "austin": "Austin, Texas",
    "remote": "United States",
}


def map_location(loc: str) -> str:
    lower = loc.lower().strip()
    return LINKEDIN_LOCATION_MAP.get(lower, loc)


def build_url(keywords: str, location: str, time_filter: str = "r86400") -> str:
    return (
        f"https://www.linkedin.com/jobs/search/?"
        f"keywords={quote_plus(keywords)}&location={quote_plus(location)}"
        f"&f_TPR={time_filter}&position=1&pageNum=0"
    )


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


async def scroll_and_load(page, max_scrolls=3):
    for _ in range(max_scrolls):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(1.5)
        btn = await page.query_selector(
            "button.infinite-scroller__show-more-button, button[aria-label='See more jobs']"
        )
        if btn:
            try:
                await btn.click()
                await asyncio.sleep(2)
            except Exception:
                pass


async def extract_cards(page) -> list[dict]:
    jobs = []
    selectors = [
        "ul.jobs-search__results-list > li",
        ".base-search-card",
        "div.base-card",
    ]
    cards = []
    for sel in selectors:
        cards = await page.query_selector_all(sel)
        if cards:
            break

    for card in cards:
        try:
            title_el = await card.query_selector("h3.base-search-card__title, h3[class*='title']")
            company_el = await card.query_selector("h4.base-search-card__subtitle, a[class*='subtitle']")
            loc_el = await card.query_selector("span.job-search-card__location, span[class*='location']")
            link_el = await card.query_selector("a[href*='/jobs/view/'], a.base-card__full-link")

            title = (await title_el.inner_text()).strip() if title_el else ""
            company = (await company_el.inner_text()).strip() if company_el else ""
            location = (await loc_el.inner_text()).strip() if loc_el else ""
            href = (await link_el.get_attribute("href") or "") if link_el else ""

            if title:
                jobs.append({"title": title, "company": company, "location": location, "url": href.split("?")[0]})
        except Exception:
            pass
    return jobs


async def get_detail(page, url: str) -> dict:
    if not url:
        return {"description": "", "salary_range": ""}
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=15000)
        await asyncio.sleep(random.uniform(2, 4))

        show_more = await page.query_selector("button.show-more-less-html__button")
        if show_more:
            try:
                await show_more.click()
                await asyncio.sleep(0.5)
            except Exception:
                pass

        for sel in [".show-more-less-html__markup", ".description__text", "section.description"]:
            el = await page.query_selector(sel)
            if el:
                text = await el.inner_text()
                if len(text) > 100:
                    return {"description": text.strip(), "salary_range": ""}

        return {"description": "", "salary_range": ""}
    except Exception as e:
        logger.warning(f"Detail failed for {url}: {e}")
        return {"description": "", "salary_range": ""}


async def scrape(titles: list[str], locations: list[str], limit: int = 20) -> list[JobListing]:
    logger.info(f"LinkedIn: scraping {len(titles)} titles x {len(locations)} locations")
    all_jobs = []
    seen = set()

    mapped_locs = list(set(map_location(loc) for loc in locations))

    pw = await async_playwright().start()
    browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
    context = await browser.new_context(
        viewport={"width": 1920, "height": 1080},
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    )
    page = await context.new_page()

    try:
        for title in titles:
            for location in mapped_locs:
                if len(all_jobs) >= limit:
                    break
                url = build_url(title, location)
                logger.info(f"  '{title}' in {location}")
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=20000)
                    await asyncio.sleep(random.uniform(2, 4))
                    await scroll_and_load(page)

                    cards = await extract_cards(page)
                    new_cards = [c for c in cards if c["url"] not in seen]
                    for c in new_cards:
                        seen.add(c["url"])

                    logger.info(f"    {len(cards)} cards, {len(new_cards)} new")

                    for card in new_cards[:5]:
                        if len(all_jobs) >= limit:
                            break
                        await asyncio.sleep(random.uniform(2, 4))
                        detail = await get_detail(page, card["url"])
                        yoe = parse_years(detail["description"]) if detail["description"] else None

                        job = JobListing(
                            source="LinkedIn",
                            title=card["title"],
                            company=card["company"],
                            location=card["location"],
                            is_remote="remote" in card["location"].lower(),
                            description=detail["description"],
                            years_experience=yoe,
                            salary_range=detail["salary_range"],
                            apply_url=card["url"],
                            listing_url=card["url"],
                        )
                        job.generate_id()
                        all_jobs.append(job)

                except Exception as e:
                    logger.error(f"    Failed: {e}")

                await asyncio.sleep(random.uniform(2, 4))
    finally:
        await browser.close()
        await pw.stop()

    logger.info(f"LinkedIn done: {len(all_jobs)} jobs")
    return all_jobs
