import logging

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models.requests import GenerateResponse
from app.models.slide import ProductSlideInput, TwoProductSlideInput
from app.services.image_processor import process_hero, process_supporting_image
from app.services.slide_generator import generate_slide, generate_two_slide

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/api/generate", response_model=GenerateResponse)
async def generate(product: ProductSlideInput) -> GenerateResponse:
    if product.finalized_hero_url:
        hero_url = product.finalized_hero_url
    else:
        try:
            hero_url = await process_hero(product.hero_image_url, settings.gcs_bucket_name)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Background removal failed: {e}")

    support_urls: list[str] = []
    for vendor_url in product.supporting_image_urls[:2]:
        try:
            support_urls.append(await process_supporting_image(vendor_url, settings.gcs_bucket_name))
        except Exception as exc:
            log.warning("Supporting image skipped (%s): %s", vendor_url, exc)

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
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Slide generation failed: {e}")

    return GenerateResponse(
        deck_url=result.deck_url,
        slide_id=result.slide_id,
        thumbnail_url=result.thumbnail_url,
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
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Two-product slide generation failed: {e}")

    return GenerateResponse(
        deck_url=result.deck_url,
        slide_id=result.slide_id,
        thumbnail_url=result.thumbnail_url,
    )
