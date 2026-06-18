"""
Probe script — Moe's Home GraphQL endpoint investigation.

Findings (2026-06-18):
  Endpoint:    POST https://mcprod.moeshome.com/graphql
               (www.moeshome.com/graphql is the SPA shell — 405 on POST)
  Auth:        None — but Origin/Referer headers from www.moeshome.com are needed
  URL-key:     path portion of the product URL (no leading slash, no domain)
               e.g. moeshome.com/furniture/verlaine-chair-olive-eq101327
                    → url_path = "furniture/verlaine-chair-olive-eq101327"
               The route() query accepts any valid URL rewrite path for the product.

  Query approach:
    Use route(url: $urlPath) — Magento 2.4+ resolver.
    products(filter: { url_key: { eq: ... } }) is broken on this instance
    (ignores the filter and returns all products).

  Key response fields:
    data.route.name                              → product name
    data.route.description.html                  → description (strip HTML tags)
    data.route.media_gallery[]                   → images sorted by position
    data.route.specifications[]
      where label == "General Dimensions"
      → value (e.g. '23.5" W  X 31.0" D  X 32.0" H ')

Run: cd backend && ../.venv/bin/python scripts/probe_moeshome_graphql.py [url_or_path]
"""

import sys
import json
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx

GRAPHQL_URL = "https://mcprod.moeshome.com/graphql"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": BROWSER_UA,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Origin": "https://www.moeshome.com",
    "Referer": "https://www.moeshome.com/",
}

PRODUCT_QUERY = """
query GetMoesProduct($urlPath: String!) {
  route(url: $urlPath) {
    type
    ... on ProductInterface {
      name
      sku
      url_key
      description {
        html
      }
      media_gallery {
        url
        position
        ... on ProductImage {
          disabled
        }
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
    """Extract the relative path from a full URL or return as-is if already a path."""
    if url.startswith("http"):
        parsed = urlparse(url)
        return parsed.path.lstrip("/")
    return url.lstrip("/")


def probe(url: str) -> dict:
    url_path = _url_path(url)
    r = httpx.post(
        GRAPHQL_URL,
        json={"query": PRODUCT_QUERY, "variables": {"urlPath": url_path}},
        headers=HEADERS,
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()

    route = data.get("data", {}).get("route")
    if not route or route.get("type") != "PRODUCT":
        raise ValueError(f"No product found for url_path={url_path!r}, got: {route}")

    # --- dimensions from specifications ---
    dimensions = ""
    for spec in route.get("specifications", []):
        if spec.get("label") == "General Dimensions":
            dimensions = (spec.get("value") or "").strip()
            break

    # --- images: non-disabled, sorted by position ---
    images = [
        img["url"]
        for img in sorted(route.get("media_gallery", []), key=lambda x: x.get("position", 999))
        if not img.get("disabled") and (img.get("url") or "").startswith("http")
    ]

    return {
        "name": (route.get("name") or "").strip(),
        "sku": route.get("sku", ""),
        "url_key": route.get("url_key", ""),
        "dimensions": dimensions,
        "description": _strip_html(route.get("description", {}).get("html", "") or ""),
        "images": images,
    }


if __name__ == "__main__":
    default = "furniture/verlaine-chair-olive-eq101327"
    url = sys.argv[1] if len(sys.argv) > 1 else default
    print(f"Probing: {url!r}")
    result = probe(url)
    print(json.dumps(result, indent=2))
