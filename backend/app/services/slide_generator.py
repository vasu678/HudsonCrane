import logging
import pickle
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
    expected: tuple[str, ...] = ("hero", "support1", "support2"),
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


def generate_slide(
    product: ProductSlideInput,
    template_presentation_id: str,
    template_slide_id: str,
    client_secrets_file: str,
) -> str:
    """Clone template slide, replace tokens + hero image. Returns deck URL."""
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

    support_urls = product.supporting_image_urls[:2]
    for i in range(2):
        slot = image_slots.get(f"support{i + 1}")
        if slot is None:
            continue
        if i < len(support_urls):
            requests.append({"replaceImage": {"imageObjectId": slot, "url": support_urls[i], "imageReplaceMethod": IMAGE_REPLACE_SUPPORT}})
        else:
            requests.append({"deleteObject": {"objectId": slot}})

    svc.presentations().batchUpdate(
        presentationId=template_presentation_id,
        body={"requests": requests},
    ).execute()

    return f"https://docs.google.com/presentation/d/{template_presentation_id}/edit"


def generate_two_slide(
    two_product: TwoProductSlideInput,
    template_presentation_id: str,
    template_slide_id: str,
    client_secrets_file: str,
) -> str:
    """Clone two-product template slide, replace tokens + both hero images. Returns deck URL."""
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

    svc.presentations().batchUpdate(
        presentationId=template_presentation_id,
        body={"requests": requests},
    ).execute()

    return f"https://docs.google.com/presentation/d/{template_presentation_id}/edit"
