"""
Spike C — background removal + GCS upload.

Takes an image URL, removes the background with rembg, uploads the
transparent PNG to GCS, and returns the public URL.

Usage:
    python spike_c_background_removal.py <image_url>

Required env vars:
    GCS_BUCKET_NAME                  — your GCS bucket
    GOOGLE_APPLICATION_CREDENTIALS  — path to service-account key JSON
                                       (or omit if using gcloud auth application-default)
"""

import asyncio
import io
import os
import sys
import time
import uuid

import httpx
from google.cloud import storage
from PIL import Image
from rembg import remove


GCS_BUCKET = os.environ.get("GCS_BUCKET_NAME", "hudson-crane-assets")
MAX_DIMENSION = 1500  # downscale before rembg — keeps output under Slides API limits


def download_image(url: str) -> bytes:
    r = httpx.get(
        url,
        headers={"User-Agent": "Mozilla/5.0"},
        follow_redirects=True,
        timeout=30,
    )
    r.raise_for_status()
    return r.content


def downscale(data: bytes, max_dim: int = MAX_DIMENSION) -> bytes:
    img = Image.open(io.BytesIO(data))
    if max(img.size) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    # Re-encode as PNG to normalise format
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def remove_background(image_bytes: bytes) -> bytes:
    return remove(image_bytes)


def upload_to_gcs(png_bytes: bytes, bucket_name: str) -> str:
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob_name = f"hero/{uuid.uuid4().hex}.png"
    blob = bucket.blob(blob_name)
    blob.upload_from_string(png_bytes, content_type="image/png")
    return f"https://storage.googleapis.com/{bucket_name}/{blob_name}"


def process(image_url: str) -> str:
    print(f"[1] Downloading image…  {image_url[:80]}")
    raw = download_image(image_url)
    print(f"    {len(raw):,} bytes")

    print(f"[2] Downscaling (max {MAX_DIMENSION}px)…")
    scaled = downscale(raw)
    print(f"    {len(scaled):,} bytes after scaling")

    print("[3] Removing background (rembg u2net)…")
    t0 = time.time()
    transparent = remove_background(scaled)
    print(f"    Done in {time.time() - t0:.1f}s  ({len(transparent):,} bytes)")

    print(f"[4] Uploading to GCS bucket '{GCS_BUCKET}'…")
    public_url = upload_to_gcs(transparent, GCS_BUCKET)
    print(f"    Public URL: {public_url}")

    return public_url


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else (
        "https://storage.googleapis.com/hudson-crane-assets/"
        "WhatsApp%20Image%202026-06-10%20at%2021.40.35.jpeg"
    )

    result_url = process(url)
    print("\n" + "=" * 60)
    print("Hero image ready at:")
    print(" ", result_url)
    print("=" * 60)
