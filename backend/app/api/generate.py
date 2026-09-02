import asyncio
import logging

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models.requests import DeleteSlideRequest, GenerateResponse
from app.models.slide import ProductSlideInput, TwoProductSlideInput
from app.services.image_processor import process_hero, process_raw_hero, process_supporting_image
from app.services.slide_generator import MAX_SUPPORTS, delete_slide_by_id, generate_slide, generate_two_slide

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/generate", response_model=GenerateResponse)
async def generate(product: ProductSlideInput) -> GenerateResponse:
    if product.finalized_hero_url:
        hero_url = product.finalized_hero_url
    else:
        # Default to sending the raw URL directly to Google Slides for maximum speed.
        # We will only downscale if Google API rejects it for being >25 Megapixels.
        hero_url = product.hero_image_url

    support_urls: list[str] = []
    if product.supporting_image_urls:
        support_urls = await asyncio.gather(*(
            process_supporting_image(url, settings.gcs_bucket_name)
            for url in product.supporting_image_urls[:MAX_SUPPORTS]
        ))

    product_ready = product.model_copy(update={
        "hero_image_url": hero_url,
        "supporting_image_urls": support_urls,
    })

    try:
        result = generate_slide(
            product_ready,
            settings.template_presentation_id,
            settings.template_slide_id,
            settings.oauth_client_secrets_file,
            prev_slide_id=product.prev_slide_id,
        )
    except Exception as e:
        # If Google Slides rejects the image for being too large, downscale and retry!
        if "too large" in str(e).lower() and not product.finalized_hero_url:
            log.warning("Google Slides rejected the image for being >25 Megapixels. Downscaling and retrying...")
            hero_url = await process_raw_hero(product.hero_image_url, settings.gcs_bucket_name)
            product_ready = product_ready.model_copy(update={"hero_image_url": hero_url})
            try:
                result = generate_slide(
                    product_ready,
                    settings.template_presentation_id,
                    settings.template_slide_id,
                    settings.oauth_client_secrets_file,
                    prev_slide_id=product.prev_slide_id,
                )
            except Exception as retry_e:
                log.exception("Slide generation failed on retry: %s", retry_e)
                raise HTTPException(status_code=500, detail=f"Slide generation failed: {retry_e}")
        else:
            log.exception("Slide generation failed: %s", e)
            raise HTTPException(status_code=500, detail=f"Slide generation failed: {e}")

    return GenerateResponse(
        deck_url=result.deck_url,
        slide_id=result.slide_id,
        thumbnail_url=result.thumbnail_url,
        hero_url=hero_url,
    )


@router.post("/api/generate-two", response_model=GenerateResponse)
async def generate_two(body: TwoProductSlideInput) -> GenerateResponse:
    try:
        hero_a_url = await process_hero(body.product_a.hero_image_url, settings.gcs_bucket_name)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Product A background removal failed: {e}")

    try:
        hero_b_url = await process_hero(body.product_b.hero_image_url, settings.gcs_bucket_name)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Product B background removal failed: {e}")

    two_product_ready = TwoProductSlideInput(
        product_a=body.product_a.model_copy(update={"hero_image_url": hero_a_url}),
        product_b=body.product_b.model_copy(update={"hero_image_url": hero_b_url}),
    )

    try:
        result = generate_two_slide(
            two_product_ready,
            settings.template_presentation_id,
            settings.two_product_template_slide_id,
            settings.oauth_client_secrets_file,
            prev_slide_id=body.prev_slide_id,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Two-product slide generation failed: {e}")

    return GenerateResponse(
        deck_url=result.deck_url,
        slide_id=result.slide_id,
        thumbnail_url=result.thumbnail_url,
        hero_url=hero_a_url,
    )


@router.post("/api/delete-slide")
async def discard_slide(body: DeleteSlideRequest) -> dict:
    """Delete a candidate slide the user chose not to keep."""
    try:
        delete_slide_by_id(
            body.presentation_id or settings.template_presentation_id,
            body.slide_id,
            settings.oauth_client_secrets_file,
        )
    except Exception as exc:
        log.warning("discard_slide: %s", exc)
    return {"ok": True}
