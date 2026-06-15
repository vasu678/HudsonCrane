# Implementation Spec — Band 1 #2: Two-Product Layout

> Hand to Claude Code alongside CLAUDE.md. Goal: generate a single slide showing TWO products side by side, each with its own hero image + name + dimensions + description. Build on a feature branch (`feat/two-product-layout`); do not regress the single-product flow.

---

## 1. Goal

The firm's decks include slides with **two products side by side** (e.g., two side tables, two floor lamps), each with its own image + name + dimensions + description. Today the tool only makes single-product slides. This task adds a two-product mode.

**Confirmed decisions (defaults chosen):**
- **Trigger = two URLs → one slide.** User flips a "two-product slide" toggle, pastes two vendor links, scrapes both, picks a hero for each, generates ONE slide with both.
- **Just the two products.** Each product = its background-removed hero + name + dimensions + description. **No supporting images** on two-product slides (matches the reference decks; keeps this task small).

**Key constraints:**
- Do NOT break or regress the existing single-product flow. Two-product is an additional mode, not a replacement.
- Each product's hero IS background-removed (same as single-product hero).
- Preserve the layered/editable output and the "redesign the template anytime" property.

---

## 2. How it builds on what already exists

This reuses the exact mechanism from Band 1 #1 — duplicate a template slide, find elements by `{{token}}` / alt-text, replace. The only new things are: (a) a **second template slide** with two product blocks, (b) a **two-product input shape**, and (c) a **UI mode** that scrapes two URLs.

No new Google Slides API concepts. If single-product + supporting images works, this is mostly wiring.

---

## 3. The two-product template slide (one-time setup)

Add a **second slide** to the master template deck — call it the two-product template. It has two product blocks, A (left) and B (right). Tag everything with the same conventions as before:

**Text tokens** (found by `replaceAllText`):
- Product A: `{{title_a}}`, `{{dims_a}}`, `{{desc_a}}`
- Product B: `{{title_b}}`, `{{dims_b}}`, `{{desc_b}}`

**Image placeholders** (found by alt-text Title):
- Product A hero → alt-text Title `hero_a`
- Product B hero → alt-text Title `hero_b`

Position/size the two blocks per the reference decks (two products side by side). Set the alt-text Title via the Slides UI (right-click image → Alt text → Title) or the `updatePageElementAltText` API call, same as before.

**Record the two-product template slide's objectId** (e.g., as `TWO_PRODUCT_TEMPLATE_SLIDE_ID`) in config, alongside the existing single-product template slide ID. The generator needs to know which template to clone.

---

## 4. Contract change (update BOTH sides in one PR)

Add a new input shape for two-product generation. Do NOT overload the existing `ProductSlideInput` — keep single-product clean.

```python
# backend/app/shared/models.py
class ProductInput(BaseModel):          # one product's content (rename/reuse existing if cleaner)
    hero_image_url: str
    name: str
    dimensions: str                     # raw vendor format — NEVER normalize
    description: str

class TwoProductSlideInput(BaseModel):
    product_a: ProductInput
    product_b: ProductInput
```

```typescript
// shared/types.ts  (mirror)
interface ProductInput {
  heroImageUrl: string
  name: string
  dimensions: string
  description: string
}
interface TwoProductSlideInput {
  productA: ProductInput
  productB: ProductInput
}
```

(The existing single-product `ProductSlideInput` with `supporting_image_urls` stays exactly as-is for the single-product flow.)

---

## 5. Backend

### 5a. New endpoint `POST /api/generate-two`
Takes `TwoProductSlideInput`. Mirrors `/api/generate` but for two products and the two-product template.

Flow:
```
1. For product_a.hero_image_url and product_b.hero_image_url:
      download → rembg (remove bg) → downscale → upload GCS → public URL
      (reuse the EXISTING hero processing function — no new image code)
2. duplicateObject(TWO_PRODUCT_TEMPLATE_SLIDE_ID) → new_slide_id
3. presentations.get(new_slide_id) → build { alt_title: objectId } image map  (reuse existing helper)
4. batchUpdate:
     replaceAllText {{title_a}}/{{dims_a}}/{{desc_a}}  (scoped to new_slide_id)
     replaceAllText {{title_b}}/{{dims_b}}/{{desc_b}}
     replaceImage(map["hero_a"], hero_a_url, CENTER_INSIDE)
     replaceImage(map["hero_b"], hero_b_url, CENTER_INSIDE)
5. return { deck_url }
```

### 5b. Reuse, don't duplicate
- Hero image processing (download/rembg/downscale/upload) → reuse the existing function for both products.
- The alt-text `{ alt_title: objectId }` map builder from Band 1 #1 → reuse as-is.
- `CENTER_INSIDE` for both heroes (same reasoning as single hero: don't crop the product).

### 5c. Error handling
- Either hero failing (download/rembg/upload/replaceImage) is **fatal** for the two-product slide — both products are the point; a half-slide isn't useful. Return a clear error naming which product failed.
- No supporting images here, so no non-fatal image path.

---

## 6. Frontend (`frontend/src/App.tsx`)

Add a two-product mode without disturbing the single-product flow.

- **Step 1 (URL input):** add a toggle — "Single product" / "Two products". Default single.
  - Single → existing one-URL flow, unchanged.
  - Two → show **two** URL fields (Product A, Product B).
- **On Scrape (two mode):** scrape both URLs (call `/api/scrape` twice, or once each). Show two review blocks.
- **Step 2 (Review, two mode):** two side-by-side review panels (A and B), each with: its image grid (click to set that product's hero), and editable name/dims/description. No supporting selection in two-product mode.
- **Generate (two mode):** send `TwoProductSlideInput` to `/api/generate-two`.
- **Step 3 (Done):** same as now — "Open in Google Slides" link.

Keep it simple: two-product mode is essentially the single-product review UI shown twice, side by side, feeding one generate call.

---

## 7. Edge cases / gotchas
- **One URL scrapes, the other is blocked** (e.g., PerimeterX vendor): the blocked side falls back to manual entry (same as single-product). User can still type product B's fields and pick its image. Only block generation if a hero image is missing entirely.
- **Duplicated element IDs** — same rule as always: read IDs from the duplicated slide; never reuse template IDs.
- **Wrong template slide** — make sure `/api/generate-two` clones the two-product template, not slide 1. Config both IDs explicitly.
- **Alt text missing** on `hero_a`/`hero_b` → that image won't fill; log a clear message ("two-product template slot 'hero_b' not found — check alt text").
- **Don't regress single-product** — `/api/generate` and its template slide are untouched. Add, don't modify.

---

## 8. Definition of done
- Toggling "Two products", pasting two vendor URLs, picking a hero for each, and generating produces ONE slide with both products side by side, each showing its image + name + dimensions + description.
- Both heroes are background-removed.
- Single-product flow still works exactly as before (no regression).
- Copy the two-product slide into a fresh deck → all 8 elements (2 images + 6 text boxes) remain independently editable.
- Moving/resizing the two-product template's placeholders, then regenerating, still works (alt-text/token lookup holds).

---

## 9. Out of scope for THIS task (do not gold-plate)
- Supporting images on two-product slides (decision: not included).
- Choosing single vs two-product automatically / "Shuffle" between them (Band 3).
- More than two products per slide.
- Manual mask tool (Band 1 #3).
- Any deploy / signed-URL work (Band 4).

---

## 10. Suggested commit breakdown (small, runnable steps)
1. Contract: add `ProductInput` + `TwoProductSlideInput` (Python + TS), in sync.
2. One-time: build the two-product template slide; tag `{{*_a}}`/`{{*_b}}` tokens and `hero_a`/`hero_b` alt text; record its slide ID in config; verify via `presentations.get`.
3. Backend: add `/api/generate-two`, reusing the hero processor and the alt-text map helper. Test via API with two hardcoded products.
4. Frontend: single/two toggle + two URL fields + two review panels; wire to `/api/generate-two`.
5. End-to-end test: two Pottery Barn (or PB + Anthropologie) URLs → one two-product slide; confirm editability after paste; confirm single-product flow still works.