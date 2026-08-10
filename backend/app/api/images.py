import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from app.config import settings
from app.models.requests import (
    ProcessHeroResponse,
    ScrapeRequest,
)
from app.services.image_processor import process_hero, process_image_bytes, upload_raw_png

router = APIRouter()


@router.post("/api/upload-cutout")
async def upload_cutout_endpoint(file: UploadFile = File(...)) -> dict:
    """Upload a raw image file, run rembg, and return transparent GCS URL."""
    try:
        data = await file.read()
        orig_url, cutout_url = await process_image_bytes(data, settings.gcs_bucket_name)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Cutout upload failed: {e}")
    return {"original_url": orig_url, "cutout_url": cutout_url}


@router.post("/api/save-edited-cutout")
async def save_edited_cutout_endpoint(file: UploadFile = File(...)) -> dict:
    """Save an edited cutout PNG directly to GCS without running rembg."""
    try:
        data = await file.read()
        cutout_url = await upload_raw_png(data, settings.gcs_bucket_name)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Edited cutout upload failed: {e}")
    return {"cutout_url": cutout_url}


BROWSER_UA = "Mozilla/5.0"


@router.post("/api/process-hero", response_model=ProcessHeroResponse)
async def process_hero_endpoint(req: ScrapeRequest) -> ProcessHeroResponse:
    """Run rembg on a vendor hero URL and return the GCS URL."""
    try:
        hero_url = await process_hero(req.url, settings.gcs_bucket_name)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Background removal failed: {e}")
    return ProcessHeroResponse(hero_url=hero_url)


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
