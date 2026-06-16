import html as html_mod
import json

import httpx
from bs4 import BeautifulSoup

from app.scraping.base import ScrapeResult

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class FourHandsScraper:
    domain = "fourhands.com"

    async def scrape(self, url: str) -> ScrapeResult:
        r = httpx.get(
            url,
            headers={"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"},
            follow_redirects=True,
            timeout=15,
        )
        r.raise_for_status()
        return _parse(r.text, url)


def _parse(html: str, url: str) -> ScrapeResult:
    soup = BeautifulSoup(html, "lxml")
    tag = soup.find("fh-product-detail")
    if not tag:
        raise ValueError(
            f"Four Hands: <fh-product-detail> component not found on {url}. "
            "The site structure may have changed — check the page source."
        )

    raw = tag.get("v-bind", "")
    if not raw:
        raise ValueError(
            f"Four Hands: <fh-product-detail> found but v-bind attribute is empty on {url}."
        )

    # BeautifulSoup decodes HTML entities; html_mod.unescape handles any residual encoding
    decoded = html_mod.unescape(raw) if "&quot;" in raw else raw
    try:
        obj = json.loads(decoded)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Four Hands: failed to parse product JSON on {url}: {e}"
        ) from e

    product = obj.get("product", {})
    name = product.get("name", "").strip()
    if not name:
        raise ValueError(f"Four Hands: product name not found in JSON on {url}.")

    active_sku_id = obj.get("activeSku", "")
    skus = product.get("skus", [])
    if not skus:
        raise ValueError(f"Four Hands: no SKUs found in product JSON on {url}.")

    sku = next((s for s in skus if s.get("skuNumber") == active_sku_id), skus[0])

    dimensions = sku.get("dimensionsImperial", "")
    description = sku.get("description", "") or ""

    images = [
        m["largeUrl"]
        for m in sku.get("media", [])
        if m.get("type") == "image" and m.get("largeUrl", "").startswith("http")
    ]

    return ScrapeResult(
        name=name,
        dimensions=dimensions,
        description=description,
        images=images,
    )
