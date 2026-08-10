import { useCallback, useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────
type Backdrop = 'check' | 'white' | 'dark'
type Tool = 'erase' | 'restore' | 'pan'

export interface MaskEditorProps {
  /** Vendor image URL — pre-rembg, fully opaque source (needed so restore reveals original pixels) */
  originalUrl: string
  /** GCS PNG with rembg alpha channel (initialises the mask) */
  rembgUrl: string
  /** Called with the mask-canvas PNG data-URL when user clicks Apply */
  onApply: (maskDataUrl: string) => void
  onCancel: () => void
}

// ── Constants ─────────────────────────────────────────────────────────────
const MAX_UNDO       = 20
const MIN_ZOOM_RATIO = 0.25   // relative to fit zoom
const MAX_ZOOM_RATIO = 16

const BACKDROP_STYLE: Record<Backdrop, React.CSSProperties> = {
  check: { backgroundImage: 'repeating-conic-gradient(#c8c8c8 0% 25%, #f0f0f0 0% 50%)', backgroundSize: '14px 14px' },
  white: { backgroundColor: '#ffffff' },
  dark:  { backgroundColor: '#1a1a1a' },
}

// ── Helpers ───────────────────────────────────────────────────────────────
const proxy = (url: string) => {
  if (!url || url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('/')) {
    return url
  }
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
export default function MaskEditor({ originalUrl, rembgUrl, onApply, onCancel }: MaskEditorProps) {

  // Working canvases (image resolution — never shown directly)
  const origRef = useRef<HTMLCanvasElement>(null) // vendor RGB source
  const maskRef = useRef<HTMLCanvasElement>(null) // editable alpha mask
  const offRef  = useRef<HTMLCanvasElement>(null) // composite scratch (orig × mask)

  // Visible canvas (container resolution × DPR)
  const dispRef      = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Painting / zoom / pan — all refs so event handlers don't go stale
  const imgW        = useRef(0)
  const imgH        = useRef(0)
  const dpr         = useRef(1)
  const fitZoom     = useRef(1)   // CSS-px per image-px at fit
  const zoomRef     = useRef(1)   // current total zoom
  const offsetRef   = useRef({ x: 0, y: 0 })   // pan in CSS px
  const modeRef     = useRef<Tool>('erase')
  const brushRef    = useRef(30)  // visual diameter in CSS px
  const blurRef     = useRef(0)   // 0 = hard edge, 100 = fully feathered
  const isPainting  = useRef(false)
  const isPanning   = useRef(false)
  const lastPtr     = useRef({ x: 0, y: 0 })
  const rafId       = useRef(0)
  const undoStack   = useRef<ImageData[]>([])
  const redoStack   = useRef<ImageData[]>([])
  const initMask    = useRef<ImageData | null>(null)  // rembg snapshot for Reset

  // UI state (triggers re-render for controls only)
  const [tool]            = useState<Tool>('erase')
  const [brushSize, setBrushSize] = useState(30)
  const backdrop: Backdrop = 'check'
  const [ready,     setReady]     = useState(false)
  const [loadErr,   setLoadErr]   = useState('')
  const [canUndo,   setCanUndo]   = useState(false)
  const [canRedo,   setCanRedo]   = useState(false)
  const [zoomPct,   setZoomPct]   = useState(100)

  // ── Core render (orig × mask → off → disp with zoom/pan) ──────────────
  const renderComposite = useCallback(() => {
    const orig = origRef.current
    const mask = maskRef.current
    const off  = offRef.current
    const disp = dispRef.current
    if (!orig || !mask || !off || !disp) return

    const W = imgW.current
    const H = imgH.current

    // Step 1: composite at image resolution
    const offCtx = off.getContext('2d')!
    offCtx.clearRect(0, 0, W, H)
    offCtx.globalCompositeOperation = 'source-over'
    offCtx.drawImage(orig, 0, 0)
    offCtx.globalCompositeOperation = 'destination-in'
    offCtx.drawImage(mask, 0, 0)
    offCtx.globalCompositeOperation = 'source-over'

    // Step 2: draw to display canvas, applying DPR + zoom + pan
    const dispCtx = disp.getContext('2d')!
    dispCtx.clearRect(0, 0, disp.width, disp.height)
    dispCtx.save()
    dispCtx.scale(dpr.current, dpr.current)
    dispCtx.translate(offsetRef.current.x, offsetRef.current.y)
    dispCtx.scale(zoomRef.current, zoomRef.current)
    dispCtx.drawImage(off, 0, 0)
    dispCtx.restore()
  }, [])

  // ── Initialise ────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true

    ;(async () => {
      try {
        const [origImg, rembgImg] = await Promise.all([
          loadImage(proxy(originalUrl)),
          loadImage(proxy(rembgUrl)),
        ])
        if (!alive) return

        const W = rembgImg.naturalWidth
        const H = rembgImg.naturalHeight
        imgW.current = W
        imgH.current = H
        dpr.current  = window.devicePixelRatio || 1

        // Working canvases at image resolution
        for (const r of [origRef, maskRef, offRef]) {
          if (r.current) { r.current.width = W; r.current.height = H }
        }

        // Display canvas at container resolution × DPR
        const container = containerRef.current!
        const cW = container.clientWidth  || 800
        const cH = container.clientHeight || 500
        const disp = dispRef.current!
        disp.width  = cW * dpr.current
        disp.height = cH * dpr.current
        disp.style.width  = `${cW}px`
        disp.style.height = `${cH}px`

        // Fit zoom (90% of container so there's a margin)
        const fz = Math.min(cW / W, cH / H) * 0.9
        fitZoom.current   = fz
        zoomRef.current   = fz
        offsetRef.current = { x: (cW - W * fz) / 2, y: (cH - H * fz) / 2 }

        // Draw vendor original (fully opaque) → origCanvas
        origRef.current!.getContext('2d')!.drawImage(origImg, 0, 0, W, H)

        // Extract rembg alpha → maskCanvas (R=G=B=255, A=rembg_alpha)
        // destination-in only reads the source alpha; storing white lets us debug mask visually.
        const tmp = document.createElement('canvas')
        tmp.width = W; tmp.height = H
        const tmpCtx = tmp.getContext('2d')!
        tmpCtx.drawImage(rembgImg, 0, 0, W, H)
        const rembgPx = tmpCtx.getImageData(0, 0, W, H)
        const maskCtx = maskRef.current!.getContext('2d')!
        const maskPx  = maskCtx.createImageData(W, H)
        for (let i = 0; i < rembgPx.data.length; i += 4) {
          maskPx.data[i]     = 255
          maskPx.data[i + 1] = 255
          maskPx.data[i + 2] = 255
          maskPx.data[i + 3] = rembgPx.data[i + 3]  // the actual mask value
        }
        maskCtx.putImageData(maskPx, 0, 0)

        // Snapshot for Reset
        initMask.current = maskCtx.getImageData(0, 0, W, H)

        if (alive) {
          setReady(true)
          renderComposite()
        }
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : 'Failed to load image')
      }
    })()

    return () => { alive = false }
  }, [originalUrl, rembgUrl, renderComposite])

  // Re-render once the canvas becomes visible (initial draw happened while it was hidden)
  useEffect(() => {
    if (ready) renderComposite()
  }, [ready, renderComposite])

  // Wheel handler — must be non-passive to call preventDefault
  useEffect(() => {
    if (!ready) return
    const canvas = dispRef.current!

    function handleWheel(e: WheelEvent) {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const cssX = e.clientX - rect.left
      const cssY = e.clientY - rect.top

      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const newZ = Math.max(
        fitZoom.current * MIN_ZOOM_RATIO,
        Math.min(zoomRef.current * factor, fitZoom.current * MAX_ZOOM_RATIO),
      )
      // Zoom toward pointer position
      const scale = newZ / zoomRef.current
      offsetRef.current = {
        x: cssX - scale * (cssX - offsetRef.current.x),
        y: cssY - scale * (cssY - offsetRef.current.y),
      }
      zoomRef.current = newZ
      setZoomPct(Math.round((newZ / fitZoom.current) * 100))
      renderComposite()
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [ready, renderComposite])

  // Keyboard shortcuts
  useEffect(() => {
    if (!ready) return
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo() }
      if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); doRedo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready])

  // ── Coordinate mapping (CSS px → image px) ────────────────────────────
  function toImg(e: React.PointerEvent) {
    const rect = dispRef.current!.getBoundingClientRect()
    return {
      imgX: (e.clientX - rect.left - offsetRef.current.x) / zoomRef.current,
      imgY: (e.clientY - rect.top  - offsetRef.current.y) / zoomRef.current,
    }
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────
  function snapshot() {
    const ctx = maskRef.current!.getContext('2d')!
    undoStack.current.push(ctx.getImageData(0, 0, imgW.current, imgH.current))
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift()
    redoStack.current = []
    setCanUndo(true); setCanRedo(false)
  }

  function doUndo() {
    if (!undoStack.current.length) return
    const ctx = maskRef.current!.getContext('2d')!
    redoStack.current.push(ctx.getImageData(0, 0, imgW.current, imgH.current))
    ctx.putImageData(undoStack.current.pop()!, 0, 0)
    setCanUndo(undoStack.current.length > 0); setCanRedo(true)
    renderComposite()
  }

  function doRedo() {
    if (!redoStack.current.length) return
    const ctx = maskRef.current!.getContext('2d')!
    undoStack.current.push(ctx.getImageData(0, 0, imgW.current, imgH.current))
    ctx.putImageData(redoStack.current.pop()!, 0, 0)
    setCanUndo(true); setCanRedo(redoStack.current.length > 0)
    renderComposite()
  }

  function doReset() {
    if (!initMask.current) return
    snapshot()
    maskRef.current!.getContext('2d')!.putImageData(initMask.current, 0, 0)
    renderComposite()
  }

  // ── Brush painting ────────────────────────────────────────────────────
  function paintAt(imgX: number, imgY: number) {
    const maskCtx = maskRef.current!.getContext('2d')!
    // Brush radius in image pixels — scales with zoom so it feels consistent visually
    const r = (brushRef.current / 2) / zoomRef.current
    const g = maskCtx.createRadialGradient(imgX, imgY, 0, imgX, imgY, r)

    // hardStop: fraction of radius that stays fully opaque before feathering begins.
    // blur=0 → hardStop=0.97 (crisp edge), blur=100 → hardStop=0 (full gradient).
    const hardStop = (1 - blurRef.current / 100) * 0.97

    if (modeRef.current === 'restore') {
      g.addColorStop(0, 'rgba(255,255,255,1)')
      if (hardStop > 0) g.addColorStop(hardStop, 'rgba(255,255,255,1)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      maskCtx.globalCompositeOperation = 'source-over'
    } else {
      g.addColorStop(0, 'rgba(0,0,0,1)')
      if (hardStop > 0) g.addColorStop(hardStop, 'rgba(0,0,0,1)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      maskCtx.globalCompositeOperation = 'destination-out'
    }

    maskCtx.fillStyle = g
    maskCtx.beginPath()
    maskCtx.arc(imgX, imgY, r, 0, Math.PI * 2)
    maskCtx.fill()
    maskCtx.globalCompositeOperation = 'source-over'

    cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(renderComposite)
  }

  // ── Pointer events ────────────────────────────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    if (!ready) return
    dispRef.current!.setPointerCapture(e.pointerId)
    lastPtr.current = { x: e.clientX, y: e.clientY }

    if (modeRef.current === 'pan' || e.button === 1) {
      isPanning.current = true
    } else {
      isPainting.current = true
      snapshot()
      const { imgX, imgY } = toImg(e)
      paintAt(imgX, imgY)
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (isPanning.current) {
      const dx = e.clientX - lastPtr.current.x
      const dy = e.clientY - lastPtr.current.y
      offsetRef.current = { x: offsetRef.current.x + dx, y: offsetRef.current.y + dy }
      lastPtr.current = { x: e.clientX, y: e.clientY }
      cancelAnimationFrame(rafId.current)
      rafId.current = requestAnimationFrame(renderComposite)
    } else if (isPainting.current) {
      const { imgX, imgY } = toImg(e)
      paintAt(imgX, imgY)
      lastPtr.current = { x: e.clientX, y: e.clientY }
    }
  }

  function onPointerUp() {
    isPainting.current = false
    isPanning.current  = false
  }

  // ── Fit to screen ─────────────────────────────────────────────────────
  function fitToScreen() {
    const container = containerRef.current!
    const cW = container.clientWidth
    const cH = container.clientHeight
    const fz = Math.min(cW / imgW.current, cH / imgH.current) * 0.9
    fitZoom.current   = fz
    zoomRef.current   = fz
    offsetRef.current = { x: (cW - imgW.current * fz) / 2, y: (cH - imgH.current * fz) / 2 }
    setZoomPct(100)
    renderComposite()
  }

  // ── Tool / brush helpers ──────────────────────────────────────────────
  function changeBrush(v: number) { brushRef.current = v; setBrushSize(v) }

  // ── Render ────────────────────────────────────────────────────────────

  const svgCursor = `<svg xmlns="http://www.w3.org/2000/svg" width="${brushSize}" height="${brushSize}"><circle cx="${brushSize/2}" cy="${brushSize/2}" r="${brushSize/2 - 1}" fill="none" stroke="black" stroke-width="1"/><circle cx="${brushSize/2}" cy="${brushSize/2}" r="${brushSize/2 - 2}" fill="none" stroke="white" stroke-width="1"/></svg>`
  const brushCursor = `url("data:image/svg+xml;utf8,${encodeURIComponent(svgCursor)}") ${brushSize/2} ${brushSize/2}, crosshair`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className="bg-white rounded-2xl shadow-2xl flex flex-col w-full max-w-4xl overflow-hidden"
        style={{ height: '88vh' }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <h3 className="font-semibold text-stone-800 text-sm">Edit cutout</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={fitToScreen}
              className="text-xs text-stone-400 hover:text-stone-700 border border-stone-200 px-2 py-0.5 rounded"
              title="Fit to screen"
            >
              Fit
            </button>
            <span className="text-xs text-stone-400 tabular-nums">{zoomPct}%</span>
            <button onClick={onCancel} className="text-stone-400 hover:text-stone-700 text-xl leading-none px-1">×</button>
          </div>
        </div>

        {/* Canvas area — fills remaining space; backdrop shows through transparent pixels */}
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden"
          style={{ minHeight: 0, ...BACKDROP_STYLE[backdrop] }}
        >
          {loadErr && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-red-500 text-sm bg-white/90 px-4 py-2 rounded-lg shadow">{loadErr}</p>
            </div>
          )}
          {!ready && !loadErr && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-stone-400 text-sm">Loading image…</p>
            </div>
          )}
          <canvas
            ref={dispRef}
            className={ready ? 'absolute top-0 left-0' : 'hidden'}
            style={{ cursor: tool === 'pan' ? 'grab' : brushCursor, touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>

        {/* Hidden working canvases */}
        <canvas ref={origRef} className="hidden" />
        <canvas ref={maskRef} className="hidden" />
        <canvas ref={offRef}  className="hidden" />

        {/* Toolbar */}
        <div className="shrink-0 px-5 py-3 border-t border-stone-200 flex items-center gap-4 flex-wrap">
          {/* Active Tool Indicator */}
          <span className="text-xs font-semibold px-3 py-1.5 rounded-md bg-stone-800 text-white select-none">
            ✏️ Erase
          </span>

          {/* Brush size */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-500 font-medium">Eraser Size:</span>
            <input
              type="range" min={4} max={120} value={brushSize}
              onChange={e => changeBrush(Number(e.target.value))}
              className="w-32 accent-stone-700"
            />
            <span className="text-xs font-semibold text-stone-700 w-8 tabular-nums">{brushSize}px</span>
          </div>

          <div className="w-px h-5 bg-stone-200 mx-1 shrink-0" />

          {/* Undo / Redo / Reset */}
          <button onClick={doUndo} disabled={!canUndo} className="text-xs font-medium text-stone-600 hover:text-stone-900 disabled:opacity-30 px-2.5 py-1.5 rounded hover:bg-stone-100 transition-colors" title="Undo ⌘Z">↩ Undo</button>
          <button onClick={doRedo} disabled={!canRedo} className="text-xs font-medium text-stone-600 hover:text-stone-900 disabled:opacity-30 px-2.5 py-1.5 rounded hover:bg-stone-100 transition-colors" title="Redo ⌘Y">↪ Redo</button>
          <button onClick={doReset} className="text-xs font-medium text-stone-500 hover:text-red-600 px-2.5 py-1.5 rounded hover:bg-red-50 transition-colors" title="Reset to initial cutout">Reset</button>

          <span className="flex-1" />

          <button onClick={onCancel} className="text-sm font-medium text-stone-500 hover:text-stone-800 px-3 py-1.5 rounded-lg hover:bg-stone-100 transition-colors">Cancel</button>
          <button
            disabled={!ready}
            onClick={() => onApply(offRef.current!.toDataURL('image/png'))}
            className="bg-stone-800 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors shadow-sm"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}
