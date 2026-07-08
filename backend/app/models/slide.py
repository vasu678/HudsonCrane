from pydantic import BaseModel


class ProductSlideInput(BaseModel):
    """Handoff contract between scraping/image pipeline and slide generator."""

    hero_image_url: str
    supporting_image_urls: list[str] = []
    name: str
    dimensions: str  # preserve vendor's raw format — do NOT normalize
    description: str
    finalized_hero_url: str | None = None  # set when user applied mask editor; skips rembg
    drop_shadow: bool = True
    prev_slide_id: str | None = None  # superseded candidate to delete after successful regen


class ProductInput(BaseModel):
    """One product's content for the two-product slide."""

    hero_image_url: str
    name: str
    dimensions: str  # preserve vendor's raw format — do NOT normalize
    description: str


class TwoProductSlideInput(BaseModel):
    """Input for generating a two-product side-by-side slide."""

    product_a: ProductInput
    product_b: ProductInput
    drop_shadow: bool = True
    prev_slide_id: str | None = None  # superseded candidate to delete after successful regen
