import json
import re
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

from app.scraping.base import ScrapeResult

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_VAR_OBJ_RE = re.compile(r"var obj\s*=\s*(\{.*?\});", re.S)


class RoweScraper:
    domain = "rowefurniture.com"

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
    og = soup.find("meta", property="og:title")
    name = og["content"].strip() if og and og.get("content") else ""

    # Fall back to var obj Name if og:title is missing
    m = _VAR_OBJ_RE.search(html)
    if not name and m:
        try:
            obj = json.loads(m.group(1))
            name = (obj.get("Name") or "").strip()
        except (json.JSONDecodeError, KeyError):
            pass

    # --- images (from var obj PictureModels) ---
    images: list[str] = []
    if m:
        try:
            obj = json.loads(m.group(1))
            for pic in obj.get("PictureModels", []):
                raw = pic.get("FullSizeImageUrl") or pic.get("ImageUrl") or ""
                if raw.startswith("http"):
                    # CDN URLs contain literal spaces — encode before use
                    images.append(quote(raw, safe=":/?#[]@!$&'()*+,;=%"))
        except (json.JSONDecodeError, KeyError):
            pass

    # --- dimensions (spec table row "Dimensions (IN)") ---
    dimensions = ""
    for td in soup.find_all("td"):
        if "Dimensions (IN)" in td.get_text():
            row = td.find_parent("tr")
            if row:
                cells = row.find_all("td")
                if len(cells) > 1:
                    dimensions = cells[1].get_text(strip=True)
            break

    # --- description (systemically null on Rowe — return empty, user fills in) ---
    description = ""

    return ScrapeResult(
        name=name,
        dimensions=dimensions,
        description=description,
        images=images,
    )
