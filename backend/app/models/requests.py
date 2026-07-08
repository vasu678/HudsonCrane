from pydantic import BaseModel


class ScrapeRequest(BaseModel):
    url: str


class ScrapeResponse(BaseModel):
    name: str
    dimensions: str
    description: str
    images: list[str]


class GenerateResponse(BaseModel):
    deck_url: str
    slide_id: str = ""
    thumbnail_url: str = ""
    hero_url: str = ""  # bg-removed hero PNG on GCS — for client-side shadow preview


class ProcessHeroResponse(BaseModel):
    hero_url: str


class FinalizeHeroRequest(BaseModel):
    original_url: str
    mask_data_url: str  # PNG data URL from the browser mask canvas


class FinalizeHeroResponse(BaseModel):
    hero_url: str


class DeleteSlideRequest(BaseModel):
    slide_id: str
