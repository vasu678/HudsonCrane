import logging
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import app.scraping.vendors  # noqa: F401 — registers vendor adapters
from app.api import generate, images, scrape

logging.basicConfig(level=logging.INFO, stream=sys.stdout)

app = FastAPI(title="Hudson & Crane Slide Generator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins so the Chrome Extension can connect from any vendor website
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scrape.router)
app.include_router(generate.router)
app.include_router(images.router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
