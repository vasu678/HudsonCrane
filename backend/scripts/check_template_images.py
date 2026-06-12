"""
Read-back script: print title + objectId of every image element on the
template slide so you can confirm hero / support1 / support2 are tagged.

Usage (from repo root):
    cd backend
    TEMPLATE_PRESENTATION_ID=<your-id> python spikes/check_template_images.py
"""

import os
import pickle
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/presentations.readonly",
]
TOKEN_PATH = Path("token.pickle")
CLIENT_SECRETS = os.environ.get("OAUTH_CLIENT_SECRETS_FILE", "client_secrets.json")
PRESENTATION_ID = os.environ.get("TEMPLATE_PRESENTATION_ID", "")

if not PRESENTATION_ID:
    sys.exit("Set TEMPLATE_PRESENTATION_ID env var first.")


def _get_creds() -> Credentials:
    creds = None
    if TOKEN_PATH.exists():
        creds = pickle.loads(TOKEN_PATH.read_bytes())
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRETS, SCOPES)
            creds = flow.run_local_server(port=0)
        TOKEN_PATH.write_bytes(pickle.dumps(creds))
    return creds


def main() -> None:
    svc = build("slides", "v1", credentials=_get_creds())
    pres = svc.presentations().get(
        presentationId=PRESENTATION_ID,
        fields="slides(objectId,pageElements(objectId,title,image))",
    ).execute()

    for slide in pres["slides"]:
        images = [el for el in slide.get("pageElements", []) if "image" in el]
        if not images:
            continue
        print(f"\nSlide  {slide['objectId']}")
        print(f"  {'title':<20}  objectId")
        print(f"  {'-'*20}  {'-'*44}")
        for el in images:
            title = el.get("title") or "(no title set)"
            print(f"  {title:<20}  {el['objectId']}")

    print("\nExpected titles on your template slide: hero, support1, support2")


if __name__ == "__main__":
    main()
