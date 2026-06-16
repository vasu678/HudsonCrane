# Implementation Spec — Band 2 (Part 1): Static Vendors — Four Hands, Rowe, York

> Hand to Claude Code alongside the project context. Goal: add real scrapers for the three STATIC vendors from the triage — Four Hands, Rowe Furniture, York Wallcoverings — behind a clean per-vendor interface. Build on a fresh feature branch `feat/band2-static-vendors` off `main`. (These three are static HTML; the GraphQL pair and the blocked vendor are separate, later tasks.)

---

## 1. Goal

The triage confirmed these three are static HTML with public data (name, dimensions, images; price is gated but we don't use it). Build a scraper for each that returns a populated `ProductSlideInput`-style result. **Four Hands is ~50% of the firm's volume — it's the priority; get it excellent first.**

No login handling needed (triage confirmed only price is gated). No Playwright needed for these three. No paid services.

---

## 2. Architecture: a per-vendor scraper registry

Refactor scraping so each vendor is an isolated adapter behind one interface. This keeps each site's quirks contained and makes adding vendors a small, safe task.

```python
# backend/app/scraping/base.py
class VendorScraper(Protocol):
    domain: str                          # e.g. "fourhands.com"
    def scrape(self, url: str) -> ScrapeResult: ...

# ScrapeResult: name, dimensions, description, images[]  (description may be "")
```

- A registry maps domain → scraper. `scrape(url)` picks the adapter by the URL's domain.
- Keep the **existing** generic scraper (httpx static → Playwright fallback) as the **default** for unknown domains — do NOT remove it. The registry just adds known-vendor adapters that override the default for those domains.
- Each adapter outputs the same shape, so the rest of the app (`/api/scrape`, the UI, generate) is unchanged.

---

## 3. Per-vendor adapters (quirks from the triage — bake these in)

### 3a. Four Hands (`fourhands.com`) — PRIORITY
- Data is a **Vue component prop**: an HTML-encoded JSON blob in the initial HTML. **No JSON-LD** — must locate and HTML-decode that blob, then `json.loads`.
- **Name:** from the JSON (and `og:title` as a sanity cross-check).
- **Dimensions:** the `dimensionsImperial` string, e.g. `30.75"w x 35.00"d x 30.75"h` — keep verbatim, do NOT normalize.
- **Description:** full description from the JSON.
- **Images:** ~4 per SKU, ~1200px, via CloudFront — collect the image URLs.
- Make extraction defensive: if the prop blob isn't found, fail with a clear message (Four Hands matters most — surface breakage loudly).

### 3b. Rowe Furniture (`rowefurniture.com`)
- Platform: **nopCommerce**. Data in an inline `var obj = {...}` JS block + `og:title`.
- **Name:** `og:title` / inline JSON.
- **Dimensions:** spec table, e.g. `"Dimensions (IN)": "L 84\" x D 34\" x H 35\""` — verbatim.
- **Description:** **systemically null** (`FullDescription: null`). This is NOT gating — the site just doesn't populate it. Return description as `""` (empty) and let the user type it in the UI. Do NOT treat empty description as an error.
- **Images:** ~2 per SKU. **CDN URLs contain literal spaces → URL-encode them** (e.g. spaces → `%20`) before they're used / re-hosted, or the Slides API fetch will fail.

### 3c. York Wallcoverings (`yorkwallcoverings.com`)
- Platform: **nopCommerce** (same as Rowe — reuse the Rowe parsing pattern where possible).
- **Name:** `og:title`.
- **Dimensions:** spec table BUT **wallpaper format** — fields like Roll Coverage, Repeat, Match (NOT W×D×H). Do NOT assume a W×D×H parser; capture the relevant wallpaper spec fields as the "dimensions" string, verbatim. (A furniture dimension parser will produce garbage here — handle the wallpaper shape explicitly.)
- **Description:** `og:description` is **always empty** → return `""`, user fills in (same as Rowe).
- **Images:** 1 product view per colour, 6 size variants, Azure CDN. Grab the product image(s).
- Note: B2B ordering is on a separate domain (`yorkwall.com`) — we only scrape the public `yorkwallcoverings.com` product pages.

---

## 4. Blank-description handling (Rowe + York)
- `ScrapeResult.description` may legitimately be `""`.
- `/api/scrape` returns it empty; the UI shows an empty (editable) description field as it already does; generation must work fine with an empty description (don't crash, don't block). Confirm the slide still generates cleanly with a blank description.

---

## 5. Dimensions: never normalize
Every vendor's dimension format differs (Four Hands `..w x ..d x ..h`, Rowe `L .. x D .. x H ..`, York wallpaper specs). Per the project rule, pass the vendor's raw string through unchanged. Do not reformat or reorder.

---

## 6. Reuse existing pipeline
- Adapters only produce the `ScrapeResult` (name/dims/desc/images). Everything downstream is unchanged: image selection, hero background removal, supporting images, GCS re-hosting, slide generation.
- Remember the existing image re-hosting step (download → GCS) already protects against hotlink issues — but URL-encode Rowe's spaced URLs BEFORE that step so the download itself succeeds.

---

## 7. Edge cases / gotchas
- **Unknown domain** → falls back to the existing generic scraper (don't break current behavior).
- **Four Hands prop blob missing / structure changed** → fail loudly with a clear message (it's the highest-value vendor).
- **Rowe/York empty description** → expected, return `""`, never an error.
- **Rowe spaced image URLs** → URL-encode or the fetch/re-host fails.
- **York wallpaper dimensions** → do not run a W×D×H parser on it; capture wallpaper spec fields as-is.
- **Multiple SKUs/variants/colours** → for now, scrape the product as presented at the given URL; don't try to enumerate every variant (variant handling is out of scope here).

---

## 8. Definition of done
- Pasting a Four Hands product URL returns name, dimensions (verbatim), description, and images, and generates a correct editable slide. (Verify on 2–3 different Four Hands products.)
- Rowe: returns name, dimensions, images; description empty; user can type description; slide generates cleanly. Spaced image URLs work (encoded).
- York: returns name, wallpaper-format dimensions (verbatim), images; description empty; slide generates.
- Unknown domains still use the existing generic scraper (no regression).
- All three go through the existing hero/supporting/generate flow unchanged.

---

## 9. Out of scope for THIS task
- Uttermost & Moe's (GraphQL — next task; try `/graphql` before Playwright).
- Surya (Cloudflare-blocked — needs paid unblocker; deferred pending client volume confirmation).
- Variant/colour/size enumeration.
- Any paid unblocker integration, deploy, or DB work.

---

## 10. Suggested commit breakdown (small, runnable steps)
1. Add the `VendorScraper` interface + domain registry; wire `scrape(url)` to pick by domain, defaulting to the existing generic scraper. No vendor adapters yet — confirm existing behavior unchanged.
2. **Four Hands adapter** (Vue-prop JSON parse). Test on 2–3 real product URLs → confirm all 4 fields + a generated slide.
3. **Rowe adapter** (nopCommerce inline JSON; empty description; URL-encode spaced image URLs). Test end-to-end.
4. **York adapter** (reuse Rowe pattern; wallpaper-format dimensions; empty description). Test end-to-end.
5. Regression check: an unknown/random vendor URL still works via the generic fallback; Pottery Barn + Anthropologie still work.