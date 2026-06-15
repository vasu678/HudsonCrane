# Implementation Spec — Band 1 #1: Supporting Images on the Slide

> Hand this to Claude Code alongside CLAUDE.md. Goal: place 0–2 supporting (lifestyle/detail) images on a generated slide, in addition to the background-removed hero. Build on a feature branch; keep the validated hero-only pipeline as fallback.

---

## 1. Goal

Today `/api/generate` places only the hero image. The firm's real slides show a hero cutout PLUS 1–2 supporting lifestyle/detail photos (kept as normal rectangles, NOT background-removed). This task adds those supporting images to the output slide.

**Key constraints (from the project):**
- Supporting images are NOT background-removed — they stay as rectangular photos.
- A product may have **0, 1, or 2** supporting images. The pipeline must handle all three cleanly.
- Must preserve the existing property: *the firm can redesign the template slide and future slides inherit the new layout.*
- Must not regress the layered/editable output.

---

## 2. Key design decision: identify image slots by ALT TEXT, not position

Text fields are found by `{{token}}` matching. Images can't hold tokens, and `replaceImage` targets an element by `objectId` — so we need a stable way to know *which* image element on the template is the hero vs. each support slot.

**Solution: tag each placeholder image in the template with alt-text.** Set the placeholder image's accessibility **Title** (alt text) to a known tag:
- hero placeholder → title `hero`
- first support placeholder → title `support1`
- second support placeholder → title `support2`

At generate time, read the duplicated slide's image elements and build a map `{ alt_title: objectId }`. This is the image analogue of the `{{token}}` approach: robust, and it survives the firm moving/resizing the placeholders (which preserves the "redesign anytime" property). **The one rule for editing the template:** if you delete and re-add a placeholder image, you must re-set its alt-text title. Moving/resizing is fine.

`replaceImage` keeps the element's position and size and only swaps the picture — so the placeholder defines *where/how big*, and the real image flows into that frame.

---

## 3. One-time template setup

In the master template deck, slide 1, add two more placeholder images for the supporting shots (any image; they're just frames), positioned per the reference layouts. Then tag all three image placeholders with alt text.

**Via the Slides UI:** right-click each image → Alt text → set **Title** to `hero`, `support1`, `support2` respectively.

**Or via API (reproducible, run once):**
```python
service.presentations().batchUpdate(presentationId=TEMPLATE_DECK, body={"requests": [
    {"updatePageElementAltText": {"objectId": HERO_PLACEHOLDER_ID, "title": "hero"}},
    {"updatePageElementAltText": {"objectId": SUPPORT1_PLACEHOLDER_ID, "title": "support1"}},
    {"updatePageElementAltText": {"objectId": SUPPORT2_PLACEHOLDER_ID, "title": "support2"}},
]}).execute()
```
(Also tag the existing hero placeholder `hero` so the generate code uses the same lookup path for all images.)

---

## 4. Updated end-to-end data flow

```
Scrape → images[] are VENDOR URLs
   ↓ (UI) user picks 1 hero + up to 2 supporting
ProductSlideInput { hero_image_url, supporting_image_urls[], name, dims, description }   ← all vendor URLs
   ↓ /api/generate
1. HERO:    download → rembg (remove bg) → downscale → upload GCS → hero_public_url
2. SUPPORT: for each supporting url → download → downscale (NO rembg) → upload GCS → support_public_url
3. duplicateObject(template slide 1) → new_slide_id
4. presentations.get(new_slide_id) → build { alt_title: objectId } for image elements
5. replaceAllText {{title}}/{{dims}}/{{desc}}  (scoped to new_slide_id)
6. replaceImage(map["hero"], hero_public_url, CENTER_INSIDE)
7. for i, url in enumerate(support_public_urls[:2]):  replaceImage(map[f"support{i+1}"], url, CENTER_CROP)
8. for unused support slots:  deleteObject(map[f"support{n}"])
9. return deck_url
```

---

## 5. Backend implementation detail

### 5a. Process supporting images (NEW — `backend/app/images/processor.py`)
Add a function that mirrors the hero path but **skips rembg**:
```python
def process_supporting_image(url: str) -> str:
    img = download(url)
    img = downscale(img, max_dim=1500)      # same limit as hero
    return upload_to_gcs(img, content_type="image/jpeg")  # returns public URL
```
**Why re-upload instead of using the vendor URL directly:** the Slides API fetches the image server-side from the URL. Many vendor images are hotlink-protected, require headers, or sit behind CDNs that reject Google's fetcher → `replaceImage` fails with `INVALID_ARGUMENT`. Re-hosting on GCS guarantees a fetchable, correctly-typed, size-bounded URL. (Hero already does this; do the same for supports, minus the background removal.)

### 5b. Build the alt-text → objectId map (NEW)
After duplicating, fetch with a field mask for speed:
```python
pres = service.presentations().get(
    presentationId=DECK_ID,
    fields="slides(objectId,pageElements(objectId,title,image))",
).execute()
slide = next(s for s in pres["slides"] if s["objectId"] == new_slide_id)
image_slots = {
    el["title"]: el["objectId"]
    for el in slide.get("pageElements", [])
    if "image" in el and el.get("title")
}
# image_slots == {"hero": "...", "support1": "...", "support2": "..."}
```

### 5c. Replace + delete (single batchUpdate)
```python
requests = [
    # text tokens (existing)
    {"replaceAllText": {"containsText": {"text": "{{title}}", "matchCase": True},
                        "replaceText": data.name, "pageObjectIds": [new_slide_id]}},
    {"replaceAllText": {"containsText": {"text": "{{dims}}", "matchCase": True},
                        "replaceText": data.dimensions, "pageObjectIds": [new_slide_id]}},
    {"replaceAllText": {"containsText": {"text": "{{desc}}", "matchCase": True},
                        "replaceText": data.description, "pageObjectIds": [new_slide_id]}},
    # hero
    {"replaceImage": {"imageObjectId": image_slots["hero"],
                      "url": hero_public_url, "imageReplaceMethod": "CENTER_INSIDE"}},
]

# supporting: fill what we have, delete the rest
support_urls = support_public_urls[:2]          # cap at slot count
for i in range(2):                              # slots support1, support2
    slot = image_slots.get(f"support{i+1}")
    if slot is None:
        continue                                # template has fewer slots than expected
    if i < len(support_urls):
        requests.append({"replaceImage": {"imageObjectId": slot,
                         "url": support_urls[i], "imageReplaceMethod": "CENTER_CROP"}})
    else:
        requests.append({"deleteObject": {"objectId": slot}})   # unused slot → remove

service.presentations().batchUpdate(presentationId=DECK_ID, body={"requests": requests}).execute()
```

### 5d. Error handling (IMPORTANT)
- **Hero failure is fatal** — if hero download/rembg/upload/replaceImage fails, the whole generate fails with a clear message.
- **Supporting failure is non-fatal** — if a supporting image fails to download/upload, skip that slot (treat it as "not provided" → it gets deleted), log a warning, and still return a slide. A bad lifestyle photo should never block the slide.
- Wrap each `replaceImage` reasoning in try/except at the processing stage (before batch) so a single bad URL is dropped from `support_public_urls` rather than failing the batch.

---

## 6. Frontend changes (`frontend/src/App.tsx`, Step 2 — Review)

Currently: click an image to set the single hero. Extend to also choose supporting images.

- Keep **one** hero selection (click → hero, highlighted distinctly, e.g. blue border + "HERO" badge).
- Add **supporting** selection: allow selecting up to **2** more images (different highlight, e.g. green border + "1"/"2" order badge). Clicking a 3rd should either replace the oldest or be disabled — cap at 2.
- Hero and supporting must be mutually exclusive (an image is hero OR support, not both).
- On Generate, send `ProductSlideInput` with `hero_image_url` = hero vendor URL and `supporting_image_urls` = the chosen support vendor URLs in selection order.
- Show a small caption near the grid: "Pick 1 hero (background removed) + up to 2 supporting (kept as-is)."

---

## 7. Variable count handling (the core requirement)

| Supporting images chosen | Behavior |
|---|---|
| 0 | Delete both `support1` and `support2` slots → hero-only slide |
| 1 | Fill `support1`, delete `support2` |
| 2 | Fill `support1` and `support2` |
| >2 | Cap at 2 (UI should prevent this; backend also slices `[:2]` defensively) |

Deleting unused slots leaves a clean slide (no empty placeholder boxes). A visible gap where a slot was is acceptable for this task.

**Refinement (NOT now — Band 3):** count-aware template selection — separate template slides for "hero only", "hero+1", "hero+2", chosen by count so the layout is balanced rather than gap-left. This ties into the Shuffle/variant work; do not build it here.

---

## 8. `imageReplaceMethod` choice
- **Hero → `CENTER_INSIDE`**: preserves the whole product cutout (don't crop the product); transparent area fills the frame.
- **Supporting → `CENTER_CROP`**: fills the rectangle edge-to-edge for a clean lifestyle look (cropping a lifestyle shot is fine).
- Make these constants so they're easy to flip if the firm prefers otherwise.

---

## 9. Edge cases / gotchas
- **Template has fewer image slots than expected** (e.g., someone removed `support2`): `image_slots.get(...)` returns None → skip safely (don't crash).
- **Duplicated element IDs** — still applies: read IDs from the *duplicated* slide (§5b), never reuse template IDs. (Already handled for hero; the alt-text map extends it.)
- **GCS size/type** — keep supports downscaled (≤1500px) and uploaded as JPEG; Slides API limits ~50MB / 25MP.
- **Alt text missing on a placeholder** → it won't appear in `image_slots` → that image won't be filled. Surface a clear log ("template image slot 'support1' not found — check alt text") to make template misconfig obvious.
- **Order stability** — supporting order = user's selection order; preserve it through the contract to the slots.

---

## 10. Definition of done
- Generating with **0** supporting images produces the same clean hero-only slide as today (no empty boxes).
- Generating with **1** fills support1, no leftover box.
- Generating with **2** fills both, positioned per the template.
- Supporting images are NOT background-removed; hero still is.
- A broken supporting image URL logs a warning and still yields a slide (hero + whatever worked).
- Copy the generated slide into a fresh deck → all images and text remain independently editable (no regression).
- Moving/resizing the placeholders in the template, then regenerating, still works (alt-text lookup holds).

---

## 11. Out of scope for THIS task (do not gold-plate)
- Count-aware template variants (Band 3).
- Two-product layout (Band 1 #2).
- Manual mask tool (Band 1 #3).
- Smart cropping / focal-point detection for CENTER_CROP.
- Any deploy / signed-URL work (Band 4).

---

## 12. Suggested commit breakdown (small, runnable steps)
1. Add `process_supporting_image()` (download + downscale + upload, no rembg) + unit-check on one URL.
2. One-time: add 2 placeholders to the template + set alt text on all three images; verify via `presentations.get`.
3. Replace hero-finding logic with the alt-text `image_slots` map (no behavior change yet — hero still works).
4. Add supporting replaceImage + delete-unused logic in `/api/generate`; test 0/1/2 via API directly (hardcoded inputs).
5. Frontend: supporting selection UI; wire to the contract.
6. End-to-end test on Pottery Barn with 0, 1, 2 supporting; verify editability after paste.