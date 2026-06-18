# Hudson & Crane — Slide Generator

A web tool for Hudson & Crane, an interior design firm, that turns a trade-vendor product URL into a layered, editable Google Slides slide. The firm builds client "selections" decks — one or two products per slide, each with a background-removed hero image, supporting photos, product name, dimensions, and description.

## How it works

1. Paste a vendor product URL (Pottery Barn, Four Hands, Uttermost, etc.)
2. The backend scrapes the page and extracts the product name, dimensions, description, and up to 16 images
3. Review the scraped data — pick the hero image (background removed automatically), add up to 2 supporting images, and edit any text
4. Optionally open the mask editor to touch up the background removal by hand
5. Generate — the backend clones a template slide, swaps in the images and text via the Google Slides API, and returns a link to the deck
6. Copy the new slide into your working presentation; every element is individually editable

Two-product mode works the same way with two URLs, producing a single side-by-side slide.

## Supported vendors

The scraper has a dedicated adapter for each of these vendors, which extracts structured data directly and reliably:

| Vendor | Method |
|--------|--------|
| Four Hands (`fourhands.com`) | Static HTML — Vue component JSON |
| Rowe Furniture (`rowefurniture.com`) | Static HTML — embedded JS object |
| York Wallcoverings (`yorkwallcoverings.com`) | Static HTML — OG tags + spec table |
| Uttermost (`uttermost.com`) | Direct GraphQL → Playwright fallback |
| Moe's Home (`moeshome.com`) | Direct GraphQL → Playwright fallback |

Any URL not matched to a known vendor goes through the generic scraper — static HTML first, Playwright (full Chrome) fallback for JS-rendered or bot-protected pages. Pottery Barn and Anthropologie work via this generic path. Home Depot and Wayfair are blocked by enterprise bot protection — use manual text entry for those.

## Tech stack

**Backend** — Python 3.12+, FastAPI, Uvicorn  
**Scraping** — httpx (static), Playwright + Chromium (JS-rendered / bot-protected pages), direct GraphQL for supported vendors  
**Background removal** — rembg (U2-Net), Pillow, OpenCV  
**Storage** — Google Cloud Storage (image hosting)  
**Slide generation** — Google Slides API + Google Drive API  
**Frontend** — React 19, TypeScript, Vite, Tailwind CSS 4

## Project structure

```
.
├── backend/
│   ├── app/
│   │   ├── main.py                  # FastAPI app — mounts API routers
│   │   ├── config.py                # Settings loaded from .env (pydantic-settings)
│   │   ├── api/
│   │   │   ├── scrape.py            # POST /api/scrape
│   │   │   ├── generate.py          # POST /api/generate, /api/generate-two
│   │   │   └── images.py            # POST /api/process-hero, /api/finalize-hero, GET /api/image-proxy
│   │   ├── models/
│   │   │   ├── slide.py             # ProductSlideInput, TwoProductSlideInput
│   │   │   └── requests.py          # ScrapeRequest/Response and other wire types
│   │   ├── services/
│   │   │   ├── image_processor.py   # Download, background removal, GCS upload
│   │   │   └── slide_generator.py   # Google Slides API — clone template, replace content
│   │   └── scraping/
│   │       ├── scraper.py           # Generic static + Playwright scraper (fallback)
│   │       ├── base.py              # ScrapeResult TypedDict + VendorScraper Protocol
│   │       ├── registry.py          # Domain → adapter registry; unknown → generic
│   │       └── vendors/
│   │           ├── four_hands.py    # Four Hands adapter
│   │           ├── rowe.py          # Rowe Furniture adapter
│   │           ├── york.py          # York Wallcoverings adapter
│   │           ├── uttermost.py     # Uttermost adapter (GraphQL)
│   │           └── moeshome.py      # Moe's Home adapter (GraphQL)
│   ├── scripts/                     # One-off dev and diagnostic scripts (not production)
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── App.tsx                  # Root shell — mode toggle, view routing
│       ├── types.ts                 # Shared UI types
│       ├── views/
│       │   ├── SingleProductView.tsx
│       │   └── TwoProductView.tsx
│       └── components/
│           ├── MaskEditor.tsx       # Canvas-based background-removal touch-up tool
│           └── ProductPanel.tsx
├── shared/
│   └── types.ts                     # Wire-format contract (keep in sync with models/)
├── docs/
│   └── SPEC_*.md                    # Feature specs
└── CLAUDE.md                        # Project context for Claude Code
```

## Prerequisites

- Python 3.12+
- Node.js 20+
- A Google Cloud project with the **Slides API** and **Drive API** enabled
- A GCS bucket for image hosting
- OAuth 2.0 Desktop app credentials downloaded as `client_secrets.json`
- A GCS service account key downloaded as `gcs_key.json`

## Setup

### 1. Clone and create the template deck

Create a Google Slides presentation with two template slides:

- **Single-product slide:** text boxes containing `{{title}}`, `{{dims}}`, `{{desc}}`; three images with alt-text titles `hero`, `support1`, `support2`
- **Two-product slide:** text boxes `{{title_a}}`, `{{dims_a}}`, `{{desc_a}}`, `{{title_b}}`, `{{dims_b}}`, `{{desc_b}}`; two images with alt-text titles `hero_a`, `hero_b`

Note the presentation ID (from the URL) and each slide's object ID.

### 2. Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

Copy the environment file and fill in your values:

```bash
cp .env.example .env
```

```env
GCS_BUCKET_NAME=your-bucket-name
TEMPLATE_PRESENTATION_ID=your-presentation-id
TEMPLATE_SLIDE_ID=your-single-product-slide-id
TWO_PRODUCT_TEMPLATE_SLIDE_ID=your-two-product-slide-id
OAUTH_CLIENT_SECRETS_FILE=client_secrets.json
GOOGLE_APPLICATION_CREDENTIALS=gcs_key.json
```

Place `client_secrets.json` and `gcs_key.json` in the `backend/` directory. These are gitignored — never commit them.

Start the backend:

```bash
uvicorn app.main:app --reload --port 8000
```

On first run, a browser window will open for Google OAuth. Approve it; the token is saved to `token.pickle` for subsequent runs.

The first background-removal job downloads the U2-Net model (~176 MB) to `~/.u2net/`. This is cached after the first run.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Running with Docker

Docker runs both the backend and the frontend (built and served by nginx, which also proxies `/api/` to the backend).

**Before first run**, you must generate `token.pickle` locally — the OAuth flow opens a browser window which Docker cannot do:

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --port 8000
# approve in the browser, then Ctrl-C
```

Then start everything:

```bash
cp backend/.env.example backend/.env   # fill in your values
docker compose up --build
```

The app is available at `http://localhost`. The backend API is also directly accessible at `http://localhost:8000`.

The U2-Net model (~176 MB) downloads into a named Docker volume (`u2net_cache`) on the first background-removal job and is reused on subsequent runs.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/scrape` | Scrape a vendor URL; returns name, dims, description, images |
| `POST` | `/api/generate` | Single-product slide generation |
| `POST` | `/api/generate-two` | Two-product slide generation |
| `POST` | `/api/process-hero` | Run background removal on a URL; returns GCS URL |
| `POST` | `/api/finalize-hero` | Apply browser-edited mask to original image; returns GCS URL |
| `GET` | `/api/image-proxy` | Proxy an image URL through the backend (CORS workaround for canvas) |

## Mask editor

The mask editor lets users fix automatic background removal before generating a slide. It opens as a modal when the user clicks "Edit cutout" after scraping.

- **Erase** — paint background pixels away
- **Restore** — bring back wrongly-removed product pixels
- **Brush size** — adjustable slider
- **Zoom and pan** — scroll to zoom; Pan tool or middle-click to pan
- **Undo / Redo** — up to 20 steps; keyboard shortcuts Cmd+Z / Cmd+Y
- **Backdrop toggle** — checkerboard, white, or dark background to spot stray pixels
- **Reset** — revert to the original automatic cutout

Editing is non-destructive. The original image and the rembg mask are kept separate; brushes only modify the mask. Clicking Apply sends the edited mask to `/api/finalize-hero`, which composites it with the original at full resolution and uploads the result to GCS.

Skipping the editor leaves the automatic cutout unchanged.

## Known limitations

- Home Depot and Wayfair are blocked by PerimeterX enterprise bot protection — use manual text entry for those.
- Anthropologie scrapes name and images but not dimensions (dimensions are JS-rendered; the static page carries enough data to avoid escalating to Playwright). User can fill dimensions in manually.
- Background removal can struggle with thin legs, glass, or reflective surfaces. The mask editor exists to fix these cases.
- The template deck accumulates generated slides over time — no cleanup is implemented yet.
- GCS bucket is currently public-read. Signed short-expiry URLs are planned before production deployment.
- OAuth is a local desktop flow. A proper web OAuth flow is needed for multi-user or deployed use.
- Not deployed — local development only.

## Secrets and security

The following files are gitignored and must never be committed:

- `backend/client_secrets.json` — Google OAuth credentials
- `backend/gcs_key.json` — GCS service account key
- `backend/token.pickle` — saved OAuth token
- `backend/.env` — environment variables

## Roadmap

- **Band 3** — multiple template variants, LLM-assisted template selection, in-browser preview
- **Band 4** — deploy to Cloud Run + Vercel, signed GCS URLs, production OAuth flow
