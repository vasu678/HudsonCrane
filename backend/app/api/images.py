import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.config import settings
from app.models.requests import (
    FinalizeHeroRequest,
    FinalizeHeroResponse,
    ProcessHeroResponse,
    ScrapeRequest,
)
from app.services.image_processor import finalize_hero, process_hero

router = APIRouter()

BROWSER_UA = "Mozilla/5.0"


@router.post("/api/process-hero", response_model=ProcessHeroResponse)
async def process_hero_endpoint(req: ScrapeRequest) -> ProcessHeroResponse:
    """Run rembg on a vendor hero URL and return the GCS URL."""
    try:
        hero_url = await process_hero(req.url, settings.gcs_bucket_name)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Background removal failed: {e}")
    return ProcessHeroResponse(hero_url=hero_url)


@router.post("/api/finalize-hero", response_model=FinalizeHeroResponse)
async def finalize_hero_endpoint(req: FinalizeHeroRequest) -> FinalizeHeroResponse:
    """Composite the original vendor image with the browser-edited mask and upload to GCS."""
    try:
        hero_url = await finalize_hero(req.original_url, req.mask_data_url, settings.gcs_bucket_name)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Mask finalization failed: {e}")
    return FinalizeHeroResponse(hero_url=hero_url)


@router.get("/api/image-proxy")
async def image_proxy(url: str) -> Response:
    """Proxy an image URL through the backend (CORS workaround for canvas)."""
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Only http/https URLs are supported")
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                url,
                headers={"User-Agent": BROWSER_UA},
                follow_redirects=True,
                timeout=30,
            )
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Image fetch failed: {e}")
    content_type = r.headers.get("content-type", "image/png")
    return Response(content=r.content, media_type=content_type)
