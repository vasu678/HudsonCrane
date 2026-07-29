"""
Surya vendor adapter — Shopify storefront.

Tier 1: Shopify Product JSON API  ({url}.json) — fastest, no JS needed.
Tier 2: Playwright — render page, extract from JSON-LD and spec section.
Tier 3: Graceful empty-field fallback.

URL format:  https://www.surya.com/products/product-slug
Shopify API: https://www.surya.com/products/product-slug.json
"""

import logging
import re
from html.parser import HTMLParser

import httpx
from playwright.async_api import async_playwright

from app.scraping.base import ScrapeResult

log = logging.getLogger(__name__)

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


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


def _product_slug(url: str) -> str:
    """Extract the product slug from a Surya product URL."""
    # e.g. https://www.surya.com/products/bntu-2300-burnett-armchair → bntu-2300-burnett-armchair
    url = url.rstrip("/")
    slug = url.rsplit("/", 1)[-1]
    # Strip query string if any
    return slug.split("?")[0]


def _parse_shopify_json(data: dict) -> ScrapeResult:
    """Parse Shopify Product JSON API response."""
    product = data.get("product", {})
    name = (product.get("title") or "").strip()

    # Strip HTML from body
    raw_desc = product.get("body_html") or ""
    description = re.sub(r"\s{2,}", " ", _strip_html(raw_desc)).strip()
    if len(description) > 300:
        description = description[:300]

    # Images — all product images sorted by position
    images = [
        img["src"]
        for img in sorted(
            product.get("images", []),
            key=lambda x: x.get("position", 999),
        )
        if (img.get("src") or "").startswith("http")
    ]

    # Dimensions — Shopify doesn't have a standard field; look in metafields,
    # variants, or embedded text in body_html.
    dimensions = _extract_dims_from_html(raw_desc)

    return ScrapeResult(
        name=name,
        dimensions=dimensions,
        description=description,
        images=images,
    )


def _extract_dims_from_html(html: str) -> str:
    """Try to pull a dimension string from product body HTML."""
    text = _strip_html(html)
    # Pattern: NN" W x NN" D x NN" H or W: NN" D: NN" H: NN"
    patterns = [
        r'\d{1,3}(?:\.\d{1,2})?\s*"\s*[WwLl]\s*[xX×]\s*\d{1,3}(?:\.\d{1,2})?\s*"\s*[Dd]\s*[xX×]\s*\d{1,3}(?:\.\d{1,2})?\s*"\s*[Hh]',
        r'[Ww]\s*\d{1,3}(?:\.\d{1,2})?\s*"\s*[xX×]\s*[Dd]\s*\d{1,3}(?:\.\d{1,2})?\s*"\s*[xX×]\s*[Hh]\s*\d{1,3}(?:\.\d{1,2})?\s*"',
        r'Overall\s*[:\-]\s*[^\n\r]{5,60}',
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(0).strip()
    return ""


async def _shopify_api(url: str) -> ScrapeResult | None:
    """Attempt Shopify Product JSON API: GET {product_url}.json"""
    slug = _product_slug(url)
    api_url = f"https://www.surya.com/products/{slug}.json"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                api_url,
                headers={
                    "User-Agent": BROWSER_UA,
                    "Accept": "application/json",
                },
                follow_redirects=True,
            )
            r.raise_for_status()
            data = r.json()
    except Exception as exc:
        log.warning("surya shopify api failed: %s", exc)
        return None

    if not data.get("product", {}).get("title"):
        log.warning("surya shopify api: no product in response for %s", url)
        return None

    return _parse_shopify_json(data)


async def _playwright_fallback(url: str) -> ScrapeResult:
    """Render the Surya product page and extract from rendered DOM."""
    import json as _json

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

        try:
            await page.goto(url, wait_until="networkidle", timeout=45_000)
        except Exception:
            await page.wait_for_timeout(5_000)

        # Extract via JSON-LD
        ld_json = await page.evaluate("""() => {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const s of scripts) {
                try {
                    const d = JSON.parse(s.textContent);
                    const items = Array.isArray(d) ? d : [d];
                    for (const item of items) {
                        if (item['@type'] === 'Product' && item.name) return item;
                    }
                } catch(_) {}
            }
            return null;
        }""")

        name = ""
        description = ""
        dimensions = ""
        images: list[str] = []

        if ld_json:
            name = (ld_json.get("name") or "").strip()
            raw_desc = ld_json.get("description") or ""
            description = re.sub(r"\s{2,}", " ", _strip_html(raw_desc)).strip()[:300]
            raw_imgs = ld_json.get("image") or []
            if isinstance(raw_imgs, str):
                raw_imgs = [raw_imgs]
            images = [u for u in raw_imgs if isinstance(u, str) and u.startswith("http")]

        if not name:
            name = await page.title()
            name = name.split("|")[0].strip()

        # Get dimensions from spec section
        if not dimensions:
            dims = await page.evaluate("""() => {
                const labels = ['overall', 'overall dimensions', 'dimensions', 'product dimensions', 'size'];
                for (const el of document.querySelectorAll('*')) {
                    if (el.children.length > 0) continue;
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (!labels.includes(t)) continue;
                    // Try next sibling
                    let sib = el.nextElementSibling;
                    if (sib && /\\d/.test(sib.textContent) && sib.textContent.trim().length < 100)
                        return sib.textContent.trim();
                    // Try parent's next sibling
                    const parent = el.parentElement;
                    if (parent) {
                        sib = parent.nextElementSibling;
                        if (sib && /\\d/.test(sib.textContent) && sib.textContent.trim().length < 100)
                            return sib.textContent.trim();
                    }
                }
                return '';
            }""")
            dimensions = dims or ""

        # Get product images from gallery if JSON-LD was sparse
        if len(images) < 2:
            gallery_imgs = await page.evaluate("""() => {
                const imgs = [];
                const seen = new Set();
                document.querySelectorAll('img').forEach(img => {
                    const src = img.currentSrc || img.src || '';
                    if (!src.startsWith('http')) return;
                    if (/\\.svg(\\?|$)/i.test(src)) return;
                    const rect = img.getBoundingClientRect();
                    if (rect.width > 0 && rect.width < 100) return;
                    if (!seen.has(src)) { seen.add(src); imgs.push(src); }
                });
                return imgs.slice(0, 12);
            }""")
            seen_imgs = set(images)
            for img in gallery_imgs:
                if img not in seen_imgs:
                    images.append(img)
                    seen_imgs.add(img)

        await browser.close()

    return ScrapeResult(
        name=name,
        dimensions=dimensions,
        description=description,
        images=images[:12],
    )


class SuryaScraper:
    domain = "surya.com"

    async def scrape(self, url: str) -> ScrapeResult:
        # Try Shopify JSON API first (fast, no browser needed)
        result = await _shopify_api(url)
        if result and result["name"] and result["images"]:
            return result

        log.info("surya: shopify api insufficient, trying playwright for %s", url)
        return await _playwright_fallback(url)
