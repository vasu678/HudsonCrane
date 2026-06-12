"""
Spike B — scrape a vendor product page and return a ProductSlideInput.

Strategy:
  1. Try httpx (fast, no JS). If HTML is too short or product JSON-LD is missing, fall back.
  2. Fall back to Playwright (full Chrome) for JS-rendered / bot-protected pages.
  3. Extract: name, description, dimensions, images via JSON-LD first, then DOM heuristics.

Usage:
    python spike_b_scraper.py <product_url>

    e.g.
    python spike_b_scraper.py "https://www.potterybarn.com/products/scarlett-single-sink-vanity/?sku=488128"
"""

import asyncio
import json
import re
import sys
from html.parser import HTMLParser

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

# ── Minimum HTML size to trust a static fetch ────────────────────────────────
STATIC_MIN_BYTES = 50_000

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


# ── HTML → plain text ─────────────────────────────────────────────────────────

class _MLStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self.reset()
        self.fed: list[str] = []

    def handle_data(self, d):
        self.fed.append(d)

    def get_data(self):
        return " ".join(self.fed)


def strip_html(raw: str) -> str:
    s = _MLStripper()
    s.feed(raw)
    return re.sub(r"\s{2,}", " ", s.get_data()).strip()


# ── Fetch strategies ──────────────────────────────────────────────────────────

def fetch_static(url: str) -> str | None:
    """Return HTML if static fetch succeeds with enough content, else None."""
    try:
        r = httpx.get(
            url,
            headers={"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"},
            follow_redirects=True,
            timeout=15,
        )
        if r.status_code == 200 and len(r.text) >= STATIC_MIN_BYTES:
            return r.text
    except Exception as e:
        print(f"  [static] failed: {e}")
    return None


async def fetch_playwright(url: str) -> str:
    """Render page with full Chrome and return HTML."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True)
        ctx = await browser.new_context(
            user_agent=BROWSER_UA,
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )
        page = await ctx.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
        await page.wait_for_timeout(3_000)
        html = await page.content()
        await browser.close()
        return html


# ── Parsers ───────────────────────────────────────────────────────────────────

def _find_product_jsonld(soup: BeautifulSoup) -> dict:
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            raw = json.loads(script.string or "")
            items = raw if isinstance(raw, list) else [raw]
            for item in items:
                if isinstance(item, dict) and "Product" in str(item.get("@type", "")):
                    return item
        except Exception:
            pass
    return {}


DIM_RE = re.compile(
    r'(\d+[\.\d]*\s*["\'″]?\s*[wWdDhH]'
    r'|\d+[\.\d]*\s*[xX×]\s*\d+)',
    re.I,
)

SPEC_CLASS_RE = re.compile(r'spec|dimension|detail|measure', re.I)


def _find_dimensions(soup: BeautifulSoup) -> str:
    # 1. Look for a spec/dimension section
    for section in soup.find_all(["section", "div", "ul"], class_=SPEC_CLASS_RE):
        text = section.get_text(" | ", strip=True)
        if DIM_RE.search(text):
            lines = [l.strip() for l in text.split("|") if l.strip()]
            # Pair "Overall:" label with the value that follows it
            for i, line in enumerate(lines):
                if re.search(r'^overall\b', line, re.I) and i + 1 < len(lines):
                    return f"{line} {lines[i + 1]}"
            # Fallback: return first 200 chars of the whole block
            return text[:200]

    # 2. Scan all text nodes for dimension patterns
    for el in soup.find_all(string=DIM_RE):
        text = el.strip()
        if 10 < len(text) < 300 and el.parent.name not in ("script", "style"):
            return text

    return ""


def _find_images(soup: BeautifulSoup, jsonld: dict) -> list[str]:
    imgs: list[str] = []

    # From JSON-LD
    raw = jsonld.get("image", [])
    if isinstance(raw, str):
        raw = [raw]
    imgs.extend(raw)

    # og:image as fallback
    og = soup.find("meta", property="og:image")
    if og and og.get("content"):
        url = og["content"]
        if url not in imgs:
            imgs.insert(0, url)

    # Deduplicate, keep https only
    seen: set[str] = set()
    out: list[str] = []
    for u in imgs:
        if u.startswith("http") and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _find_description(soup: BeautifulSoup, jsonld: dict) -> str:
    raw = jsonld.get("description", "")
    if raw:
        return strip_html(str(raw))[:600]

    # Fallback: itemprop or class heuristic
    el = soup.find(attrs={"itemprop": "description"})
    if not el:
        el = soup.find(class_=re.compile(r'descri', re.I))
    if el:
        return el.get_text(" ", strip=True)[:600]
    return ""


def _find_name(soup: BeautifulSoup, jsonld: dict) -> str:
    name = jsonld.get("name", "")
    if name:
        return str(name).strip()
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        return og["content"].strip()
    if soup.title:
        return soup.title.string.strip()
    return ""


# ── Main ──────────────────────────────────────────────────────────────────────

def parse(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    jsonld = _find_product_jsonld(soup)

    name = _find_name(soup, jsonld)
    description = _find_description(soup, jsonld)
    dimensions = _find_dimensions(soup)
    images = _find_images(soup, jsonld)

    return {
        "name": name,
        "dimensions": dimensions,
        "description": description,
        "images": images,
        "source_url": url,
    }


async def scrape(url: str) -> dict:
    print(f"[1] Trying static fetch…")
    html = fetch_static(url)
    if html:
        print(f"    Static OK ({len(html):,} bytes)")
    else:
        print(f"    Static failed — falling back to Playwright (full Chrome)…")
        html = await fetch_playwright(url)
        print(f"    Playwright OK ({len(html):,} bytes)")

    return parse(html, url)


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else (
        "https://www.potterybarn.com/products/scarlett-single-sink-vanity/?sku=488128"
    )

    result = asyncio.run(scrape(url))

    print("\n" + "=" * 60)
    print("NAME:       ", result["name"])
    print("DIMENSIONS: ", result["dimensions"][:120])
    print("DESCRIPTION:", result["description"][:200])
    print(f"IMAGES ({len(result['images'])}):")
    for i, img in enumerate(result["images"][:6]):
        print(f"  [{i}] {img}")
    print("=" * 60)
