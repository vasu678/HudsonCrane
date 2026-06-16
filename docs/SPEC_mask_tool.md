# Implementation Spec — Band 1 #3: Manual Mask Tool (Background-Removal Touch-Up)

> Hand to Claude Code alongside CLAUDE.md. Goal: let the user manually fix the automatic background removal on the HERO image — erase leftover background, restore wrongly-removed product pixels — before the slide is generated. Build on a feature branch (`feat/mask-tool`). This is FRONTEND-heavy and does NOT reuse the Slides-API machinery.

---

## 1. Goal & why

`rembg` is good but imperfect on furniture: it eats thin chair/table legs, loses glass/acrylic, leaves a faint halo or stray shadow pixels. The mask tool lets the user fix those by hand in a few seconds instead of rejecting the result. It edits ONLY the hero (supporting images are never background-removed, so they're untouched here).

**Scope this task to MVP. The SoW says "simple, intuitive." Do NOT build Photoshop.**

---

## 2. Core principle: non-destructive alpha-mask editing

Never edit the image pixels directly. Keep the original hero RGBA untouched and edit a separate **alpha mask** — a grayscale layer where **white = keep, black = remove**, grays = partial transparency (soft edges).

- Initialize the mask from rembg's output (rembg already produces an alpha channel → use it as the starting mask).
- Brushes paint white (restore) or black (erase) onto the mask.
- The displayed result is the original composited with the current mask, recomputed live.
- This makes erase/restore perfectly reversible and lets the user paint the same spot repeatedly without degrading anything.

---

## 3. Where it slots into the existing pipeline

Today: hero = download → rembg → downscale → upload GCS → public URL, then `/api/generate` uses that URL.

New flow inserts an optional manual step BETWEEN rembg and the final upload:

```
download hero → rembg → [auto cutout + its alpha mask]
        ↓
  show in mask editor (Review step)  ← user OPTIONALLY touches up
        ↓
  user clicks "Looks good" / "Apply"
        ↓
  final composite (original ∘ edited mask) at full res → transparent PNG → upload GCS → public URL
        ↓
  /api/generate (unchanged) uses that URL
```

Key point: the mask editing happens in the **browser** (canvas), and only the FINAL edited mask is sent to the backend for the full-res composite + upload. The user should be able to skip touch-up entirely (the auto result stays as-is) — touch-up is optional, hidden until they open it.

---

## 4. MVP feature set (build exactly these, no more)

- **Erase brush** — paint background pixels away (black onto mask).
- **Restore brush** — bring back wrongly-removed product pixels (white onto mask). *This is the one users need most (the "it deleted my table legs" fix).*
- **Brush size** — a slider.
- **Zoom & pan** — REQUIRED. Legs/edges are a few px wide; nobody fixes them at fit-to-screen. Build this before brushes feel usable.
- **Undo / redo** — snapshot the mask onto a small stack.
- **Backdrop toggle** — preview the cutout on checkerboard / white / dark. Light stray pixels are invisible on white but obvious on dark; this is how users FIND what to erase.
- **Soft (feathered) brush** — radial-gradient alpha so edges don't look jagged.
- **Apply / Reset** — Apply sends the edited mask; Reset reverts to the original rembg mask.

Explicitly NOT in MVP: magic-wand / edge-detection selection, auto-refine, layers, multiple history branches. (Band 3+ if ever.)

---

## 5. Frontend implementation (the core)

### 5a. Canvases
Use the HTML Canvas API (or Konva if the existing UI already leans on it). Maintain:
- `originalCanvas` — the hero image at working resolution (RGB).
- `maskCanvas` — the editable grayscale mask, initialized from rembg's alpha.
- `displayCanvas` — what the user sees: `original` then `mask` applied via `destination-in`.

```js
// paint onto the mask (mode = 'erase' | 'restore')
function paint(x, y, mode) {
  const r = brushSize / 2;
  const c = mode === 'restore' ? '255,255,255' : '0,0,0';
  const g = maskCtx.createRadialGradient(x, y, 0, x, y, r);  // soft edge
  g.addColorStop(0, `rgba(${c},1)`);
  g.addColorStop(1, `rgba(${c},0)`);
  maskCtx.globalCompositeOperation = 'source-over';
  maskCtx.fillStyle = g;
  maskCtx.beginPath();
  maskCtx.arc(x, y, r, 0, Math.PI * 2);
  maskCtx.fill();
  render();
}

function render() {
  displayCtx.clearRect(0, 0, w, h);
  displayCtx.drawImage(originalCanvas, 0, 0);
  displayCtx.globalCompositeOperation = 'destination-in';
  displayCtx.drawImage(maskCanvas, 0, 0);
  displayCtx.globalCompositeOperation = 'source-over';
}
```

### 5b. Coordinate mapping (critical, gets bugs)
Map pointer position → canvas pixel accounting for **zoom, pan, AND CSS scaling** (the canvas's displayed size vs its backing-store size). Get this right first or every brush stroke lands in the wrong place.

### 5c. High-DPI
Scale the canvas backing store by `devicePixelRatio` or edits look blurry on retina screens.

### 5d. Performance
Throttle `pointermove` with `requestAnimationFrame`. Edit at display resolution for responsiveness; keep the mask at the hero's working resolution for a clean export.

### 5e. Undo/redo
Snapshot the **mask** (not the display) onto a bounded stack (e.g., last 20 states). `getImageData` / `putImageData` is fine at these sizes.

---

## 6. Backend changes (small)

The final composite must happen at FULL resolution server-side (the user edits a possibly-downscaled mask in the browser; apply it to the original hero at full res for a crisp cutout).

### 6a. New/extended endpoint
Option (preferred): `POST /api/finalize-hero`
- Input: original hero reference (or re-download URL) + the edited mask (sent as a PNG data URL or uploaded blob).
- Steps: load original hero at full res → resize the edited mask to match → composite (`original` keep where mask is opaque) → output transparent PNG → upload GCS → return public URL.
- That URL becomes `hero_image_url` passed into `/api/generate`.

Use Pillow/OpenCV (already in the project) for the composite. Reuse the existing GCS upload.

### 6b. Keep the no-touch path working
If the user doesn't open the editor, behavior is exactly as today (auto rembg cutout used directly). The mask tool is purely additive.

---

## 7. UX placement
- In the single-product Review step, after the user picks the hero, show the auto cutout with an **"Edit cutout"** (optional) affordance.
- Opening it reveals the canvas + tools (modal or expanded panel). Default-closed so the frictionless path is unchanged.
- "Apply" returns the edited cutout into the flow; "Cancel"/skip keeps the auto result.
- (Two-product mode: nice-to-have to allow editing each hero, but if it complicates things, MVP = single-product hero only; note it and move on.)

---

## 8. Edge cases / gotchas
- **rembg alpha as starting mask** — make sure you read rembg's existing alpha rather than re-deriving a mask; that's the user's starting point.
- **Brush at zoom** — brush radius must scale with zoom so a "20px" brush feels consistent.
- **Mask/image size mismatch on export** — always resize the edited mask to the original's full-res dimensions before compositing; off-by-one scaling shows as a soft halo.
- **Transparent PNG only** — output must keep the alpha channel (PNG, never JPEG for the hero).
- **Don't block the slide** — if finalize fails, fall back to the un-edited auto cutout with a warning, don't crash generate.
- **Memory** — large hero images: edit at a capped working res (e.g., ≤1500px, matching the existing downscale) but composite at that same working res for export consistency.

---

## 9. Definition of done
- After auto background removal, the user can open an editor, **erase** leftover background and **restore** wrongly-removed product pixels, with brush-size control, zoom/pan, undo/redo, and a backdrop toggle.
- Edits are non-destructive (Reset returns the original rembg cutout exactly).
- "Apply" produces a full-res transparent PNG reflecting the edits, uploaded to GCS, and the generated slide uses it.
- Skipping the editor leaves today's behavior unchanged.
- Brush strokes land precisely under the cursor at any zoom/pan and on high-DPI screens.
- The hero in the final slide is crisp (no soft halo from mask scaling).

---

## 10. Out of scope for THIS task (do not gold-plate)
- Magic-wand / AI-assisted selection, auto edge-refine.
- Editing supporting images (they're never background-removed).
- Layers, non-linear history, filters.
- Any deploy / signed-URL work (Band 4).

---

## 11. Suggested commit breakdown (small, runnable steps)
1. Canvas scaffold: load hero + rembg alpha into original/mask/display canvases; render composite; backdrop toggle. No brushes yet — just confirm the cutout displays correctly.
2. Zoom/pan + correct pointer→canvas coordinate mapping (verify a click marks the exact pixel under the cursor at various zooms). High-DPI scaling.
3. Erase + restore brushes (soft, size slider) painting the mask; live render.
4. Undo/redo (mask snapshot stack); Reset to original rembg mask.
5. Backend `/api/finalize-hero`: composite edited mask at full res → transparent PNG → GCS → return URL.
6. Wire into Review step: optional "Edit cutout" → Apply returns the finalized hero URL into generate; skip path unchanged.
7. End-to-end test on a tricky product (e.g., a lamp with thin parts): erase a stray shadow, restore a thin leg, generate, confirm crisp transparent hero on the slide and that skipping still works.