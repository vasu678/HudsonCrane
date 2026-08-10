import { useCallback, useEffect, useState } from 'react'
import MaskEditor from '../components/MaskEditor'

interface CutoutItem {
  id: string
  originalUrl: string
  cutoutUrl: string
  timestamp: Date
}

export function CutoutStudioView() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [previewImage, setPreviewImage] = useState<string>('')

  // Active Cutout state
  const [activeItem, setActiveItem] = useState<CutoutItem | null>(null)
  const [history, setHistory] = useState<CutoutItem[]>([])

  // Toast / Copy Feedback
  const [copiedText, setCopiedText] = useState('')

  // Mask editor modal
  const [showEditor, setShowEditor] = useState(false)
  const [finalizing, setFinalizing] = useState(false)

  const handleFileUpload = useCallback(async (file: File) => {
    setLoading(true)
    setError('')
    const objUrl = URL.createObjectURL(file)
    setPreviewImage(objUrl)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/upload-cutout', {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || 'Failed to process uploaded image')
      }
      const data = await res.json()
      const item: CutoutItem = {
        id: Math.random().toString(36).slice(2, 9),
        originalUrl: data.original_url || URL.createObjectURL(file),
        cutoutUrl: data.cutout_url,
        timestamp: new Date(),
      }
      setActiveItem(item)
      setHistory(prev => [item, ...prev])
    } catch (err: any) {
      setError(err.message || 'Failed to upload image')
    } finally {
      setLoading(false)
      setPreviewImage('')
    }
  }, [])

  const handleProcessUrl = useCallback(async (urlStr: string) => {
    if (!urlStr.trim()) return
    setLoading(true)
    setError('')
    setPreviewImage(urlStr.trim())
    try {
      const res = await fetch('/api/process-hero', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlStr.trim() }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || 'Failed to remove background from URL')
      }
      const data = await res.json()
      const item: CutoutItem = {
        id: Math.random().toString(36).slice(2, 9),
        originalUrl: urlStr.trim(),
        cutoutUrl: data.hero_url,
        timestamp: new Date(),
      }
      setActiveItem(item)
      setHistory(prev => [item, ...prev])
    } catch (err: any) {
      setError(err.message || 'Failed to remove background from URL')
    } finally {
      setLoading(false)
      setPreviewImage('')
    }
  }, [])

  const handlePasteEvent = useCallback((e: React.ClipboardEvent | ClipboardEvent) => {
    const clipboard = 'clipboardData' in e ? e.clipboardData : null
    if (!clipboard) return

    if (clipboard.files && clipboard.files.length > 0) {
      for (let i = 0; i < clipboard.files.length; i++) {
        const file = clipboard.files[i]
        if (file && (file.type.indexOf('image') !== -1 || file.size > 0)) {
          e.preventDefault()
          e.stopPropagation()
          setError('')
          handleFileUpload(file)
          return
        }
      }
    }

    const items = clipboard.items
    if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' || items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile()
          if (file && file.size > 0) {
            e.preventDefault()
            e.stopPropagation()
            setError('')
            handleFileUpload(file)
            return
          }
        }
      }
    }

    const text = clipboard.getData('text') || ''
    const html = clipboard.getData('text/html') || ''

    // 3a. Check for <img src="..."> in HTML first (Google Slides, web pages)
    const imgSrcMatch = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i)
    if (imgSrcMatch && imgSrcMatch[1]) {
      e.preventDefault()
      e.stopPropagation()
      setError('')
      handleProcessUrl(imgSrcMatch[1].trim())
      return
    }

    // 3b. Check for direct image URLs (.png, .jpg, googleusercontent, etc.) in text or HTML
    const combined = `${text} ${html}`
    const imgUrlMatch = combined.match(/https?:\/\/[^\s"'<>]*(?:googleusercontent\.com|lh\d+\.googleusercontent\.com|\.png|\.jpg|\.jpeg|\.webp)[^\s"'<>]*/i)
    if (imgUrlMatch && imgUrlMatch[0]) {
      e.preventDefault()
      e.stopPropagation()
      setError('')
      handleProcessUrl(imgUrlMatch[0].trim())
      return
    }

    // 3c. Fallback to any valid URL that is NOT docs.google.com/presentation
    const anyUrlMatch = combined.match(/https?:\/\/(?!docs\.google\.com\/presentation)[^\s"'<>]+/i)
    if (anyUrlMatch && anyUrlMatch[0]) {
      e.preventDefault()
      e.stopPropagation()
      setError('')
      handleProcessUrl(anyUrlMatch[0].trim())
      return
    }

    if (text.trim() || html.trim()) {
      setError(
        '⚠️ Google Slides does not copy image files to your clipboard when pressing Cmd+C. Please copy the image directly from the vendor or product website and press Cmd+V here!'
      )
    }
  }, [handleFileUpload, handleProcessUrl])

  useEffect(() => {
    function handleGlobalPaste(e: ClipboardEvent) {
      handlePasteEvent(e)
    }
    window.addEventListener('paste', handleGlobalPaste)
    return () => window.removeEventListener('paste', handleGlobalPaste)
  }, [handlePasteEvent])

  async function handleCopyClipboard() {
    if (!activeItem) return
    try {
      // Use proxy to prevent CORS issues on canvas/blob
      const res = await fetch(`/api/image-proxy?url=${encodeURIComponent(activeItem.cutoutUrl)}`)
      const blob = await res.blob()
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
      setCopiedText('✅ Copied! Press Cmd+V / Ctrl+V in Google Slides to paste.')
      setTimeout(() => setCopiedText(''), 4000)
    } catch (err) {
      console.error('Clipboard copy failed:', err)
      setCopiedText('❌ Could not copy automatically. Use the Download button.')
      setTimeout(() => setCopiedText(''), 4000)
    }
  }

  async function handleApplyMaskEdit(dataUrl: string) {
    if (!activeItem) return
    setShowEditor(false)
    setFinalizing(true)
    setError('')
    try {
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      const file = new File([blob], `edited-${activeItem.id}.png`, { type: 'image/png' })
      const formData = new FormData()
      formData.append('file', file)

      const uploadRes = await fetch('/api/save-edited-cutout', {
        method: 'POST',
        body: formData,
      })
      if (!uploadRes.ok) {
        throw new Error('Failed to save edited cutout')
      }
      const data = await uploadRes.json()
      const updated: CutoutItem = {
         ...activeItem,
         cutoutUrl: data.cutout_url,
      }
      setActiveItem(updated)
      setHistory(prev => prev.map(i => i.id === updated.id ? updated : i))
    } catch (err: any) {
      setError(err.message || 'Failed to apply edit')
    } finally {
      setFinalizing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Editor Modal */}
      {showEditor && activeItem && (
        <MaskEditor
          originalUrl={activeItem.originalUrl}
          rembgUrl={activeItem.cutoutUrl}
          onApply={handleApplyMaskEdit}
          onCancel={() => setShowEditor(false)}
        />
      )}
      {/* Header Info */}
      <section className="bg-white rounded-xl border border-stone-200 p-6">
        <div className="max-w-3xl">
          <h1 className="text-lg font-semibold text-stone-800">✂️ Cutout Studio</h1>
          <p className="text-sm text-stone-500 mt-1">
            Create instant furniture cutouts for your Google Slides Moodboards and Room Collages.
            Copy any cutout with 1-click and press <kbd className="px-1.5 py-0.5 bg-stone-100 border border-stone-300 rounded text-xs">Cmd + V</kbd> / <kbd className="px-1.5 py-0.5 bg-stone-100 border border-stone-300 rounded text-xs">Ctrl + V</kbd> directly into your slide deck!
          </p>
        </div>

        {/* Upload & Direct-Paste Box */}
        <div className="mt-6 space-y-4">
          {loading && previewImage ? (
            <div className="w-full py-8 flex flex-col items-center justify-center gap-4 bg-stone-50 border-2 border-dashed border-stone-300 rounded-xl">
              <div className="relative p-2.5 bg-white border border-stone-200 rounded-xl shadow-md">
                <img
                  src={previewImage}
                  alt="Processing preview"
                  className="h-44 w-auto max-w-full object-contain rounded-lg animate-pulse"
                />
              </div>
              <div className="flex items-center gap-2 text-sm font-semibold text-stone-800">
                <span className="animate-spin text-lg">🪄</span>
                <span>Removing background from pasted image...</span>
              </div>
            </div>
          ) : (
            <>
              {/* Dedicated focusable Paste Box for 100% reliable Cmd+V */}
              <div
                tabIndex={0}
                onPaste={handlePasteEvent}
                className="w-full border-2 border-dashed border-stone-400 bg-stone-50 hover:bg-stone-100/80 rounded-xl py-8 px-6 text-center cursor-pointer shadow-sm focus:outline-none focus:ring-2 focus:ring-stone-800 transition-all flex flex-col items-center justify-center gap-2 group"
              >
                <span className="text-4xl group-hover:scale-110 transition-transform">📋</span>
                <span className="text-base font-semibold text-stone-900">
                  Click here and press <kbd className="px-2 py-0.5 bg-white border border-stone-300 rounded-md text-stone-900 shadow-sm">Cmd + V</kbd> / <kbd className="px-2 py-0.5 bg-white border border-stone-300 rounded-md text-stone-900 shadow-sm">Ctrl + V</kbd> to Paste any copied image!
                </span>
              </div>

              {/* Or choose file from computer */}
              <div className="flex items-center justify-center">
                <label className="cursor-pointer inline-flex items-center gap-2 px-5 py-2.5 bg-white border border-stone-300 rounded-xl hover:bg-stone-50 transition-colors shadow-sm text-sm font-medium text-stone-700">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) handleFileUpload(f)
                    }}
                    disabled={loading}
                  />
                  <span>📁</span>
                  <span>{loading ? 'Processing image…' : 'Or click to choose image file from computer'}</span>
                </label>
              </div>
            </>
          )}

          {error && <p className="text-amber-700 bg-amber-100/60 border border-amber-300 rounded-lg p-3 text-xs mt-3 text-center max-w-2xl mx-auto">{error}</p>}
        </div>
      </section>

      {/* Preview & Action Stage */}
      {activeItem ? (
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-100">
            <div>
              <h2 className="font-medium text-stone-800">Cutout Ready</h2>
              <p className="text-xs text-stone-500">
                Created at {activeItem.timestamp.toLocaleTimeString()}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => setShowEditor(true)}
                disabled={finalizing}
                className="px-4 py-2 text-xs font-semibold bg-white border border-stone-300 text-stone-800 rounded-lg hover:bg-stone-50 transition-colors shadow-sm flex items-center gap-1.5"
              >
                <span>✏️</span>
                <span>{finalizing ? 'Applying edit…' : 'Erase Cutout'}</span>
              </button>
              <button
                onClick={handleCopyClipboard}
                className="px-5 py-2 text-xs font-semibold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 transition-colors shadow-sm"
              >
                📋 Copy Cutout to Clipboard
              </button>
            </div>
          </div>

          {copiedText && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-medium flex items-center gap-2">
              <span>{copiedText}</span>
            </div>
          )}

          {/* Checkerboard Stage */}
          <div className="relative rounded-xl overflow-hidden border border-stone-200 flex items-center justify-center p-8 max-h-[500px]"
            style={{
              backgroundImage: 'repeating-conic-gradient(#e5e5e5 0% 25%, #f7f7f7 0% 50%)',
              backgroundSize: '24px 24px',
            }}
          >
            <img
              src={activeItem.cutoutUrl}
              alt="Transparent Cutout"
              className="max-h-[420px] w-auto object-contain drop-shadow-md"
            />
          </div>
        </section>
      ) : (
        <section className="bg-white/50 rounded-xl border border-dashed border-stone-300 p-12 text-center">
          <p className="text-stone-500 text-sm">No cutout selected yet.</p>
          <p className="text-stone-400 text-xs mt-1">Paste an image or upload a file above to create your first cutout.</p>
        </section>
      )}

      {/* History Tray */}
      {history.length > 0 && (
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-stone-600 uppercase tracking-wide">
              Recent Cutouts ({history.length})
            </h3>
            <button
              onClick={() => { setHistory([]); setActiveItem(null); }}
              className="text-xs text-stone-400 hover:text-stone-600"
            >
              Clear history
            </button>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-3">
            {history.map(item => {
              const isActive = activeItem?.id === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveItem(item)}
                  className={`relative rounded-lg overflow-hidden border-2 transition-all aspect-square p-1 ${
                    isActive ? 'border-stone-800 ring-2 ring-stone-300 bg-white' : 'border-stone-200 hover:border-stone-400 bg-stone-50'
                  }`}
                  style={{
                    backgroundImage: 'repeating-conic-gradient(#e5e5e5 0% 25%, #f7f7f7 0% 50%)',
                    backgroundSize: '12px 12px',
                  }}
                >
                  <img
                    src={item.cutoutUrl}
                    alt="History thumbnail"
                    className="w-full h-full object-contain"
                  />
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
