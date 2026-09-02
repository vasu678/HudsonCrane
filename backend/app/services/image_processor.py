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
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    }
    r = httpx.get(url, headers=headers, follow_redirects=True, timeout=30)
    r.raise_for_status()
    content_type = r.headers.get("content-type", "").lower()
    if "text/html" in content_type or r.content[:4].lower().startswith((b"<htm", b"<!do")):
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(r.text, "html.parser")
        og_img = soup.find("meta", property="og:image") or soup.find("meta", attrs={"name": "og:image"})
        if og_img and og_img.get("content"):
            img_url = og_img["content"]
            r2 = httpx.get(img_url, headers=headers, follow_redirects=True, timeout=30)
            r2.raise_for_status()
            return r2.content
        raise ValueError("The pasted URL is a webpage without a product image. Please right-click the image and select 'Copy Image' or copy a direct image link.")
    return r.content


def get_hero_aspect_ratio(url: str) -> tuple[int, int]:
    """Stream the hero image and return its (width, height) in pixels.
    This safely reads just the first few kilobytes (headers) to find the size,
    preventing us from downloading massive 15MB+ images into memory."""
    try:
        with httpx.stream("GET", url, timeout=10, follow_redirects=True) as r:
            r.raise_for_status()
            data = b""
            for chunk in r.iter_bytes(4096):
                data += chunk
                try:
                    img = Image.open(io.BytesIO(data))
                    return img.size  # Successfully parsed the header!
                except Exception:
                    # Header not fully received yet; keep reading.
                    if len(data) > 1024 * 1024:
                        break # Give up if size isn't found within 1MB
        return (1, 1)
    except Exception:
        return (1, 1)


def _downscale_png(data: bytes) -> bytes:
    try:
        img = Image.open(io.BytesIO(data))
    except Exception:
        raise ValueError("Could not read image format. Please ensure you copied a valid image photo or screenshot.")
    if max(img.size) > MAX_DIMENSION:
        img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def _downscale_jpeg(data: bytes, trim: bool = False) -> bytes:
    try:
        img = Image.open(io.BytesIO(data))
    except Exception:
        raise ValueError("Could not read image format. Please ensure you copied a valid image photo or screenshot.")
    
    if trim:
        from PIL import ImageChops
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        
        # SMART TRIM: Only trim if the 4 corners are actually near-white.
        # This prevents ruining lifestyle photos (which have dark edges) by asymmetrically cropping them.
        gray = bg.convert("L")
        w, h = gray.size
        is_white_bg = True
        if w > 0 and h > 0:
            corners = [(0, 0), (w-1, 0), (0, h-1), (w-1, h-1)]
            for cx, cy in corners:
                if gray.getpixel((cx, cy)) < 240:
                    is_white_bg = False
                    break
                    
        if is_white_bg:
            diff = ImageChops.difference(bg, Image.new("RGB", bg.size, (255, 255, 255)))
            diff_gray = diff.convert("L")
            # Threshold: ignore slight off-white noise (JPEG artifacts)
            mask = diff_gray.point(lambda p: p > 15 and 255)
            bbox = mask.getbbox()
            if bbox:
                img = img.crop(bbox)

    if max(img.size) > MAX_DIMENSION:
        img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)
        
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (255, 255, 255))
        bg.paste(rgba, mask=rgba.split()[3])
        img = bg
    else:
        img = img.convert("RGB")
        
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
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


async def process_image_bytes(data: bytes, bucket_name: str) -> tuple[str, str]:
    """Remove background from raw image bytes and upload as PNG. Returns (orig_url, cutout_url)."""
    scaled = _downscale_png(data)
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
    orig_url = _upload(scaled, bucket_name, prefix="orig", content_type="image/png", ext="png")
    cutout_url = _upload(buf.getvalue(), bucket_name, prefix="cutouts", content_type="image/png", ext="png")
    return orig_url, cutout_url


async def upload_raw_png(data: bytes, bucket_name: str) -> str:
    """Directly upload a PNG without modifying pixels or running background removal."""
    return _upload(data, bucket_name, prefix="cutouts", content_type="image/png", ext="png")



async def process_raw_hero(image_url: str, bucket_name: str) -> str:
    """Download, downscale, and upload original hero as JPEG without ANY trimming.
    This prevents Google Slides API from crashing on massive 25+ Megapixel vendor images."""
    raw = _download(image_url)
    jpeg = _downscale_jpeg(raw, trim=False)
    return _upload(jpeg, bucket_name, prefix="hero_raw", content_type="image/jpeg", ext="jpg")


async def process_supporting_image(image_url: str, bucket_name: str) -> str:
    """Download, downscale, trim white edges (smartly).
    If it has transparency (e.g. a cutout), preserve it as PNG.
    Otherwise, upload as JPEG for smaller file sizes."""
    raw = _download(image_url)
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception:
        raise ValueError("Could not read image format.")
    
    # Check if the image has actual transparency
    is_transparent = False
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img_rgba = img.convert("RGBA")
        extrema = img_rgba.getextrema()
        if extrema[3][0] < 255:  # alpha channel min value < 255
            is_transparent = True
            
    if is_transparent:
        # Trim transparent edges tightly so the cutout scales up properly in Google Slides
        img_rgba = img.convert("RGBA")
        bbox = img_rgba.split()[3].getbbox()
        if bbox:
            img = img.crop(bbox)
            
        if max(img.size) > MAX_DIMENSION:
            img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return _upload(buf.getvalue(), bucket_name, prefix="support", content_type="image/png", ext="png")
    else:
        # Process as a standard solid background image
        jpeg = _downscale_jpeg(raw, trim=True)
        return _upload(jpeg, bucket_name, prefix="support", content_type="image/jpeg", ext="jpg")
