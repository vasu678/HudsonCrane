from typing import Protocol, TypedDict


class ScrapeResult(TypedDict):
    name: str
    dimensions: str
    description: str
    images: list[str]


class VendorScraper(Protocol):
    domain: str

    async def scrape(self, url: str) -> ScrapeResult: ...
