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

log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive",
]
TOKEN_PATH = Path("token.pickle")

IMAGE_REPLACE_HERO = "CENTER_INSIDE"
IMAGE_REPLACE_SUPPORT = "CENTER_CROP"
MAX_SUPPORTS = 5

def _shadow_req(object_id: str, intensity: float) -> dict:
    """Build a drop-shadow update request scaled by intensity (0.0–1.0)."""
    offset = round(intensity * 9, 1)
    return {
        "updateImageProperties": {
            "objectId": object_id,
            "fields": "shadow",
            "imageProperties": {"shadow": {
                "type": "OUTER",
                "transform": {"scaleX": 1, "scaleY": 1, "translateX": offset, "translateY": offset, "unit": "PT"},
                "alignment": "BOTTOM_LEFT",
                "blurRadius": {"magnitude": round(intensity * 10, 1), "unit": "PT"},
                "color": {"rgbColor": {"red": 0.0, "green": 0.0, "blue": 0.0}},
                "alpha": round(intensity * 0.7, 3),
                "rotateWithShape": False,
                "propertyState": "RENDERED",
            }},
        }
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
) -> dict[str, str]:
    """Return {alt_title: objectId} for every tagged image on the duplicated slide."""
    pres = svc.presentations().get(
        presentationId=presentation_id,
        fields="slides(objectId,pageElements(objectId,title,image))",
    ).execute()
    slide = next(s for s in pres["slides"] if s["objectId"] == slide_id)
    slots = {
        el["title"]: el["objectId"]
        for el in slide.get("pageElements", [])
        if "image" in el and el.get("title")
    }
    for name in expected:
        if name not in slots:
            log.warning("Template image slot '%s' not found — check alt text in template", name)
    return slots


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

    image_slots = _build_image_slots(svc, template_presentation_id, new_slide_id)

    requests: list[dict] = [
        {"replaceAllText": {"containsText": {"text": "{{title}}", "matchCase": True}, "replaceText": product.name, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{dims}}", "matchCase": True}, "replaceText": product.dimensions, "pageObjectIds": [new_slide_id]}},
        {"replaceAllText": {"containsText": {"text": "{{desc}}", "matchCase": True}, "replaceText": product.description, "pageObjectIds": [new_slide_id]}},
        {"replaceImage": {"imageObjectId": image_slots["hero"], "url": product.hero_image_url, "imageReplaceMethod": IMAGE_REPLACE_HERO}},
    ]
    si = product.shadow_intensity
    if si > 0:
        requests.append(_shadow_req(image_slots["hero"], si))

    support_urls = product.supporting_image_urls[:MAX_SUPPORTS]
    for i in range(MAX_SUPPORTS):
        slot = image_slots.get(f"support{i + 1}")
        if slot is None:
            continue
        if i < len(support_urls):
            requests.append({"replaceImage": {"imageObjectId": slot, "url": support_urls[i], "imageReplaceMethod": IMAGE_REPLACE_SUPPORT}})
            if si > 0:
                requests.append(_shadow_req(slot, si))
        else:
            requests.append({"deleteObject": {"objectId": slot}})

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

    image_slots = _build_image_slots(
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
    si = two_product.shadow_intensity
    if si > 0:
        requests.append(_shadow_req(image_slots["hero_a"], si))
        requests.append(_shadow_req(image_slots["hero_b"], si))

    svc.presentations().batchUpdate(
        presentationId=template_presentation_id,
        body={"requests": requests},
    ).execute()

    thumbnail_url = _fetch_thumbnail(svc, template_presentation_id, new_slide_id)
    if prev_slide_id:
        delete_slide(svc, template_presentation_id, prev_slide_id)
    deck_url = f"https://docs.google.com/presentation/d/{template_presentation_id}/edit"
    return SlideResult(deck_url=deck_url, slide_id=new_slide_id, thumbnail_url=thumbnail_url)
