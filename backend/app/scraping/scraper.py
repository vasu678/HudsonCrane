import html as html_module
import json
import re
from html.parser import HTMLParser

import httpx
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
from seleniumbase import cdp_driver

STATIC_MIN_BYTES = 50_000
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class _MLStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self.reset()
        self.fed: list[str] = []

    def handle_data(self, d: str) -> None:
        self.fed.append(d)

    def get_data(self) -> str:
        return " ".join(self.fed)


def strip_html(raw: str) -> str:
    s = _MLStripper()
    s.feed(raw)
    text = re.sub(r"\s{2,}", " ", s.get_data()).strip()
    # Strip markdown links: [text](url) → text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return text


def _fetch_static(url: str) -> str | None:
    try:
        r = httpx.get(
            url,
            headers={"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"},
            follow_redirects=True,
            timeout=15,
        )
        if r.status_code == 200 and len(r.text) >= STATIC_MIN_BYTES:
            return r.text
    except Exception:
        pass
    return None


async def _fetch_playwright(url: str) -> str:
    async with async_playwright() as p:
        executable_path = p.chromium.executable_path
        driver = await cdp_driver.start_async(browser_executable_path=executable_path)
        endpoint_url = driver.get_endpoint_url()
        
        browser = await p.chromium.connect_over_cdp(endpoint_url)
        page = browser.contexts[0].pages[0]
        
        await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
        await page.wait_for_timeout(3_000)
        
        # Click any collapsed dimensions/details accordion so the text is in the DOM
        for sel in [
            'button:has-text("Dimensions")',
            'button:has-text("dimensions")',
            'summary:has-text("Dimensions")',
            '[aria-label*="Dimensions" i]',
            'button:has-text("Product Details")',
            'button:has-text("Specifications")',
            'button:has-text("Details")',
        ]:
            try:
                el = page.locator(sel).first
                if await el.is_visible(timeout=500):
                    await el.click()
                    await page.wait_for_timeout(600)
                    break
            except Exception:
                pass
        
        html = await page.content()
        await browser.close()
        return html


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
    r'(\d+[\.\d]*\s*["\'″]\s*[wWdDhH]\b'   # 36"W  42"H
    r'|\d+[\.\d]*\s+[wWdDhH]\b'              # 36 W  42 H
    r'|\d+[\.\d]*\s*[xX×]\s*\d+'             # 36x22  10 x 5
    r'|[lLdDhHwW]\s+\d+[\.\d]*\s*["\'″])',   # L 89"  H 38"
    re.I,
)
SPEC_CLASS_RE = re.compile(r'spec|dimension|detail|measure', re.I)
# Patterns that indicate non-dimension content (pricing, payment, etc.)
NON_DIM_RE = re.compile(r'install|payment|interest|price|\$\d', re.I)


def _find_dimensions(soup: BeautifulSoup) -> str:
    for section in soup.find_all(["section", "div", "ul"], class_=SPEC_CLASS_RE):
        text = section.get_text(" | ", strip=True)
        if DIM_RE.search(text) and not NON_DIM_RE.search(text):
            lines = [l.strip() for l in text.split("|") if l.strip()]
            for i, line in enumerate(lines):
                if re.search(r'^overall\b', line, re.I) and i + 1 < len(lines):
                    return f"{line} {lines[i + 1]}"
            return text[:200]
    for el in soup.find_all(string=DIM_RE):
        text = el.strip()
        if 10 < len(text) < 300 and getattr(el.parent, "name", None) not in ("script", "style") and not NON_DIM_RE.search(text):
            return text
    return ""


GALLERY_CLASS_RE = re.compile(
    r'carousel|gallery|swiper.slide|product.image|pdp.image|pip.image|design.platform',
    re.I,
)
_SIZE_SUFFIX_RE = re.compile(r'-[jmso]\.(jpg|jpeg|png|webp)$', re.I)
_IMG_SKIP_RE = re.compile(
    r'swatch|icon|logo|badge|sprite|assembly|protection|plan|service|warranty|'
    r'video|play.btn|verified|certified|star.rating|checkmark|sparkle|'
    r'wayfair.assembly|wayfair.protection|ai.feature|guarantee',
    re.I,
)


def _upgrade_image_size(url: str) -> str:
    return _SIZE_SUFFIX_RE.sub(r'-l.\1', url)


def _find_gallery_images(soup: BeautifulSoup) -> list[str]:
    imgs: list[str] = []
    seen: set[str] = set()
    for container in soup.find_all(class_=GALLERY_CLASS_RE):
        for img in container.find_all("img", src=True):
            src = str(img.get("src", ""))
            if not src.startswith("http"):
                continue
            if any(x in src.lower() for x in ["swatch", "icon", "logo", "badge", "sprite",
                                                   "assembly", "protection", "plan", "service",
                                                   "warranty", "video", "play-btn"]):
                continue
            src = _upgrade_image_size(src)
            if src not in seen:
                seen.add(src)
                imgs.append(src)
    return imgs


def _find_images(soup: BeautifulSoup, jsonld: dict) -> list[str]:
    imgs: list[str] = []
    seen: set[str] = set()

    def _add(url: str) -> None:
        if url.startswith("http") and url not in seen and not _IMG_SKIP_RE.search(url):
            seen.add(url)
            imgs.append(url)

    # Priority order:
    # 1. SKU-level product shots from __INITIAL_STATE__ (clean product shots)
    for url in _find_images_from_state(soup):
        _add(url)
    # 2. JSON-LD images
    raw = jsonld.get("image", [])
    for url in ([raw] if isinstance(raw, str) else list(raw)):
        _add(url)
    # 3. og:image (often a lifestyle/room shot on WS brands)
    og = soup.find("meta", property="og:image")
    if og and og.get("content"):
        _add(_upgrade_image_size(str(og["content"])))
    # 4. Gallery carousel images
    for url in _find_gallery_images(soup):
        _add(url)

    return imgs


def _find_description(soup: BeautifulSoup, jsonld: dict) -> str:
    raw = jsonld.get("description", "")
    if raw:
        text = strip_html(str(raw))
    else:
        el = soup.find(attrs={"itemprop": "description"}) or soup.find(
            class_=re.compile(r'descri', re.I)
        )
        text = el.get_text(" ", strip=True) if el else ""
    # Truncate to ~250 chars at a sentence boundary so it fits the slide text box
    if len(text) > 250:
        cut = text[:250].rfind(". ")
        text = text[: cut + 1] if cut > 100 else text[:250]
    return text


_NAME_JUNK_RE = re.compile(
    r'\s*[|&\-–]\s*(Reviews?|Wayfair|Pottery\s*Barn|Williams[\s-]Sonoma|'
    r'West\s*Elm|Amazon\.com|Home\s*Depot|IKEA|Target|Crate\s*(&|and)\s*Barrel|'
    r'Anthropologie|CB2|Restoration\s*Hardware|RH).*$',
    re.I,
)


def _clean_name(raw: str) -> str:
    return _NAME_JUNK_RE.sub("", html_module.unescape(raw)).strip()


def _find_name(soup: BeautifulSoup, jsonld: dict) -> str:
    name = jsonld.get("name", "")
    if name:
        return _clean_name(str(name))
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        return _clean_name(str(og["content"]))
    raw = (soup.title.string or "").strip() if soup.title else ""
    return _clean_name(raw)


def _wb_initial_state_blob(soup: BeautifulSoup) -> str:
    """Return json.dumps of window.__INITIAL_STATE__ if present, else empty string."""
    for script in soup.find_all("script"):
        text = script.string or ""
        if "window.__INITIAL_STATE__" not in text:
            continue
        try:
            return json.dumps(json.loads(text.strip()[len("window.__INITIAL_STATE__="):].rstrip(";")))
        except Exception:
            pass
    return ""


def _find_images_from_state(soup: BeautifulSoup) -> list[str]:
    """Extract primary product images from Williams-Sonoma __INITIAL_STATE__ SKU media."""
    blob = _wb_initial_state_blob(soup)
    if not blob:
        return []
    og = soup.find("meta", property="og:image")
    if not og or not og.get("content"):
        return []
    # Derive CDN base from og:image: https://assets.pbimgs.com/pbimgs/rk/images/dp/
    base_m = re.match(r'(https://[^/]+(?:/[^/]+){4}/)', str(og["content"]))
    if not base_m:
        return []
    base = base_m.group(1)
    imgs = []
    for m in re.finditer(r'"type":\s*"prodimage",\s*"path":\s*"([^"]+)"', blob):
        url = f"{base}{m.group(1)}l.jpg"
        imgs.append(url)
    return imgs


def _compact_dimensions(text: str) -> str:
    """Shorten verbose 'Overall Height from Top to Bottom: 35'' H | ...' to 'W 31" x D 22" x H 35"'."""
    h = re.search(r'height[^:|\d]{0,40}[:\s]+(\d+[\.\d]*)\s*["″\']', text, re.I)
    d = re.search(r'depth[^:|\d]{0,40}[:\s]+(\d+[\.\d]*)\s*["″\']', text, re.I)
    w = re.search(r'width[^:|\d]{0,40}[:\s]+(\d+[\.\d]*)\s*["″\']', text, re.I)
    if h and d and w:
        return f'W {w.group(1)}" x D {d.group(1)}" x H {h.group(1)}"'
    return text


def _find_dimensions_from_state(soup: BeautifulSoup) -> str:
    """Extract W/D/H from Williams-Sonoma __INITIAL_STATE__ SKU properties."""
    blob = _wb_initial_state_blob(soup)
    if not blob:
        return ""
    for m in re.finditer(r'"width":\s*"([\d.]+)"', blob):
        window = blob[max(0, m.start() - 800): m.end() + 200]
        dm = re.search(r'"depth":\s*"([\d.]+)"', window)
        hm = re.search(r'"height":\s*"([\d.]+)"', window)
        if dm and hm:
            def fmt(v: str) -> str:
                f = float(v)
                return str(int(f)) if f == int(f) else v
            return f'W {fmt(m.group(1))}" x D {fmt(dm.group(1))}" x H {fmt(hm.group(1))}"'
    return ""


def _find_description_from_state(soup: BeautifulSoup) -> str:
    """Extract prose description from Williams-Sonoma __INITIAL_STATE__ copyBlocks."""
    blob = _wb_initial_state_blob(soup)
    if not blob:
        return ""
    for m in re.finditer(r'"value":\s*"([^"]{100,})"', blob):
        value = html_module.unescape(m.group(1))
        words = value.split()
        if len(words) < 10:
            continue
        text_clean = strip_html(value)
        if len(text_clean) < 80:
            continue
        if len(text_clean) > 250:
            cut = text_clean[:250].rfind(". ")
            text_clean = text_clean[:cut + 1] if cut > 100 else text_clean[:250]
        return text_clean
    return ""


def _parse(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    jsonld = _find_product_jsonld(soup)
    dimensions = _compact_dimensions(_find_dimensions(soup) or _find_dimensions_from_state(soup))
    description = _find_description(soup, jsonld) or _find_description_from_state(soup)
    return {
        "name": _find_name(soup, jsonld),
        "dimensions": dimensions,
        "description": description,
        "images": _find_images(soup, jsonld),
    }


def _unwrap_url(url: str) -> str:
    """Extract the real URL from Google/Bing redirect wrappers."""
    from urllib.parse import urlparse, parse_qs, unquote
    parsed = urlparse(url)
    if parsed.netloc in ("www.google.com", "google.com") and parsed.path == "/url":
        q = parse_qs(parsed.query).get("q", [])
        if q:
            return unquote(q[0])
    if "url=" in parsed.query:
        q = parse_qs(parsed.query).get("url", [])
        if q:
            return unquote(q[0])
    return url


BOT_BLOCK_RE = re.compile(
    r'access.{0,20}denied|error page|robot|captcha|unusual traffic|just a moment|'
    r'please enable javascript|checking your browser',
    re.I,
)


def _is_bot_blocked(result: dict) -> bool:
    """Return True if the parse result looks like a bot-detection page."""
    name = result.get("name", "")
    return (
        not result.get("images")
        and (BOT_BLOCK_RE.search(name) is not None or len(name) < 3)
    )


async def scrape_product(url: str) -> dict:
    url = _unwrap_url(url)
    result: dict = {}
    html = _fetch_static(url)
    if html:
        result = _parse(html)
    if not html or _is_bot_blocked(result):
        html = await _fetch_playwright(url)
        result = _parse(html)
    return result
