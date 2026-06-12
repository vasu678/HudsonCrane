import logging
import os

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from app.images.processor import finalize_hero, process_hero, process_supporting_image
from app.scraping.scraper import scrape_product
from app.shared.models import ProductSlideInput, TwoProductSlideInput
from app.slides.generator import generate_slide, generate_two_slide

log = logging.getLogger(__name__)

app = FastAPI(title="Hudson & Crane Slide Generator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GCS_BUCKET = os.environ.get("GCS_BUCKET_NAME", "hudson-crane-assets")
TEMPLATE_PRESENTATION_ID = os.environ.get("TEMPLATE_PRESENTATION_ID", "")
TEMPLATE_SLIDE_ID = os.environ.get("TEMPLATE_SLIDE_ID", "p")
TWO_PRODUCT_TEMPLATE_SLIDE_ID = os.environ.get("TWO_PRODUCT_TEMPLATE_SLIDE_ID", "g3eac671c004_0_16")
CLIENT_SECRETS_FILE = os.environ.get("OAUTH_CLIENT_SECRETS_FILE", "client_secrets.json")


class ScrapeRequest(BaseModel):
    url: str


class ScrapeResponse(BaseModel):
    name: str
    dimensions: str
    description: str
    images: list[str]


class GenerateResponse(BaseModel):
    deck_url: str


class ProcessHeroResponse(BaseModel):
    hero_url: str


class FinalizeHeroRequest(BaseModel):
    original_url: str
    mask_data_url: str  # PNG data URL from the browser mask canvas


class FinalizeHeroResponse(BaseModel):
    hero_url: str


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/scrape", response_model=ScrapeResponse)
async def scrape(req: ScrapeRequest) -> ScrapeResponse:
    try:
        result = await scrape_product(req.url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Scrape failed: {e}")
    if not result["name"]:
        raise HTTPException(status_code=422, detail="Could not extract product data from URL")
    return ScrapeResponse(**result)


@app.post("/api/generate", response_model=GenerateResponse)
async def generate(product: ProductSlideInput) -> GenerateResponse:
    # 1. Hero — use finalized URL if the user applied the mask editor, else run rembg
    if product.finalized_hero_url:
        hero_url = product.finalized_hero_url
    else:
        try:
            hero_url = await process_hero(product.hero_image_url, GCS_BUCKET)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Background removal failed: {e}")

    # 2. Supporting images — non-fatal; bad URLs are skipped
    support_urls: list[str] = []
    for vendor_url in product.supporting_image_urls[:2]:
        try:
            support_urls.append(await process_supporting_image(vendor_url, GCS_BUCKET))
        except Exception as exc:
            log.warning("Supporting image skipped (%s): %s", vendor_url, exc)

    product_ready = product.model_copy(update={
        "hero_image_url": hero_url,
        "supporting_image_urls": support_urls,
    })

    try:
        deck_url = generate_slide(
            product_ready,
            TEMPLATE_PRESENTATION_ID,
            TEMPLATE_SLIDE_ID,
            CLIENT_SECRETS_FILE,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Slide generation failed: {e}")

    return GenerateResponse(deck_url=deck_url)


@app.post("/api/generate-two", response_model=GenerateResponse)
async def generate_two(body: TwoProductSlideInput) -> GenerateResponse:
    # Process both heroes — either failure is fatal
    try:
        hero_a_url = await process_hero(body.product_a.hero_image_url, GCS_BUCKET)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Product A background removal failed: {e}")

    try:
        hero_b_url = await process_hero(body.product_b.hero_image_url, GCS_BUCKET)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Product B background removal failed: {e}")

    two_product_ready = TwoProductSlideInput(
        product_a=body.product_a.model_copy(update={"hero_image_url": hero_a_url}),
        product_b=body.product_b.model_copy(update={"hero_image_url": hero_b_url}),
    )

    try:
        deck_url = generate_two_slide(
            two_product_ready,
            TEMPLATE_PRESENTATION_ID,
            TWO_PRODUCT_TEMPLATE_SLIDE_ID,
            CLIENT_SECRETS_FILE,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Two-product slide generation failed: {e}")

    return GenerateResponse(deck_url=deck_url)


@app.post("/api/process-hero", response_model=ProcessHeroResponse)
async def process_hero_endpoint(req: ScrapeRequest) -> ProcessHeroResponse:
    """Run rembg on a vendor hero URL and return the GCS URL.
    Called before the mask editor so the user sees the auto cutout first."""
    try:
        hero_url = await process_hero(req.url, GCS_BUCKET)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Background removal failed: {e}")
    return ProcessHeroResponse(hero_url=hero_url)


@app.post("/api/finalize-hero", response_model=FinalizeHeroResponse)
async def finalize_hero_endpoint(req: FinalizeHeroRequest) -> FinalizeHeroResponse:
    """Composite the original vendor image with the browser-edited mask and upload to GCS.
    Called when the user clicks Apply in the mask editor."""
    try:
        hero_url = await finalize_hero(req.original_url, req.mask_data_url, GCS_BUCKET)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Mask finalization failed: {e}")
    return FinalizeHeroResponse(hero_url=hero_url)


@app.get("/api/image-proxy")
async def image_proxy(url: str) -> Response:
    """Proxy an image from any URL through the backend.
    Lets the browser load cross-origin images into a canvas without CORS taint."""
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Only http/https URLs are supported")
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                url,
                headers={"User-Agent": "Mozilla/5.0"},
                follow_redirects=True,
                timeout=30,
            )
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Image fetch failed: {e}")
    content_type = r.headers.get("content-type", "image/png")
    return Response(content=r.content, media_type=content_type)
