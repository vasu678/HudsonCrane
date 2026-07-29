from app.scraping.registry import register
from app.scraping.vendors.four_hands import FourHandsScraper
from app.scraping.vendors.hvlgroup import HvlGroupScraper
from app.scraping.vendors.moeshome import MoesHomeScraper
from app.scraping.vendors.rowe import RoweScraper
from app.scraping.vendors.safavieh import SafaviehScraper
from app.scraping.vendors.surya import SuryaScraper
from app.scraping.vendors.uttermost import UtterMostScraper
from app.scraping.vendors.york import YorkScraper

register(FourHandsScraper())
register(HvlGroupScraper())
register(MoesHomeScraper())
register(RoweScraper())
register(SafaviehScraper())
register(SuryaScraper())
register(UtterMostScraper())
register(YorkScraper())
