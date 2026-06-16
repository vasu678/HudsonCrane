from app.scraping.registry import register
from app.scraping.vendors.four_hands import FourHandsScraper

register(FourHandsScraper())
