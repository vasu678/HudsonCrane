import logging
import pickle
import time
from dataclasses import dataclass
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from app.models.slide import ProductSlideInput, TwoProductSlideInput
from app.services.image_processor import get_hero_aspect_ratio

log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive",
]
TOKEN_PATH = Path("token.pickle")

IMAGE_REPLACE_HERO_CROP = "CENTER_CROP"
IMAGE_REPLACE_HERO_INSIDE = "CENTER_INSIDE"
IMAGE_REPLACE_SUPPORT = "CENTER_INSIDE"
MAX_SUPPORTS = 2

# ── Layout constants for the single-product slide (Tight 0.150" Margins) ───
# Slide: 9144000 × 5143500 EMU (10" × 5.625")
# Margin: 0.150" = 137160 EMU
_M = 137160  # 0.15" in EMU

# Hero box — slide dimensions and fixed margins
_SLIDE_W = 9144000   # 10" in EMU
_SLIDE_H = 5143500   # 5.625" in EMU

# Support images (bottom of text column)
_SUP_Y   = 2743200               # 3.000" from top
_SUP_H   = _SLIDE_H - _SUP_Y - _M  # 2263140 EMU ≈ 2.475" tall


def _compute_dynamic_layout(hero_w_px: int, hero_h_px: int, is_surya: bool = False) -> dict:
    """Given actual hero image pixel dimensions, compute all layout positions dynamically.

    Returns a dict of all computed EMU values used by _apply_layout_positions.
    """
    hero_aspect = (hero_w_px / hero_h_px) if hero_h_px > 0 else 1.0

    usable_w = _SLIDE_W - 2 * _M                 # 8869680 EMU (9.7" usable)
    max_hero_h = _SLIDE_H - 2 * _M               # 4869180 EMU (5.325" tall, fixed max)

    # Ideal hero width if we show the image at native aspect ratio inside the max box height
    ideal_hero_w = int(max_hero_h * hero_aspect)

    # Clamp: hero gets at most 68% of usable width; text column gets the rest.
    max_hero_w = int(usable_w * 0.68)   # 6031182 EMU ≈ 6.59"
    
    hero_w = ideal_hero_w
    hero_h = max_hero_h
    
    if ideal_hero_w > max_hero_w:
        # The image is too wide!
        hero_w = max_hero_w
        if is_surya:
            # For Surya (isolated product shots), shrink the height to prevent CENTER_CROP from cutting off the sides.
            hero_h = int(hero_w / hero_aspect)
        else:
            # For other vendors (lifestyle room shots), keep the full height. CENTER_CROP will cut off the sides,
            # but the image will fill the slide vertically which looks much better for room shots!
            pass
            
    hero_y = _M + (max_hero_h - hero_h) // 2

    # Hero RIGHT layout: hero on the right side
    hero_x_right = _SLIDE_W - _M - hero_w           # hero left edge for layout 1
    text_col_w_right = hero_x_right - 2 * _M        # text column width for layout 1

    # Hero LEFT layout: hero on the left side (mirror)
    hero_x_left  = _M                               # hero left edge for layout 2
    text_col_x_left = _M + hero_w + _M              # text column left edge for layout 2
    text_col_w_left = _SLIDE_W - _M - text_col_x_left  # text column width for layout 2

    # ── Layout 3 (Horizontal Bottom) ──
    l3_max_w = _SLIDE_W - 2 * _M
    l3_max_y = 1645920  # 1.800" from top
    l3_max_h = _SLIDE_H - l3_max_y - _M
    
    l3_w = l3_max_w
    l3_h = l3_max_h
    l3_x = _M
    l3_y = l3_max_y
    
    if is_surya:
        box_aspect = l3_max_w / l3_max_h
        if hero_aspect > box_aspect:
            # Image is wider than box, shrink height and center vertically
            l3_w = l3_max_w
            l3_h = int(l3_w / hero_aspect)
            l3_y = l3_max_y + (l3_max_h - l3_h) // 2
        else:
            # Image is taller than box, shrink width and center horizontally
            l3_h = l3_max_h
            l3_w = int(l3_h * hero_aspect)
            l3_x = _M + (l3_max_w - l3_w) // 2

    return {
        "hero_w":           hero_w,
        "hero_h":           hero_h,
        "hero_y":           hero_y,
        # Layout 1 (hero right)
        "hero_x_right":     hero_x_right,
        "text_col_w_right": text_col_w_right,
        # Layout 2 (hero left)
        "hero_x_left":      hero_x_left,
        "text_col_x_left":  text_col_x_left,
        "text_col_w_left":  text_col_w_left,
        # Layout 3 (horizontal)
        "l3_w":             l3_w,
        "l3_h":             l3_h,
        "l3_x":             l3_x,
        "l3_y":             l3_y,
    }




@dataclass
class SlideResult:
    deck_url: str
    slide_id: str
    thumbnail_url: str


def _get_credentials(client_secrets_file: str) -> Credentials:
    creds: Credentials | None = None
    if TOKEN_PATH.exists():
        creds = pickle.loads(TOKEN_PATH.read_bytes())
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(client_secrets_file, SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_PATH.write_bytes(pickle.dumps(creds))
    return creds


def _build_image_slots(
    svc,
    presentation_id: str,
    slide_id: str,
    expected: tuple[str, ...] = ("hero", *[f"support{i}" for i in range(1, MAX_SUPPORTS + 1)]),
) -> tuple[dict[str, str], dict[str, tuple[float, float]], list[str]]:
    """Return (slots, raw_sizes, text_shape_ids) where:
    - slots = {alt_title: objectId}
    - raw_sizes = {alt_title: (raw_w_emu, raw_h_emu)}
    - text_shape_ids = list of text box objectIds sorted top-to-bottom [title, dims, desc]
    """
    pres = svc.presentations().get(
        presentationId=presentation_id,
        fields="slides(objectId,pageElements(objectId,title,size,transform,image,shape))",
    ).execute()
    slide = next(s for s in pres["slides"] if s["objectId"] == slide_id)
    slots: dict[str, str] = {}
    raw_sizes: dict[str, tuple[float, float]] = {}
    text_shapes: list[dict] = []
    for el in slide.get("pageElements", []):
        if "image" in el and el.get("title"):
            title = el["title"]
            slots[title] = el["objectId"]
            s = el.get("size", {})
            raw_sizes[title] = (
                s.get("width",  {}).get("magnitude", 1.0),
                s.get("height", {}).get("magnitude", 1.0),
            )
        elif "shape" in el:
            text_shapes.append(el)
    text_shapes.sort(key=lambda x: x.get("transform", {}).get("translateY", 0))
    text_shape_ids = [el["objectId"] for el in text_shapes[:2]]
    for name in expected:
        if name not in slots:
            log.warning("Template image slot '%s' not found — check alt text in template", name)
    return slots, raw_sizes, text_shape_ids


def _transform_request(object_id: str, tx: float, ty: float, scale_x: float, scale_y: float) -> dict:
    """Return an updatePageElementTransform request to reposition and resize
    a page element in ABSOLUTE mode using the correct Google Slides API method."""
    return {
        "updatePageElementTransform": {
            "objectId": object_id,
            "transform": {
                "scaleX":     scale_x,
                "scaleY":     scale_y,
                "shearX":     0,
                "shearY":     0,
                "translateX": tx,
                "translateY": ty,
                "unit":       "EMU",
            },
            "applyMode": "ABSOLUTE",
        }
    }


def _apply_layout_positions(
    image_slots: dict[str, str],
    raw_sizes: dict[str, tuple[float, float]],
    num_supports: int,
    text_shape_ids: list[str] | None = None,
    layout: str = "right",
    dims: dict | None = None,
) -> list[dict]:
    """Return batchUpdate requests that enforce 1 of 3 user-selectable layouts:
    - 'right': Hero Right, Text & Supports Left (Default)
    - 'left': Hero Left, Text & Supports Right (Perch Chair style)
    - 'bottom': Full-Width Bottom Hero, Header Text Top (Lilah Sofa style)

    dims: computed by _compute_dynamic_layout(). If None, falls back to a
          sensible default (50/50 split).
    """
    reqs: list[dict] = []
    # Fall back to a neutral 50/50 default if no dims provided
    if dims is None:
        dims = _compute_dynamic_layout(1, 1)

    if layout == "bottom":
        # ── LAYOUT 3: FULL HORIZONTAL BOTTOM HERO ('Lilah Sofa' style) ────────
        # Top Header Area (Y = 0.150" to 1.500")
        if text_shape_ids and len(text_shape_ids) >= 1:
            # Left side of header: Title and Dims (3.50" wide)
            w_left_scale = 3200400 / 3840600
            reqs.append(_transform_request(text_shape_ids[0], tx=_M, ty=45720, scale_x=w_left_scale, scale_y=1.0))
            if len(text_shape_ids) >= 2:
                # Right side of header: Description (5.95" wide), moved down by ~0.3"
                w_right_scale = (9144000 - 3566160 - _M) / 3840600
                reqs.append(_transform_request(text_shape_ids[1], tx=3566160, ty=320040, scale_x=w_right_scale, scale_y=1.0))

        # Full-Width Horizontal Hero Image on bottom (9.70" wide x 3.68" tall)
        l3_x = dims["l3_x"]
        l3_y = dims["l3_y"]
        l3_w = dims["l3_w"]
        l3_h = dims["l3_h"]
        
        if "hero" in image_slots and "hero" in raw_sizes:
            raw_w, raw_h = raw_sizes["hero"]
            if raw_w > 0 and raw_h > 0:
                reqs.append(_transform_request(
                    image_slots["hero"],
                    tx=l3_x, ty=l3_y,
                    scale_x=l3_w / raw_w,
                    scale_y=l3_h / raw_h,
                ))

        return reqs

    elif layout == "left":
        # ── LAYOUT 2: HERO LEFT, TEXT & SUPPORTS RIGHT ('Perch Chair' style) ──
        hero_w  = dims["hero_w"]
        hero_h  = dims["hero_h"]
        hero_y  = dims["hero_y"]
        hero_x  = dims["hero_x_left"]
        col_x   = dims["text_col_x_left"]
        col_w   = dims["text_col_w_left"]

        if "hero" in image_slots and "hero" in raw_sizes:
            raw_w, raw_h = raw_sizes["hero"]
            if raw_w > 0 and raw_h > 0:
                reqs.append(_transform_request(
                    image_slots["hero"],
                    tx=hero_x, ty=hero_y,
                    scale_x=hero_w / raw_w,
                    scale_y=hero_h / raw_h,
                ))

        if text_shape_ids and len(text_shape_ids) >= 1:
            w_scale = col_w / 3840600
            reqs.append(_transform_request(text_shape_ids[0], tx=col_x, ty=45720, scale_x=w_scale, scale_y=1.0))
            if len(text_shape_ids) >= 2:
                reqs.append({"deleteObject": {"objectId": text_shape_ids[1]}})

        active_supports = [
            name for name in [f"support{i}" for i in range(1, MAX_SUPPORTS + 1)]
            if name in image_slots and name in raw_sizes
        ]
        n = min(len(active_supports), max(1, num_supports))

        if n == 1:
            if "support1" in image_slots and "support1" in raw_sizes:
                raw_w, raw_h = raw_sizes["support1"]
                if raw_w > 0 and raw_h > 0:
                    reqs.append(_transform_request(
                        image_slots["support1"],
                        tx=col_x, ty=_SUP_Y,
                        scale_x=col_w / raw_w,
                        scale_y=_SUP_H / raw_h,
                    ))
        elif n == 2:
            sup_w = (col_w - _M) // 2
            if "support1" in image_slots and "support1" in raw_sizes:
                raw_w, raw_h = raw_sizes["support1"]
                if raw_w > 0 and raw_h > 0:
                    reqs.append(_transform_request(
                        image_slots["support1"],
                        tx=col_x, ty=_SUP_Y,
                        scale_x=sup_w / raw_w,
                        scale_y=_SUP_H / raw_h,
                    ))
            if "support2" in image_slots and "support2" in raw_sizes:
                raw_w, raw_h = raw_sizes["support2"]
                if raw_w > 0 and raw_h > 0:
                    reqs.append(_transform_request(
                        image_slots["support2"],
                        tx=col_x + sup_w + _M, ty=_SUP_Y,
                        scale_x=sup_w / raw_w,
                        scale_y=_SUP_H / raw_h,
                    ))

        return reqs

    # ── LAYOUT 1: HERO RIGHT, TEXT & SUPPORTS LEFT (Default) ─────────────
    hero_w  = dims["hero_w"]
    hero_h  = dims["hero_h"]
    hero_y  = dims["hero_y"]
    hero_x  = dims["hero_x_right"]
    col_w   = dims["text_col_w_right"]

    if text_shape_ids and len(text_shape_ids) >= 1:
        w_scale = col_w / 3840600
        reqs.append(_transform_request(text_shape_ids[0], tx=_M, ty=45720, scale_x=w_scale, scale_y=1.0))
        if len(text_shape_ids) >= 2:
            reqs.append({"deleteObject": {"objectId": text_shape_ids[1]}})

    # Hero image: tight 0.150" margins on right, top, and bottom
    if "hero" in image_slots and "hero" in raw_sizes:
        raw_w, raw_h = raw_sizes["hero"]
        if raw_w > 0 and raw_h > 0:
            reqs.append(_transform_request(
                image_slots["hero"],
                tx=hero_x, ty=hero_y,
                scale_x=hero_w / raw_w,
                scale_y=hero_h / raw_h,
            ))

    # Support images: fill the left text column (bottom portion)
    active_supports = [
        name for name in [f"support{i}" for i in range(1, MAX_SUPPORTS + 1)]
        if name in image_slots and name in raw_sizes
    ]
    if not active_supports:
        return reqs

    n = min(len(active_supports), max(1, num_supports))
    total_w = col_w  # Support images fill the full text column width

    if n == 1:
        gap = 0
        w = total_w
    elif n == 2:
        gap = _M
        w = (total_w - gap) // 2
    else:
        gap = _M // 2
        w = (total_w - (n - 1) * gap) // n

    for i in range(n):
        name = f"support{i + 1}"
        if name in image_slots and name in raw_sizes:
            raw_w, raw_h = raw_sizes[name]
            if raw_w > 0 and raw_h > 0:
                box_x = _M + i * (w + gap)
                reqs.append(_transform_request(
                    image_slots[name],
                    tx=box_x, ty=_SUP_Y,
                    scale_x=w / raw_w,
                    scale_y=_SUP_H / raw_h,
                ))

    return reqs


def _fetch_thumbnail(svc, presentation_id: str, slide_id: str) -> str:
    """Call getThumbnail for a slide page. Retries once after a brief wait for render lag."""
    time.sleep(1)
    for attempt in range(2):
        try:
            resp = (
                svc.presentations()
                .pages()
                .getThumbnail(
                    presentationId=presentation_id,
                    pageObjectId=slide_id,
                    thumbnailProperties_thumbnailSize="LARGE",
                )
                .execute()
            )
            url = resp.get("contentUrl", "")
            if url:
                return url
        except Exception as exc:
            log.warning("getThumbnail attempt %d failed: %s", attempt + 1, exc)
        if attempt == 0:
            time.sleep(2)
    return ""


def delete_slide(svc, presentation_id: str, slide_id: str) -> None:
    """Delete a single slide page from the presentation. Non-fatal on failure."""
    try:
        svc.presentations().batchUpdate(
            presentationId=presentation_id,
            body={"requests": [{"deleteObject": {"objectId": slide_id}}]},
        ).execute()
        log.info("Deleted superseded candidate slide %s", slide_id)
    except Exception as exc:
        log.warning("Failed to delete candidate slide %s: %s", slide_id, exc)


def _get_sizes_by_ids(
    svc,
    presentation_id: str,
    slide_id: str,
    name_to_id: dict[str, str],
) -> dict[str, tuple[float, float]]:
    """Fetch current raw pixel sizes for image elements identified by objectId.
    Used AFTER replaceImage, which strips alt-text from elements making lookup
    by name impossible. We look up by objectId instead."""
    pres = svc.presentations().get(
        presentationId=presentation_id,
        fields="slides(objectId,pageElements(objectId,size,image))",
    ).execute()
    slide = next(s for s in pres["slides"] if s["objectId"] == slide_id)
    id_to_size: dict[str, tuple[float, float]] = {}
    for el in slide.get("pageElements", []):
        if "image" not in el:
            continue
        oid = el.get("objectId", "")
        s = el.get("size", {})
        id_to_size[oid] = (
            s.get("width",  {}).get("magnitude", 1.0),
            s.get("height", {}).get("magnitude", 1.0),
        )
    # Return {name: (raw_w, raw_h)} for only the names whose IDs we found
    return {
        name: id_to_size[oid]
        for name, oid in name_to_id.items()
        if oid in id_to_size
    }


def delete_slide_by_id(presentation_id: str, slide_id: str, client_secrets_file: str) -> None:
    """Standalone delete — builds its own svc. Used by the /api/delete-slide endpoint."""
    creds = _get_credentials(client_secrets_file)
    svc = build("slides", "v1", credentials=creds)
    delete_slide(svc, presentation_id, slide_id)


def generate_slide(
    product: ProductSlideInput,
    template_presentation_id: str,
    template_slide_id: str,
    client_secrets_file: str,
    prev_slide_id: str | None = None,
) -> SlideResult:
    """Clone template slide, replace tokens + hero image. Returns SlideResult."""
    creds = _get_credentials(client_secrets_file)
    svc = build("slides", "v1", credentials=creds)

    dup = (
        svc.presentations()
        .batchUpdate(
            presentationId=template_presentation_id,
            body={"requests": [{"duplicateObject": {"objectId": template_slide_id}}]},
        )
        .execute()
    )
    new_slide_id: str = dup["replies"][0]["duplicateObject"]["objectId"]

    # Fetch image slots and original template raw pixel sizes BEFORE any replacement
    image_slots, template_raw_sizes, text_shape_ids = _build_image_slots(svc, template_presentation_id, new_slide_id)

    # ── BATCH 1: position & size template placeholder boxes ──────────────────
    # We set the exact bounding box sizes (HERO_W x HERO_H, dynamic support w x SUP_H)
    # BEFORE calling replaceImage. When replaceImage runs with CENTER_CROP on these
    # boxes in Batch 2, Google Slides natively crops and centers the vendor image
    # without ANY stretching or elongation!
    support_urls = product.supporting_image_urls[:MAX_SUPPORTS]
    layout = getattr(product, "layout", "right")

    # Compute dynamic hero/text-column split from the actual hero image aspect ratio
    is_surya = "surya.com" in (getattr(product, "source_url", "") or "").lower()
    hero_url_for_dims = getattr(product, "finalized_hero_url", None) or product.hero_image_url
    hero_px_w, hero_px_h = get_hero_aspect_ratio(hero_url_for_dims)
    log.info("Hero image pixel size: %dx%d → aspect %.3f", hero_px_w, hero_px_h, hero_px_w / max(hero_px_h, 1))
    dims = _compute_dynamic_layout(hero_px_w, hero_px_h, is_surya=is_surya)

    layout_reqs = _apply_layout_positions(
        image_slots, template_raw_sizes, len(support_urls),
        text_shape_ids=text_shape_ids,
        layout=layout,
        dims=dims,
    )
    if layout_reqs:
        svc.presentations().batchUpdate(
            presentationId=template_presentation_id,
            body={"requests": layout_reqs},
        ).execute()

    is_bottom_layout = getattr(product, "layout", "right") == "bottom"
    dims_text = product.dimensions if is_bottom_layout else f"{product.dimensions}\n\n{product.description}"
    desc_text = product.description if is_bottom_layout else ""

    # ── BATCH 2: text replacement + image replacement ──────────────────────
    hero_fit_mode = IMAGE_REPLACE_HERO_INSIDE if getattr(product, "hero_fit", "crop") == "inside" else IMAGE_REPLACE_HERO_CROP
    requests: list[dict] = [
        {"replaceAllText": {"containsText": {"text": "{{title}}", "matchCase": True}, "replaceText": product.name, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{dims}}", "matchCase": True}, "replaceText": dims_text, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{desc}}", "matchCase": True}, "replaceText": desc_text, "pageObjectIds": [new_slide_id]}},
        {"replaceImage": {"imageObjectId": image_slots["hero"], "url": product.hero_image_url, "imageReplaceMethod": hero_fit_mode}},
    ]


    for i in range(MAX_SUPPORTS):
        slot = image_slots.get(f"support{i + 1}")
        if slot is None:
            continue
        if not is_bottom_layout and i < len(support_urls):
            requests.append({"replaceImage": {"imageObjectId": slot, "url": support_urls[i], "imageReplaceMethod": IMAGE_REPLACE_SUPPORT}})
        else:
            requests.append({"deleteObject": {"objectId": slot}})

    if is_bottom_layout:
        divider_id = f"divider_{new_slide_id}"
        requests.extend([
            {
                "createShape": {
                    "objectId": divider_id,
                    "shapeType": "RECTANGLE",
                    "elementProperties": {
                        "pageObjectId": new_slide_id,
                        "size": {
                            "width": {"magnitude": 36576, "unit": "EMU"},
                            "height": {"magnitude": 1280160, "unit": "EMU"},
                        },
                        "transform": {
                            "scaleX": 1.0,
                            "scaleY": 1.0,
                            "translateX": 3451860,
                            "translateY": 137160,
                            "unit": "EMU",
                        },
                    },
                }
            },
            {
                "updateShapeProperties": {
                    "objectId": divider_id,
                    "shapeProperties": {
                        "shapeBackgroundFill": {
                            "solidFill": {
                                "color": {
                                    "rgbColor": {"red": 0.77, "green": 0.60, "blue": 0.15}
                                }
                            }
                        },
                        "outline": {
                            "propertyState": "NOT_RENDERED"
                        },
                    },
                    "fields": "shapeBackgroundFill.solidFill.color,outline",
                }
            }
        ])

    svc.presentations().batchUpdate(
        presentationId=template_presentation_id,
        body={"requests": requests},
    ).execute()

    thumbnail_url = _fetch_thumbnail(svc, template_presentation_id, new_slide_id)
    if prev_slide_id:
        delete_slide(svc, template_presentation_id, prev_slide_id)
    deck_url = f"https://docs.google.com/presentation/d/{template_presentation_id}/edit"
    return SlideResult(deck_url=deck_url, slide_id=new_slide_id, thumbnail_url=thumbnail_url)


def generate_two_slide(
    two_product: TwoProductSlideInput,
    template_presentation_id: str,
    template_slide_id: str,
    client_secrets_file: str,
    prev_slide_id: str | None = None,
) -> SlideResult:
    """Clone two-product template slide, replace tokens + both hero images. Returns SlideResult."""
    creds = _get_credentials(client_secrets_file)
    svc = build("slides", "v1", credentials=creds)

    dup = (
        svc.presentations()
        .batchUpdate(
            presentationId=template_presentation_id,
            body={"requests": [{"duplicateObject": {"objectId": template_slide_id}}]},
        )
        .execute()
    )
    new_slide_id: str = dup["replies"][0]["duplicateObject"]["objectId"]

    image_slots, _, _ = _build_image_slots(
        svc, template_presentation_id, new_slide_id,
        expected=("hero_a", "hero_b"),
    )

    a = two_product.product_a
    b = two_product.product_b
    requests: list[dict] = [
        {"replaceAllText": {"containsText": {"text": "{{title_a}}", "matchCase": True}, "replaceText": a.name, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{dims_a}}", "matchCase": True}, "replaceText": a.dimensions, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{desc_a}}", "matchCase": True}, "replaceText": a.description, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{title_b}}", "matchCase": True}, "replaceText": b.name, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{dims_b}}", "matchCase": True}, "replaceText": b.dimensions, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{desc_b}}", "matchCase": True}, "replaceText": b.description, "pageObjectIds": [new_slide_id]}},
        {"replaceImage": {"imageObjectId": image_slots["hero_a"], "url": a.hero_image_url, "imageReplaceMethod": IMAGE_REPLACE_HERO}},
        {"replaceImage": {"imageObjectId": image_slots["hero_b"], "url": b.hero_image_url, "imageReplaceMethod": IMAGE_REPLACE_HERO}},
    ]

    svc.presentations().batchUpdate(
        presentationId=template_presentation_id,
        body={"requests": requests},
    ).execute()

    thumbnail_url = _fetch_thumbnail(svc, template_presentation_id, new_slide_id)
    if prev_slide_id:
        delete_slide(svc, template_presentation_id, prev_slide_id)
    deck_url = f"https://docs.google.com/presentation/d/{template_presentation_id}/edit"
    return SlideResult(deck_url=deck_url, slide_id=new_slide_id, thumbnail_url=thumbnail_url)
