import httpx
from bs4 import BeautifulSoup

from app.scraping.base import ScrapeResult

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Wallpaper spec table fields to capture (in display order)
_WALLPAPER_SPEC_KEYS = {
    "Roll Width", "Roll Length", "Roll Coverage",
    "Repeat", "Match", "Material", "Installation",
}


class YorkScraper:
    domain = "yorkwallcoverings.com"

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

    # --- name ---
    og_title = soup.find("meta", property="og:title")
    name = og_title["content"].strip() if og_title and og_title.get("content") else ""

    # --- description (present on most products; empty on some — either way return as-is) ---
    og_desc = soup.find("meta", property="og:description")
    description = (og_desc["content"] or "").strip() if og_desc and og_desc.get("content") else ""

    # --- wallpaper dimensions from spec table ---
    dimensions = _extract_wallpaper_specs(soup)

    # --- images ---
    # og:image is the definitive product shot; avoid recommendation panel images
    images: list[str] = []
    og_img = soup.find("meta", property="og:image")
    if og_img and og_img.get("content", "").startswith("http"):
        images.append(og_img["content"])

    return ScrapeResult(
        name=name,
        dimensions=dimensions,
        description=description,
        images=images,
    )


def _extract_wallpaper_specs(soup: BeautifulSoup) -> str:
    """Read the spec table (alternating key/value cells) and return the relevant fields."""
    for table in soup.find_all("table"):
        cells = [td.get_text(strip=True) for td in table.find_all("td")]
        if not cells or len(cells) < 2:
            continue
        # Pair up cells: even-indexed = key, odd-indexed = value
        pairs = {cells[i]: cells[i + 1] for i in range(0, len(cells) - 1, 2) if i + 1 < len(cells)}
        if not any(k in _WALLPAPER_SPEC_KEYS for k in pairs):
            continue
        # Format only the recognised wallpaper fields in a readable order
        parts = [f"{k}: {v}" for k in _WALLPAPER_SPEC_KEYS if (v := pairs.get(k))]
        if parts:
            return " | ".join(parts)

    # Fallback: use raw data attributes (width/length/repeat) on the product container
    prod = soup.find(True, attrs={"data-width": True})
    if prod:
        w = prod.get("data-width", "").rstrip("0").rstrip(".")
        length_in = prod.get("data-length", "")
        repeat = prod.get("data-repeat", "")
        parts = []
        if w:
            parts.append(f'Roll Width: {w}"')
        if length_in:
            try:
                ft = float(length_in) / 12
                parts.append(f"Roll Length: {ft:.0f}'")
            except ValueError:
                parts.append(f"Roll Length: {length_in}\"")
        if repeat:
            parts.append(f'Repeat: {repeat}"')
        if parts:
            return " | ".join(parts)

    return ""
