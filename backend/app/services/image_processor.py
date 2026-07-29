import base64
import io
import uuid

import httpx
from google.cloud import storage
from google.oauth2 import service_account
from PIL import Image
from rembg import remove

from app.config import settings

MAX_DIMENSION = 4000


def _gcs_client() -> storage.Client:
    creds = service_account.Credentials.from_service_account_file(
        settings.google_application_credentials,
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    return storage.Client(credentials=creds)


def _download(url: str) -> bytes:
    r = httpx.get(url, headers={"User-Agent": "Mozilla/5.0"}, follow_redirects=True, timeout=30)
    r.raise_for_status()
    return r.content


def _downscale_png(data: bytes) -> bytes:
    img = Image.open(io.BytesIO(data))
    if max(img.size) > MAX_DIMENSION:
        img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def _downscale_jpeg(data: bytes) -> bytes:
    img = Image.open(io.BytesIO(data))
    if max(img.size) > MAX_DIMENSION:
        img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _upload(data: bytes, bucket_name: str, prefix: str, content_type: str, ext: str) -> str:
    client = _gcs_client()
    blob = client.bucket(bucket_name).blob(f"{prefix}/{uuid.uuid4().hex}.{ext}")
    blob.upload_from_string(data, content_type=content_type)
    return f"https://storage.googleapis.com/{bucket_name}/{blob.name}"


async def process_hero(image_url: str, bucket_name: str) -> str:
    """Download, remove background, upload as PNG. Returns public GCS URL."""
    raw = _download(image_url)
    scaled = _downscale_png(raw)
    
    # rembg often degrades the RGB pixels slightly, so we only use it to get the alpha mask
    transparent = remove(scaled)
    
    orig_img = Image.open(io.BytesIO(scaled)).convert("RGBA")
    rembg_img = Image.open(io.BytesIO(transparent)).convert("RGBA")
    
    if rembg_img.size != orig_img.size:
        rembg_img = rembg_img.resize(orig_img.size, Image.LANCZOS)
        
    r, g, b, _ = orig_img.split()
    mask_alpha = rembg_img.split()[3]
    result = Image.merge("RGBA", (r, g, b, mask_alpha))
    
    buf = io.BytesIO()
    result.save(buf, format="PNG")
    
    return _upload(buf.getvalue(), bucket_name, prefix="hero", content_type="image/png", ext="png")


async def process_supporting_image(image_url: str, bucket_name: str) -> str:
    """Download, downscale, upload as JPEG (no background removal). Returns public GCS URL."""
    raw = _download(image_url)
    jpeg = _downscale_jpeg(raw)
    return _upload(jpeg, bucket_name, prefix="support", content_type="image/jpeg", ext="jpg")


async def finalize_hero(original_url: str, mask_data_url: str, bucket_name: str) -> str:
    """Composite original image with browser-edited mask, upload as PNG. Returns public GCS URL."""
    raw = _download(original_url)
    orig = Image.open(io.BytesIO(raw)).convert("RGBA")
    if max(orig.size) > MAX_DIMENSION:
        orig.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)

    _, b64data = mask_data_url.split(",", 1)
    mask_img = Image.open(io.BytesIO(base64.b64decode(b64data))).convert("RGBA")

    if mask_img.size != orig.size:
        mask_img = mask_img.resize(orig.size, Image.LANCZOS)

    r, g, b, _ = orig.split()
    mask_alpha = mask_img.split()[3]
    result = Image.merge("RGBA", (r, g, b, mask_alpha))

    buf = io.BytesIO()
    result.save(buf, format="PNG")
    return _upload(buf.getvalue(), bucket_name, prefix="hero-final", content_type="image/png", ext="png")
