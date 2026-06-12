import logging
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.images.processor import process_hero, process_supporting_image
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
    # 1. Hero — fatal if this fails
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
