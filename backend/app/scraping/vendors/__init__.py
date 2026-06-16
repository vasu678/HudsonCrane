from app.scraping.registry import register
from app.scraping.vendors.four_hands import FourHandsScraper
from app.scraping.vendors.rowe import RoweScraper

register(FourHandsScraper())
register(RoweScraper())
