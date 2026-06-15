from urllib.parse import urlparse

from app.scraping.base import ScrapeResult, VendorScraper
from app.scraping.scraper import scrape_product

_REGISTRY: dict[str, VendorScraper] = {}


def register(scraper: VendorScraper) -> None:
    _REGISTRY[scraper.domain] = scraper


def _domain(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return host.removeprefix("www.")


async def scrape(url: str) -> ScrapeResult:
    vendor = _REGISTRY.get(_domain(url))
    if vendor:
        return await vendor.scrape(url)
    return await scrape_product(url)
