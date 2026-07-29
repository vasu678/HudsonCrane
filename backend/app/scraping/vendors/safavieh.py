"""
Safavieh vendor adapter — blocks server-side requests (403).

Strategy: Playwright renders the page; extract from JSON-LD Product schema
and spec table.

Product URL format:
    https://safavieh.com/furniture/living-room/accent-chairs/pierre-linen-curved-back-accent-chair-sfv8503a

Data extraction:
  name:        JSON-LD → og:title → h1
  description: JSON-LD → og:description
  dimensions:  Look for "Overall Dimensions" / "Dimensions" label in spec table
  images:      JSON-LD images → supplement with product gallery img tags
"""

import logging
import re

from playwright.async_api import async_playwright

from app.scraping.base import ScrapeResult

log = logging.getLogger(__name__)

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


async def _playwright_scrape(url: str) -> ScrapeResult:
    """Render the Safavieh product page and extract all data."""
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            channel="chrome",
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            user_agent=BROWSER_UA,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        page = await ctx.new_page()

        try:
            await page.goto(url, wait_until="networkidle", timeout=45_000)
            await page.wait_for_timeout(2_000)
        except Exception:
            await page.wait_for_timeout(5_000)

        # ── Extract via JSON-LD ──
        product_data = await page.evaluate("""() => {
            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                    const data = JSON.parse(script.textContent || '');
                    const items = Array.isArray(data) ? data : [data];
                    for (const item of items) {
                        if (item['@type'] === 'Product' && item.name) return item;
                    }
                } catch(_) {}
            }
            return null;
        }""")

        name = ""
        description = ""
        images: list[str] = []

        if product_data:
            name = (product_data.get("name") or "").strip()
            raw_desc = product_data.get("description") or ""
            description = re.sub(r"<[^>]+>", " ", raw_desc)
            description = re.sub(r"\s{2,}", " ", description).strip()[:300]
            raw_imgs = product_data.get("image") or []
            if isinstance(raw_imgs, str):
                raw_imgs = [raw_imgs]
            images = [u for u in raw_imgs if isinstance(u, str) and u.startswith("http")]

        if not name:
            name = await page.evaluate("""() => {
                const og = document.querySelector('meta[property="og:title"]');
                if (og && og.content) return og.content.trim();
                const h1 = document.querySelector('h1');
                return h1 ? h1.innerText.trim() : document.title.split('|')[0].trim();
            }""")

        if not description:
            description = await page.evaluate("""() => {
                const og = document.querySelector('meta[property="og:description"]') ||
                           document.querySelector('meta[name="description"]');
                if (og && og.content && og.content.length > 20) return og.content.trim().substring(0, 300);
                return '';
            }""")

        # ── Dimensions from spec table ──
        dimensions = await page.evaluate("""() => {
            const targetLabels = ['overall dimensions', 'overall', 'dimensions', 'product dimensions', 'size'];
            for (const el of document.querySelectorAll('*')) {
                if (el.children.length > 0) continue;
                const t = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                if (!targetLabels.includes(t)) continue;

                function findVal(e) {
                    let sib = e.nextElementSibling;
                    if (sib) { const v = sib.textContent.replace(/\\s+/g,' ').trim(); if (v && /\\d/.test(v) && v.length < 100) return v; }
                    const parent = e.parentElement;
                    if (parent) {
                        sib = parent.nextElementSibling;
                        if (sib) { const v = sib.textContent.replace(/\\s+/g,' ').trim(); if (v && /\\d/.test(v) && v.length < 100) return v; }
                        const siblings = Array.from(parent.children);
                        const idx = siblings.indexOf(e);
                        if (idx !== -1 && idx+1 < siblings.length) {
                            const v = siblings[idx+1].textContent.replace(/\\s+/g,' ').trim();
                            if (v && /\\d/.test(v) && v.length < 100) return v;
                        }
                    }
                    return '';
                }
                const val = findVal(el);
                if (val) return val;
            }
            return '';
        }""")

        # ── Gallery images (supplement if JSON-LD was sparse) ──
        if len(images) < 2:
            gallery_imgs: list[str] = await page.evaluate("""() => {
                const imgs = [];
                const seen = new Set();
                const selectors = [
                    '[class*="product-image"] img',
                    '[class*="product-gallery"] img',
                    '[class*="ProductGallery"] img',
                    '[class*="carousel"] img',
                ];
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach(img => {
                        let src = img.getAttribute('data-src') || img.currentSrc || img.src || '';
                        if (src.startsWith('//')) src = 'https:' + src;
                        if (!src.startsWith('http')) return;
                        if (/\\.svg(\\?|$)/i.test(src)) return;
                        const rect = img.getBoundingClientRect();
                        if (rect.width > 0 && rect.width < 60) return;
                        if (!seen.has(src)) { seen.add(src); imgs.push(src); }
                    });
                }
                if (imgs.length > 0) return imgs.slice(0, 12);
                // Broad fallback: any large image
                document.querySelectorAll('img').forEach(img => {
                    const src = img.currentSrc || img.src || '';
                    if (!src.startsWith('http') || /\\.svg/.test(src)) return;
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
        name=(name or "").strip(),
        dimensions=(dimensions or "").strip(),
        description=(description or "").strip(),
        images=images[:12],
    )


class SafaviehScraper:
    domain = "safavieh.com"

    async def scrape(self, url: str) -> ScrapeResult:
        log.info("safavieh: launching playwright for %s", url)
        result = await _playwright_scrape(url)
        if not result["name"]:
            log.warning("safavieh: could not extract product name from %s", url)
        return result
