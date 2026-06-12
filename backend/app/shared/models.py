from pydantic import BaseModel, HttpUrl


class ProductSlideInput(BaseModel):
    """Handoff contract between scraping/image pipeline and slide generator."""

    hero_image_url: str  # transparent PNG at a publicly reachable URL
    supporting_image_urls: list[str] = []  # lifestyle/detail images, no bg removal
    name: str
    dimensions: str  # preserve vendor's raw format — do NOT normalize
    description: str
    finalized_hero_url: str | None = None  # set when user applied mask editor; skips rembg in generate


class ProductInput(BaseModel):
    """One product's content for the two-product slide."""

    hero_image_url: str  # transparent PNG at a publicly reachable URL
    name: str
    dimensions: str  # preserve vendor's raw format — do NOT normalize
    description: str


class TwoProductSlideInput(BaseModel):
    """Input for generating a two-product side-by-side slide."""

    product_a: ProductInput
    product_b: ProductInput
