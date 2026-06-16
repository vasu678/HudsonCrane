from fastapi import APIRouter, HTTPException

from app.models.requests import ScrapeRequest, ScrapeResponse
from app.scraping.registry import scrape

router = APIRouter()


@router.post("/api/scrape", response_model=ScrapeResponse)
async def scrape_endpoint(req: ScrapeRequest) -> ScrapeResponse:
    try:
        result = await scrape(req.url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Scrape failed: {e}")
    if not result["name"]:
        raise HTTPException(status_code=422, detail="Could not extract product data from URL")
    return ScrapeResponse(**result)
