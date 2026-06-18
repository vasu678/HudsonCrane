"""
Probe script — Uttermost GraphQL endpoint investigation.

Findings (2026-06-18):
  Endpoint:  POST https://uttermost.com/graphql
  Auth:      None — no cookies, no store header, no API key required
  URL-key:   last path segment of the product URL
             e.g. uttermost.com/furniture/chairs/my-chair-r12345 → url_key = my-chair-r12345

  Key response fields:
    data.products.items[0].name                          → product name
    data.products.items[0].description.html              → description (HTML, strip tags)
    data.products.items[0].media_gallery[]               → images; filter disabled=false, sort by position
    data.products.items[0].custom_attributes[]
      where attribute_metadata.code == "size_desc"
      → entered_attribute_value.value
      → verbatim dimension string, e.g. "51 W X 18 H X 17 D (in)"

  Also available (numeric, less useful for display):
    custom_attributes where code in {width, height, depth}

  GraphQL schema note:
    custom_attributes returns CustomAttribute objects (Magento 2.4 style).
    Each has attribute_metadata {code, label} and entered_attribute_value {value}
    or selected_attribute_options for select/multiselect fields.
    The simpler custom_attributes {...on AttributeValue} syntax causes a 500 — use the
    full CustomAttribute shape shown below.

Run: cd backend && ../.venv/bin/python scripts/probe_uttermost_graphql.py [url_key]
"""

import sys
import json
from html.parser import HTMLParser

import httpx

GRAPHQL_URL = "https://uttermost.com/graphql"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

PRODUCT_QUERY = """
query GetUttermost($urlKey: String!) {
  products(filter: { url_key: { eq: $urlKey } }) {
    items {
      name
      sku
      url_key
      description {
        html
      }
      media_gallery {
        url
        position
        disabled
      }
      custom_attributes {
        attribute_metadata {
          code
          label
        }
        entered_attribute_value {
          value
        }
      }
    }
  }
}
"""


class _StripTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    def result(self) -> str:
        return " ".join(self._parts).strip()


def _strip_html(html: str) -> str:
    p = _StripTags()
    p.feed(html)
    return p.result()


def probe(url_key: str) -> dict:
    r = httpx.post(
        GRAPHQL_URL,
        json={"query": PRODUCT_QUERY, "variables": {"urlKey": url_key}},
        headers={
            "User-Agent": BROWSER_UA,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()

    items = data.get("data", {}).get("products", {}).get("items", [])
    if not items:
        raise ValueError(f"No product found for url_key={url_key!r}")
    p = items[0]

    # --- dimensions from size_desc custom attribute ---
    dimensions = ""
    for attr in p.get("custom_attributes", []):
        if attr.get("attribute_metadata", {}).get("code") == "size_desc":
            dimensions = (attr.get("entered_attribute_value") or {}).get("value") or ""
            break

    # --- images: non-disabled, sorted by position ---
    images = [
        img["url"]
        for img in sorted(p.get("media_gallery", []), key=lambda x: x.get("position", 999))
        if not img.get("disabled") and img.get("url", "").startswith("http")
    ]

    return {
        "name": p.get("name", "").strip(),
        "sku": p.get("sku", ""),
        "url_key": p.get("url_key", ""),
        "dimensions": dimensions,
        "description": _strip_html(p.get("description", {}).get("html", "")),
        "images": images,
    }


if __name__ == "__main__":
    # Default test: use a known product url_key, or pass one as CLI arg
    default_url_key = "soft-spot-bench-r53156"
    url_key = sys.argv[1] if len(sys.argv) > 1 else default_url_key

    # Also support a full URL — extract last path segment
    if url_key.startswith("http"):
        url_key = url_key.rstrip("/").rsplit("/", 1)[-1]

    print(f"Probing url_key: {url_key!r}")
    result = probe(url_key)
    print(json.dumps(result, indent=2))
