from app.scraping.registry import register
from app.scraping.vendors.four_hands import FourHandsScraper
from app.scraping.vendors.moeshome import MoesHomeScraper
from app.scraping.vendors.rowe import RoweScraper
from app.scraping.vendors.uttermost import UtterMostScraper
from app.scraping.vendors.york import YorkScraper

register(FourHandsScraper())
register(MoesHomeScraper())
register(RoweScraper())
register(UtterMostScraper())
register(YorkScraper())
