import { useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────

type Backdrop = 'check' | 'white' | 'dark'

export interface MaskEditorProps {
  /** Vendor image URL (pre-rembg, fully opaque source — needed so restore works) */
  originalUrl: string
  /** GCS PNG with rembg alpha channel (initialises the mask) */
  rembgUrl: string
  /** Called with the display canvas data-URL when user clicks Apply */
  onApply: (dataUrl: string) => void
  onCancel: () => void
}

// ── Constants ─────────────────────────────────────────────────────────────

const BACKDROP_STYLE: Record<Backdrop, React.CSSProperties> = {
  check: {
    backgroundImage:
      'repeating-conic-gradient(#d4d4d4 0% 25%, #fafafa 0% 50%)',
    backgroundSize: '16px 16px',
  },
  white: { backgroundColor: '#ffffff' },
  dark:  { backgroundColor: '#1a1a1a' },
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Route image fetches through the backend proxy to avoid CORS taint. */
function proxy(url: string) {
  return `/api/image-proxy?url=${encodeURIComponent(url)}`
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload  = () => resolve(img)
    img.onerror = () => reject(new Error(`Could not load: ${src}`))
    img.src = src
  })
}

// ── Component ─────────────────────────────────────────────────────────────

export default function MaskEditor({
  originalUrl,
  rembgUrl,
  onApply,
  onCancel,
}: MaskEditorProps) {
  // Three canvases: original RGB source · editable alpha mask · visible composite
  const origRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const dispRef = useRef<HTMLCanvasElement>(null)

  const [backdrop, setBackdrop] = useState<Backdrop>('check')
  const [ready, setReady]       = useState(false)
  const [loadErr, setLoadErr]   = useState('')

  // ── Initialise on mount ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true

    ;(async () => {
      try {
        // Load both images through the proxy (avoids CORS taint on getImageData)
        const [origImg, rembgImg] = await Promise.all([
          loadImage(proxy(originalUrl)),
          loadImage(proxy(rembgUrl)),
        ])
        if (!alive) return

        // Work at rembg output resolution (already downscaled ≤1500px)
        const w = rembgImg.naturalWidth
        const h = rembgImg.naturalHeight

        for (const ref of [origRef, maskRef, dispRef]) {
          if (ref.current) { ref.current.width = w; ref.current.height = h }
        }

        // 1. Draw vendor original (fully opaque) → origCanvas
        //    This is the SOURCE for restore: even rembg-removed pixels keep their
        //    original RGB here, so painting alpha=255 back onto the mask reveals them.
        const origCtx = origRef.current!.getContext('2d')!
        origCtx.drawImage(origImg, 0, 0, w, h)

        // 2. Extract rembg alpha → maskCanvas
        //    Storage format: R=G=B=255, A=rembg_alpha
        //    destination-in compositing reads only the source alpha, so RGB is irrelevant
        //    here; white makes the mask visually inspectable if ever rendered directly.
        const tmp = document.createElement('canvas')
        tmp.width = w; tmp.height = h
        const tmpCtx = tmp.getContext('2d')!
        tmpCtx.drawImage(rembgImg, 0, 0, w, h)
        const rembgPixels = tmpCtx.getImageData(0, 0, w, h)

        const maskCtx  = maskRef.current!.getContext('2d')!
        const maskData = maskCtx.createImageData(w, h)
        for (let i = 0; i < rembgPixels.data.length; i += 4) {
          maskData.data[i]     = 255                        // R (white)
          maskData.data[i + 1] = 255                        // G (white)
          maskData.data[i + 2] = 255                        // B (white)
          maskData.data[i + 3] = rembgPixels.data[i + 3]   // A = rembg alpha (the actual mask)
        }
        maskCtx.putImageData(maskData, 0, 0)

        // 3. Render the initial composite
        renderComposite()

        if (alive) setReady(true)
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : 'Failed to load image')
      }
    })()

    return () => { alive = false }
  }, [originalUrl, rembgUrl])

  // ── Render composite (original ∘ mask) ────────────────────────────────
  //
  //  destination-in: result pixel alpha = origCanvas.alpha × maskCanvas.alpha
  //  origCanvas is fully opaque (alpha=255 everywhere), so:
  //    result alpha = 255 × mask_alpha / 255 = mask_alpha
  //  → transparent where rembg removed pixels, opaque where it kept them.
  //
  function renderComposite() {
    const disp = dispRef.current
    const orig = origRef.current
    const mask = maskRef.current
    if (!disp || !orig || !mask) return

    const ctx = disp.getContext('2d')!
    ctx.clearRect(0, 0, disp.width, disp.height)
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(orig, 0, 0)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(mask, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className="bg-white rounded-2xl shadow-2xl flex flex-col w-full max-w-3xl overflow-hidden"
        style={{ maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200 shrink-0">
          <h3 className="font-semibold text-stone-800 text-sm">Edit cutout</h3>
          <button
            onClick={onCancel}
            className="text-stone-400 hover:text-stone-700 text-xl leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Canvas viewport — backdrop shows through transparent canvas pixels */}
        <div
          className="flex-1 overflow-auto flex items-center justify-center p-4"
          style={{ minHeight: 0 }}
        >
          {loadErr && (
            <p className="text-red-500 text-sm text-center">{loadErr}</p>
          )}
          {!ready && !loadErr && (
            <p className="text-stone-400 text-sm">Processing image…</p>
          )}
          {ready && (
            <div className="inline-block rounded" style={BACKDROP_STYLE[backdrop]}>
              <canvas
                ref={dispRef}
                style={{ display: 'block', maxWidth: '100%', maxHeight: '58vh' }}
              />
            </div>
          )}
        </div>

        {/* Hidden working canvases (not shown to user) */}
        <canvas ref={origRef} className="hidden" />
        <canvas ref={maskRef} className="hidden" />

        {/* Toolbar */}
        <div className="shrink-0 px-5 py-3 border-t border-stone-200 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-stone-500 mr-1">Backdrop:</span>
          {(['check', 'white', 'dark'] as Backdrop[]).map(b => (
            <button
              key={b}
              onClick={() => setBackdrop(b)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                backdrop === b
                  ? 'bg-stone-800 text-white border-stone-800'
                  : 'border-stone-300 text-stone-500 hover:border-stone-500'
              }`}
            >
              {b === 'check' ? 'Checker' : b.charAt(0).toUpperCase() + b.slice(1)}
            </button>
          ))}

          <span className="text-xs text-stone-400 ml-2 hidden sm:inline">
            Brushes coming in next step
          </span>

          <span className="flex-1" />
          <button
            onClick={onCancel}
            className="text-sm text-stone-400 hover:text-stone-700 px-2"
          >
            Cancel
          </button>
          <button
            disabled={!ready}
            onClick={() => onApply(dispRef.current!.toDataURL('image/png'))}
            className="bg-stone-800 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
