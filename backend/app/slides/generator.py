import logging
import pickle
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from app.shared.models import ProductSlideInput

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


def _build_image_slots(svc, presentation_id: str, slide_id: str) -> dict[str, str]:
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
    for expected in ("hero", "support1", "support2"):
        if expected not in slots:
            log.warning("Template image slot '%s' not found — check alt text in template", expected)
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

    # 1. Duplicate template slide
    dup = (
        svc.presentations()
        .batchUpdate(
            presentationId=template_presentation_id,
            body={"requests": [{"duplicateObject": {"objectId": template_slide_id}}]},
        )
        .execute()
    )
    new_slide_id: str = dup["replies"][0]["duplicateObject"]["objectId"]

    # 2. Build alt-text → objectId map for image slots on the duplicated slide
    image_slots = _build_image_slots(svc, template_presentation_id, new_slide_id)

    # 3. Replace text tokens + swap hero image
    svc.presentations().batchUpdate(
        presentationId=template_presentation_id,
        body={
            "requests": [
                {
                    "replaceAllText": {
                        "containsText": {"text": "{{title}}", "matchCase": True},
                        "replaceText": product.name,
                        "pageObjectIds": [new_slide_id],
                    }
                },
                {
                    "replaceAllText": {
                        "containsText": {"text": "{{dims}}", "matchCase": True},
                        "replaceText": product.dimensions,
                        "pageObjectIds": [new_slide_id],
                    }
                },
                {
                    "replaceAllText": {
                        "containsText": {"text": "{{desc}}", "matchCase": True},
                        "replaceText": product.description,
                        "pageObjectIds": [new_slide_id],
                    }
                },
                {
                    "replaceImage": {
                        "imageObjectId": image_slots["hero"],
                        "url": product.hero_image_url,
                        "imageReplaceMethod": IMAGE_REPLACE_HERO,
                    }
                },
            ]
        },
    ).execute()

    return f"https://docs.google.com/presentation/d/{template_presentation_id}/edit"
