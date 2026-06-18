"""
Uttermost vendor adapter — Magento/Venia PWA.

Tier 1: Direct POST to uttermost.com/graphql (no auth required).
Tier 2: Playwright — navigate the page, intercept the browser's own graphql response.
Tier 3: Graceful empty-field fallback if both fail.

URL-key extraction: last path segment, e.g.
  uttermost.com/furniture/chairs/my-chair-r12345  →  my-chair-r12345

Discovered GraphQL shape (2026-06-18):
  endpoint:           https://uttermost.com/graphql
  name:               items[0].name
  description:        items[0].description.html  (strip HTML tags)
  dimensions:         items[0].custom_attributes where code=="size_desc"
                      → entered_attribute_value.value  (e.g. "51 W X 18 H X 17 D (in)")
  images:             items[0].media_gallery[]  sorted by position, disabled=false
"""

import logging
from html.parser import HTMLParser

import httpx
from playwright.async_api import async_playwright

from app.scraping.base import ScrapeResult

log = logging.getLogger(__name__)

GRAPHQL_URL = "https://uttermost.com/graphql"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_PRODUCT_QUERY = """
query GetUttermost($urlKey: String!) {
  products(filter: { url_key: { eq: $urlKey } }) {
    items {
      name
      description { html }
      media_gallery { url position disabled }
      custom_attributes {
        attribute_metadata { code }
        entered_attribute_value { value }
      }
    }
  }
}
"""


class _TagStripper(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    def result(self) -> str:
        return " ".join(self._parts).strip()


def _strip_html(html: str) -> str:
    p = _TagStripper()
    p.feed(html)
    return p.result()


def _url_key(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1]


def _parse_graphql_item(item: dict) -> ScrapeResult:
    name = (item.get("name") or "").strip()

    description = _strip_html(item.get("description", {}).get("html", "") or "")

    dimensions = ""
    for attr in item.get("custom_attributes", []):
        if (attr.get("attribute_metadata") or {}).get("code") == "size_desc":
            dimensions = ((attr.get("entered_attribute_value") or {}).get("value") or "")
            break

    images = [
        img["url"]
        for img in sorted(
            item.get("media_gallery", []),
            key=lambda x: x.get("position", 999),
        )
        if not img.get("disabled") and (img.get("url") or "").startswith("http")
    ]

    return ScrapeResult(name=name, dimensions=dimensions, description=description, images=images)


async def _direct_graphql(url_key: str) -> ScrapeResult | None:
    """Return parsed ScrapeResult via direct GraphQL call, or None on failure."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                GRAPHQL_URL,
                json={"query": _PRODUCT_QUERY, "variables": {"urlKey": url_key}},
                headers={
                    "User-Agent": BROWSER_UA,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            r.raise_for_status()
            data = r.json()
    except Exception as exc:
        log.warning("uttermost direct graphql failed: %s", exc)
        return None

    items = data.get("data", {}).get("products", {}).get("items", [])
    if not items:
        log.warning("uttermost graphql: no items for url_key=%r", url_key)
        return None

    return _parse_graphql_item(items[0])


async def _playwright_fallback(url: str) -> ScrapeResult:
    """Render the page and intercept the browser's own graphql response."""
    captured: list[dict] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            channel="chrome",
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            user_agent=BROWSER_UA,
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        page = await ctx.new_page()

        async def _on_response(response):
            if "/graphql" in response.url and response.status == 200:
                try:
                    body = await response.json()
                    if body.get("data", {}).get("products", {}).get("items"):
                        captured.append(body)
                except Exception:
                    pass

        page.on("response", _on_response)

        try:
            await page.goto(url, wait_until="networkidle", timeout=45_000)
        except Exception:
            await page.wait_for_timeout(5_000)

        await browser.close()

    for resp in captured:
        items = resp.get("data", {}).get("products", {}).get("items", [])
        if items:
            return _parse_graphql_item(items[0])

    log.warning("uttermost playwright: no graphql product data captured for %s", url)
    return ScrapeResult(name="", dimensions="", description="", images=[])


class UtterMostScraper:
    domain = "uttermost.com"

    async def scrape(self, url: str) -> ScrapeResult:
        key = _url_key(url)

        result = await _direct_graphql(key)
        if result and result["name"] and result["images"]:
            return result

        log.info("uttermost: direct graphql insufficient, trying playwright for %s", url)
        return await _playwright_fallback(url)
