"""
Spike A — prove layered-slide generation via the Google Slides API.

Usage:
    python spike_a_layered_slide.py

Required environment variables (set in .env or shell):
    TEMPLATE_PRESENTATION_ID   — ID of the deck that holds the template slide
    TEMPLATE_SLIDE_ID          — objectId of the slide with {{title}}, {{dims}}, {{desc}} tokens
    IMAGE_URL                  — public URL of a transparent PNG to swap in
    OAUTH_CLIENT_SECRETS_FILE  — path to your OAuth 2.0 client_secrets.json (Desktop app type)

Definition of done:
    Open the printed URL, copy the generated slide, paste into a DIFFERENT deck,
    confirm the image is movable/resizable and text boxes are editable.
"""

import json
import logging
import os
import sys

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
import pickle
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)

SCOPES = [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive",
]

TOKEN_PICKLE = Path("token.pickle")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def get_credentials(client_secrets_file: str) -> Credentials:
    creds: Credentials | None = None

    if TOKEN_PICKLE.exists():
        with TOKEN_PICKLE.open("rb") as f:
            creds = pickle.load(f)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            log.info("Refreshing expired token…")
            creds.refresh(Request())
        else:
            log.info("Starting OAuth browser flow…")
            flow = InstalledAppFlow.from_client_secrets_file(client_secrets_file, SCOPES)
            creds = flow.run_local_server(port=0)

        with TOKEN_PICKLE.open("wb") as f:
            pickle.dump(creds, f)
        log.info("Token saved to %s", TOKEN_PICKLE)

    return creds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fail(msg: str, err: HttpError | None = None) -> None:
    log.error(msg)
    if err:
        try:
            body = json.loads(err.content)
            log.error("API error body:\n%s", json.dumps(body, indent=2))
        except Exception:
            log.error("Raw error: %s", err)
    sys.exit(1)


def batch_update(slides_svc, presentation_id: str, requests: list[dict]) -> dict:
    """Execute a batchUpdate and return the full response, or exit on error."""
    try:
        resp = (
            slides_svc.presentations()
            .batchUpdate(presentationId=presentation_id, body={"requests": requests})
            .execute()
        )
        return resp
    except HttpError as e:
        fail(f"batchUpdate failed on presentation {presentation_id}", e)


# ---------------------------------------------------------------------------
# Main spike
# ---------------------------------------------------------------------------

def main() -> None:
    template_presentation_id = os.environ.get("TEMPLATE_PRESENTATION_ID", "").strip()
    template_slide_id = os.environ.get("TEMPLATE_SLIDE_ID", "").strip()
    image_url = os.environ.get("IMAGE_URL", "").strip()
    client_secrets_file = os.environ.get("OAUTH_CLIENT_SECRETS_FILE", "client_secrets.json").strip()

    missing = [
        name
        for name, val in [
            ("TEMPLATE_PRESENTATION_ID", template_presentation_id),
            ("TEMPLATE_SLIDE_ID", template_slide_id),
            ("IMAGE_URL", image_url),
        ]
        if not val
    ]
    if missing:
        fail(f"Missing required env vars: {', '.join(missing)}")

    # --- Auth ---
    creds = get_credentials(client_secrets_file)
    slides_svc = build("slides", "v1", credentials=creds)
    log.info("Google Slides service ready.")

    # --- Step 1: duplicate the template slide ---
    log.info("Duplicating template slide %s …", template_slide_id)
    dup_resp = batch_update(
        slides_svc,
        template_presentation_id,
        [{"duplicateObject": {"objectId": template_slide_id}}],
    )

    replies = dup_resp.get("replies", [])
    if not replies or "duplicateObject" not in replies[0]:
        fail("duplicateObject reply missing — cannot continue.")

    new_slide_id: str = replies[0]["duplicateObject"]["objectId"]
    log.info("New slide objectId: %s", new_slide_id)

    # --- Step 2: fetch the new slide to get fresh element objectIds ---
    log.info("Fetching new slide structure to locate image element objectId…")
    try:
        presentation = (
            slides_svc.presentations()
            .get(presentationId=template_presentation_id)
            .execute()
        )
    except HttpError as e:
        fail("presentations.get failed", e)

    new_slide = next(
        (s for s in presentation["slides"] if s["objectId"] == new_slide_id),
        None,
    )
    if new_slide is None:
        fail(f"Could not find new slide {new_slide_id} in presentation.")

    # Find the first image element on the slide
    image_element_id: str | None = None
    for element in new_slide.get("pageElements", []):
        if "image" in element:
            image_element_id = element["objectId"]
            log.info("Found image element: %s", image_element_id)
            break

    if image_element_id is None:
        fail(
            "No image element found on the duplicated slide. "
            "Make sure the template slide has a placeholder image."
        )

    # --- Step 3: replace text tokens + swap image ---
    log.info("Replacing text tokens and swapping hero image…")
    replace_requests = [
        {
            "replaceAllText": {
                "containsText": {"text": "{{title}}", "matchCase": True},
                "replaceText": "Sample Product Title",
                "pageObjectIds": [new_slide_id],
            }
        },
        {
            "replaceAllText": {
                "containsText": {"text": "{{dims}}", "matchCase": True},
                "replaceText": '42"H x 30"W x 2"D',
                "pageObjectIds": [new_slide_id],
            }
        },
        {
            "replaceAllText": {
                "containsText": {"text": "{{desc}}", "matchCase": True},
                "replaceText": (
                    "Handcrafted oak frame with linen upholstery. "
                    "Available in natural and walnut finishes."
                ),
                "pageObjectIds": [new_slide_id],
            }
        },
        {
            "replaceImage": {
                "imageObjectId": image_element_id,
                "url": image_url,
                "imageReplaceMethod": "CENTER_CROP",
            }
        },
    ]

    batch_update(slides_svc, template_presentation_id, replace_requests)
    log.info("Text tokens replaced and image swapped.")

    # --- Done ---
    deck_url = f"https://docs.google.com/presentation/d/{template_presentation_id}/edit"
    log.info("=" * 60)
    log.info("SUCCESS — open the deck and inspect the new slide:")
    log.info("  %s", deck_url)
    log.info("=" * 60)
    log.info(
        "Definition of done: copy the new slide, paste into a DIFFERENT deck, "
        "confirm the image is movable and text boxes are editable."
    )


if __name__ == "__main__":
    main()
