from pydantic import BaseModel


class ProductSlideInput(BaseModel):
    """Handoff contract between scraping/image pipeline and slide generator."""

    hero_image_url: str
    supporting_image_urls: list[str] = []
    name: str
    dimensions: str  # preserve vendor's raw format — do NOT normalize
    description: str
    finalized_hero_url: str | None = None  # set when user applied mask editor; skips rembg
    prev_slide_id: str | None = None  # superseded candidate to delete after successful regen
    keep_background: bool = False  # skips background removal if true


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
    prev_slide_id: str | None = None  # superseded candidate to delete after successful regen
