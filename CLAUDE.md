# CLAUDE.md — Hudson & Crane Slide Generator

> Project context for Claude Code. Read fully before writing code. This file is the source of truth.
> **Status: end-to-end pipeline built and validated. Single-product (hero + up to 2 supporting) AND two-product slides working. Now building Band 1 #3 (manual mask tool).**

---

## 1. What this is

A web tool for an interior-design firm (**Hudson & Crane**) that turns a trade-vendor product URL into a **layered, editable Google Slides** slide. The firm builds client "selections" decks: one (or two) products per slide, each with a product photo + name + dimensions + description.

**Flow (working today):** paste vendor URL(s) → scrape page → user reviews images + text → pick hero(es) (+ up to 2 supporting in single-product mode) → background removed from hero(es) → template slide cloned via Slides API → text + images swapped in → user copies the slide into their deck with everything still editable.

**Unit of work:** a single product slide (or a two-product slide) inserted into an existing deck. The tool does NOT generate title slides, dividers, floor plans, or the contact slide.

---

## 2. The load-bearing requirement: "layered" output (VALIDATED)

Output must be **distinct, individually editable native Google Slides objects** (separate text boxes + image elements + background), NOT a flattened image. The firm pastes the slide into their deck and edits it by hand. Proven working for both single- and two-product slides — copied into another deck with images draggable and text editable, nothing grouped/tangled. Do NOT regress this by rendering to a picture. Export goes through the Google Slides API only.

---

## 3. Current built state

### Working end-to-end
`paste URL(s) → /api/scrape → review in UI → /api/generate or /api/generate-two → editable slide in a deck`. Validated on Pottery Barn (bot-protected) and Anthropologie (static).

### Infrastructure (GCP)
- Project: `neon-reporter-499015-d8`. Google Slides API + Drive API enabled.
- OAuth 2.0 (Desktop app) → `client_secrets.json` (LOCAL, gitignored). User token → `token.pickle` (LOCAL, gitignored).
- GCS bucket `hudson-crane-assets` (us-central1, currently public-read). Service account `hudson-crane-uploader` (Storage Object Creator) → `gcs_key.json` (LOCAL, gitignored).
- ⚠️ Bucket is public-read for now. Before production, switch to **signed, short-expiry URLs** (Slides API only needs the URL at insert time; images can be ephemeral). Tracked in §6 Band 4.

### Backend (FastAPI — `backend/app/main.py`)
- `POST /api/scrape` — takes a vendor URL, returns `{ name, dimensions, description, images[] }`.
- `POST /api/generate` — single-product. Takes `ProductSlideInput`; places hero + up to 2 supporting images; returns `{ deck_url }`.
- `POST /api/generate-two` — two-product. Takes `TwoProductSlideInput` (product A + B); places two background-removed heroes side by side, each with its own title/dims/desc; returns `{ deck_url }`.

### Image handling (`backend/app/images/processor.py`)
- **Hero (single & both two-product heroes):** download → `rembg` (U²-Net, self-hosted) remove background → downscale (max 1500px) → upload GCS → public URL. (First run downloads the 176MB U²-Net model, cached at `~/.u2net/`.)
- **Supporting (single-product only):** download → downscale (max 1500px) → re-host on GCS as JPEG, **no background removal** → public URL. Re-hosting is required because the Slides API fetches images server-side and many vendor URLs are hotlink-protected (would fail `replaceImage` with `INVALID_ARGUMENT`).

### Scraping (`backend/app/scraping/scraper.py`)
- Static `httpx` fetch first; **Playwright (full Chrome) fallback** for JS-rendered / bot-protected pages.
- Extracts from `schema.org/Product` JSON-LD + OG tags: name, dimensions (the "Overall:" spec line), description (HTML-stripped, ~250-char cut at a sentence boundary), up to 16 images. Unwraps Google redirect URLs.
- **Known vendor results so far:** Pottery Barn ✅ (Playwright), Anthropologie ✅ (static). Home Depot / Wayfair ❌ blocked by PerimeterX (enterprise bot protection) — manual-entry fallback covers these; a paid unblocker (ScraperAPI/Zyte/Bright Data) is the v2 fix, behind a config switch (Band 2).

### Slide generation / template system (`backend/app/slides/generator.py`)
- Master template deck with TWO template slides:
  - **Single-product template:** `{{title}}`/`{{dims}}`/`{{desc}}` text boxes + 3 image placeholders tagged by alt-text Title: `hero`, `support1`, `support2`.
  - **Two-product template:** `{{title_a}}`/`{{dims_a}}`/`{{desc_a}}` + `{{title_b}}`/`{{dims_b}}`/`{{desc_b}}` text boxes + 2 image placeholders tagged `hero_a`, `hero_b`.
  - Both template slide IDs are recorded in config so the generator clones the right one.
- Generate = `duplicateObject` the right template slide → `presentations.get` the new slide to read NEW element IDs → build `{ alt_title: objectId }` image map → `replaceAllText` the tokens → `replaceImage` heroes (`CENTER_INSIDE`) and any supporting (`CENTER_CROP`) → `deleteObject` any unused support slot.
- Single-product supporting count: 0 → both support slots deleted; 1 → fill support1, delete support2; 2 → fill both. Broken supporting URL is non-fatal (logged, slot dropped). Hero failure is fatal (for two-product, either hero missing is fatal).
- **Key property (do not break):** the firm can redesign a template slide (move/resize elements) and future slides inherit the new layout, because lookups are by `{{token}}` / alt-text, not position. The one rule: if a placeholder image is deleted and re-added, its alt-text Title must be re-set.

**CRITICAL gotcha (handled, keep it):** `duplicateObject` gives duplicated elements NEW objectIds. Always read IDs from the duplicated slide before `replaceImage`/`deleteObject`. Never reuse template IDs.

### Frontend (React — `frontend/src/App.tsx`)
- **Mode toggle:** "Single product" / "Two products".
- Single mode: 3 steps — (1) URL input + Scrape. (2) Review — image grid; click to set hero (blue/"HERO" badge), toggle to pick up to 2 supporting (green numbered badges, order preserved); editable name/dims/description. (3) Done — "Open in Google Slides" link.
- Two mode: two URL fields (Product A, Product B) + "Scrape Both" → two side-by-side review panels, each picking that product's hero + editing its text → one generated two-product slide. (No supporting images in two-product mode.)

---

## 4. The shared contract (do not break)

Python (`backend/app/shared/models.py`) and TS (`shared/types.ts`) must stay in sync.

```python
class ProductSlideInput(BaseModel):       # single-product
    hero_image_url: str
    supporting_image_urls: list[str]
    name: str
    dimensions: str  # raw vendor format — NEVER normalize
    description: str

class ProductInput(BaseModel):            # one product's content (used by two-product)
    hero_image_url: str
    name: str
    dimensions: str
    description: str

class TwoProductSlideInput(BaseModel):    # two-product
    product_a: ProductInput
    product_b: ProductInput
```

---

## 5. Confirmed product decisions (do not re-litigate)

- Tool extracts product **name, dimensions, description** from the vendor page (user can edit before export). Does NOT author new copy.
- **Arbitrary, growing vendor list** — generic scraping (structured data first, browser fallback), no permanent per-vendor hardcoding. Extraction is best-effort; perfect coverage of every site is NOT guaranteed (some vendors need a paid unblocker or manual entry).
- Multiple images per slide; user designates ONE **hero** (background-removed) vs **supporting** images (kept as rectangles, NOT background-removed). Two-product slides = two heroes, no supporting.
- Output is Google Slides only.

### Open assumption to validate with client (NOT yet confirmed)
The two-product **trigger** (paste two URLs → one slide) is OUR design default, not a client request. Show Jaye the UI and confirm it matches her mental model before building anything that depends on this flow.

---

## 6. Roadmap — priority order

### Band 1 — make slides look like their decks
1. ✅ **DONE & merged — supporting images** (hero + up to 2 supporting via alt-text slots).
2. ✅ **DONE & merged — two-product layout** (two URLs → one side-by-side slide; `/api/generate-two`).
3. **NEXT — manual mask tool.** Background-removal touch-up. Non-destructive alpha-mask canvas: erase/restore brushes, brush size, zoom/pan, undo, soft edges, full-res PNG export. **Frontend-heavy** — does NOT reuse the Slides-API machinery; most self-contained piece (good to parallelize / hand to Vasu).

### Band 2 — live up to "any vendor"
- Test more real H&C vendors (get the actual vendor list from the client first).
- Add a paid unblocker (ScraperAPI/Zyte/Bright Data) behind a config switch for bot-protected vendors. Keep the scraper backend pluggable: `fetch_html(url)` with `direct → playwright → unblocker`.
- Open question to confirm with client: are some vendors trade-login-gated (data only visible after login)? Separate, bigger design question — flag, don't build.
- Graceful partial-failure: return what was extracted, let the user fill the rest in manually (already works).

### Band 3 — smarter layout engine
- "Shuffle" cycles real template variants. LLM-assisted template selection (single vs two-product; by image aspect ratio + text length). Count-aware template variants (hero-only / +1 / +2). In-UI instant preview before export.

### Band 4 — productionize
- Deploy: Cloud Run (backend) + Vercel/Netlify (frontend).
- GCS → signed short-expiry URLs (replaces public-read; closes data exposure + cost).
- Template-deck cleanup (it currently accumulates every generated slide).
- Real OAuth flow (own-account vs shared — open client question). Logging, error handling, reliability.

---

## 7. Known limitations (current)
- Only Pottery Barn + Anthropologie tested; Home Depot/Wayfair blocked (PerimeterX) → manual entry for now.
- No manual mask tool yet (Band 1 #3 — next).
- Description truncation is a fixed 250-char cut.
- Two-product trigger (two URLs) is an unvalidated assumption — confirm with client.
- Template deck accumulates generated slides — no cleanup yet.
- Public-read GCS bucket (→ signed URLs before prod).
- Not deployed (local only).

---

## 8. Reference facts (from the firm's real decks)
- **Fonts:** Montserrat Light (body), Permanent Marker (accent), Arial (fallback) — all Google Fonts, render natively via Slides API.
- **Slide anatomy:** hero cutout + 0–2 supporting images + name + dimensions + description, over a light-textured brand background. Two-product slides show two products side by side.
- **Content conventions:** some names end with `*` (footnote); some slides show a price, most don't; dimension formats vary wildly and are copied verbatim from vendors — PRESERVE raw format, do NOT normalize.
- Real decks are 150–320 MB (full-res images) → compress images before upload (already downscaling to 1500px).

---

## 9. Conventions
- Trunk-based git: short feature branches, PR-reviewed, squash-merge into protected `main`. Build new work on a feature branch; keep validated pipeline as a stable fallback.
- NEVER commit secrets: `client_secrets.json`, `gcs_key.json`, `token.pickle`, `.env` (all gitignored). Verify with `git status` before each commit. Pin dependencies.
- Python: type hints + Pydantic. TS: strict mode.
- Change a shared contract type → update BOTH sides in the same PR.
- Prefer small, runnable increments over large unverified changes.
- When a Band item closes: merge → update THIS file (move it from Roadmap to Built state, fix Limitations) → start next task. Keep CLAUDE.md honest.
- If a client demo gets scheduled: FREEZE the build, harden one path, rehearse. Building and demoing are different modes.

---

## 10. Open client questions (don't block on these)
Which vendors they actually use most (+ whether any are trade-login-gated); confirm the two-product trigger UI; internal tool vs external product; own-Google-account vs shared; paid background-removal / unblocker budget; exact brand assets (palette, logo, slide dimensions, background); meaning of `*`; whether price is slide content; daily volume. Also: the arbitrary-vendor best-effort caveat is not yet in the client-facing SoW — get it in before a vendor scrapes badly.