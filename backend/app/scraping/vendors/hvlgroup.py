"""
HVL Group vendor adapter — custom ASP.NET multi-brand site.
Brands: Hudson Valley Lighting, Troy Lighting, Corbett Lighting, Mitzi.

The site is fully JavaScript-rendered (SPA with jQuery Ajax).
Server HTML contains no product data — a Playwright render is required.

Product URL format:
    https://www.hvlgroup.com/product/{SKU}
    https://www.hvlgroup.com/product/{SKU}/{Slug}

Data extraction (from rendered DOM):
  name:        <h1> or og:title
  description: first text block in product detail section
  dimensions:  spec table — looks for Width / Height / Depth labels or "Overall"
  images:      all <img> tags from cdnbf.hvlgroup.com CDN with rendered size >= 200px
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
    """Render the HVL product page and extract data from the DOM."""
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
            # Give JS-rendered content extra time to populate
            await page.wait_for_timeout(2_000)
        except Exception:
            await page.wait_for_timeout(5_000)

        # ── Name ──
        name = await page.evaluate("""() => {
            const h1 = document.querySelector('h1');
            if (h1 && h1.innerText.trim()) return h1.innerText.trim();
            const og = document.querySelector('meta[property="og:title"]');
            if (og && og.content && og.content !== 'Product Not Found') return og.content.trim();
            return document.title.replace(/\\s*[-|].*$/, '').trim();
        }""")

        # ── Description ──
        description = await page.evaluate("""() => {
            // Try itemprop=description or first large paragraph in product section
            const desc = document.querySelector('[itemprop="description"], .product-description, .product-detail p');
            if (desc && desc.innerText && desc.innerText.trim().length > 20)
                return desc.innerText.trim().substring(0, 300);
            const og = document.querySelector('meta[property="og:description"]') ||
                       document.querySelector('meta[name="description"]');
            if (og && og.content && og.content.length > 20 &&
                !og.content.includes('official webpage of Hudson Valley'))
                return og.content.trim().substring(0, 300);
            return '';
        }""")

        # ── Dimensions ──
        dimensions = await page.evaluate("""() => {
            // Look for Width/Height/Depth labels in spec table
            let w = '', h = '', d = '';
            const allEls = Array.from(document.querySelectorAll('td, th, dt, dd, span, div, li'));
            for (const el of allEls) {
                if (el.children.length > 0) continue;
                const text = (el.textContent || '').trim();
                const tl = text.toLowerCase();
                if (tl.length > 50) continue;

                function findNext(el) {
                    let sib = el.nextElementSibling;
                    if (sib) { const v = sib.textContent.replace(/\\s+/g,' ').trim(); if (v && /\\d/.test(v) && v.length < 30) return v; }
                    const parent = el.parentElement;
                    if (parent) {
                        sib = parent.nextElementSibling;
                        if (sib) { const v = sib.textContent.replace(/\\s+/g,' ').trim(); if (v && /\\d/.test(v) && v.length < 30) return v; }
                        const siblings = Array.from(parent.children);
                        const idx = siblings.indexOf(el);
                        if (idx !== -1 && idx + 1 < siblings.length) {
                            const v = siblings[idx + 1].textContent.replace(/\\s+/g,' ').trim();
                            if (v && /\\d/.test(v) && v.length < 30) return v;
                        }
                    }
                    return '';
                }

                if (/^(overall|dimensions?)$/i.test(tl)) {
                    const val = findNext(el);
                    if (val && /\\d/.test(val)) return val;
                } else if (/^width$/i.test(tl)) { const v = findNext(el); if (v && !w) w = v; }
                else if (/^height$/i.test(tl)) { const v = findNext(el); if (v && !h) h = v; }
                else if (/^depth$/i.test(tl)) { const v = findNext(el); if (v && !d) d = v; }
            }
            if (w || h || d) {
                const parts = [];
                if (w) parts.push('W ' + w);
                if (d) parts.push('D ' + d);
                if (h) parts.push('H ' + h);
                if (parts.length) return parts.join(' x ');
            }
            return '';
        }""")

        # ── Images ──
        images: list[str] = await page.evaluate("""() => {
            const imgs = [];
            const seen = new Set();
            document.querySelectorAll('img').forEach(img => {
                const src = img.currentSrc || img.src || '';
                // HVL serves product images from cdnbf.hvlgroup.com
                if (!src.includes('cdnbf.hvlgroup.com')) return;
                if (/\\.svg(\\?|$)/i.test(src)) return;
                if (/logo|icon|badge/i.test(src)) return;
                const rect = img.getBoundingClientRect();
                // Only include images rendered >= 150px (filters swatches/thumbnails)
                if (rect.width > 0 && rect.width < 150) return;
                if (!seen.has(src)) { seen.add(src); imgs.push(src); }
            });
            return imgs.slice(0, 12);
        }""")

        await browser.close()

    return ScrapeResult(
        name=(name or "").strip(),
        dimensions=(dimensions or "").strip(),
        description=(description or "").strip(),
        images=images,
    )


class HvlGroupScraper:
    domain = "hvlgroup.com"

    async def scrape(self, url: str) -> ScrapeResult:
        log.info("hvlgroup: launching playwright for %s", url)
        result = await _playwright_scrape(url)
        if not result["name"]:
            log.warning("hvlgroup: could not extract product name from %s", url)
        return result
