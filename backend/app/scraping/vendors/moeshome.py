"""
Moe's Home vendor adapter — Magento 2.4 SPA.

Tier 1: Direct POST to mcprod.moeshome.com/graphql (Origin/Referer headers required).
Tier 2: Playwright — navigate the page, intercept the browser's own graphql response.
Tier 3: Graceful empty-field fallback if both fail.

URL path extraction: strip domain, pass the path to route(url: …).
  moeshome.com/furniture/verlaine-chair-olive-eq101327
    → url_path = "furniture/verlaine-chair-olive-eq101327"
  route() accepts any valid URL rewrite for the product.

Discovered GraphQL shape (2026-06-18):
  endpoint:    https://mcprod.moeshome.com/graphql
  name:        route.name
  description: route.description.html  (strip HTML tags)
  dimensions:  route.specifications[] where label=="General Dimensions"
               → value  (e.g. '23.5" W  X 31.0" D  X 32.0" H')
  images:      route.media_gallery[] sorted by position, disabled=false

  Note: products(filter:{url_key:{eq:…}}) is BROKEN on this instance —
  it ignores the filter and returns all products. Use route() instead.
"""

import logging
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx
from playwright.async_api import async_playwright

from app.scraping.base import ScrapeResult

log = logging.getLogger(__name__)

GRAPHQL_URL = "https://mcprod.moeshome.com/graphql"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": "https://www.moeshome.com",
    "Referer": "https://www.moeshome.com/",
}

_PRODUCT_QUERY = """
query GetMoesProduct($urlPath: String!) {
  route(url: $urlPath) {
    type
    ... on ProductInterface {
      name
      description { html }
      media_gallery {
        url
        position
        ... on ProductImage { disabled }
      }
      specifications {
        label
        value
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


def _url_path(url: str) -> str:
    if url.startswith("http"):
        return urlparse(url).path.lstrip("/")
    return url.lstrip("/")


def _url_key(url: str) -> str:
    """Last path segment — always a valid route even without the category prefix."""
    return _url_path(url).rstrip("/").rsplit("/", 1)[-1]


def _parse_route(route: dict) -> ScrapeResult:
    name = (route.get("name") or "").strip()

    description = _strip_html(route.get("description", {}).get("html", "") or "")

    dimensions = ""
    for spec in route.get("specifications", []):
        if spec.get("label") == "General Dimensions":
            dimensions = (spec.get("value") or "").strip()
            break

    images = [
        img["url"]
        for img in sorted(
            route.get("media_gallery", []),
            key=lambda x: x.get("position", 999),
        )
        if not img.get("disabled") and (img.get("url") or "").startswith("http")
    ]

    return ScrapeResult(name=name, dimensions=dimensions, description=description, images=images)


async def _query_route(path: str) -> dict | None:
    """POST a single route() query; return the route dict or None on failure/non-product."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                GRAPHQL_URL,
                json={"query": _PRODUCT_QUERY, "variables": {"urlPath": path}},
                headers=_HEADERS,
            )
            r.raise_for_status()
            data = r.json()
    except Exception as exc:
        log.warning("moeshome graphql request failed: %s", exc)
        return None
    route = data.get("data", {}).get("route")
    return route if (route and route.get("type") == "PRODUCT") else None


async def _direct_graphql(url: str) -> ScrapeResult | None:
    # Try full path first; if the category prefix isn't a valid rewrite, retry
    # with just the url_key (last segment), which route() always accepts.
    full_path = _url_path(url)
    route = await _query_route(full_path)
    if route is None and "/" in full_path:
        route = await _query_route(_url_key(url))
    if route is None:
        log.warning("moeshome direct graphql: no PRODUCT route for %r", url)
        return None
    return _parse_route(route)


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
                    route = body.get("data", {}).get("route")
                    if route and route.get("type") == "PRODUCT":
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
        route = resp.get("data", {}).get("route")
        if route:
            return _parse_route(route)

    log.warning("moeshome playwright: no graphql product data captured for %s", url)
    return ScrapeResult(name="", dimensions="", description="", images=[])


class MoesHomeScraper:
    domain = "moeshome.com"

    async def scrape(self, url: str) -> ScrapeResult:
        path = _url_path(url)

        result = await _direct_graphql(path)
        if result and result["name"] and result["images"]:
            return result

        log.info("moeshome: direct graphql insufficient, trying playwright for %s", url)
        return await _playwright_fallback(url)
