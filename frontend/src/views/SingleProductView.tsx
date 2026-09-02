import { useState, useEffect } from 'react'
import type { BrokenSet, ScrapeResult, Step } from '../types'

export default function SingleProductView() {
  const [step, setStep] = useState<Step>('input')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [deckUrl, setDeckUrl] = useState('')
  const [slideId, setSlideId] = useState('')
  const [thumbnailUrl, setThumbnailUrl] = useState('')
  const [destinationUrl, setDestinationUrl] = useState(() => localStorage.getItem('hc_dest_url') || '')

  const [url, setUrl] = useState('')
  const [scraped, setScraped] = useState<ScrapeResult | null>(null)
  const [heroIndex, setHeroIndex] = useState(0)
  const [supportingIndices, setSupportingIndices] = useState<number[]>([])
  const [name, setName] = useState('')
  const [dimensions, setDimensions] = useState('')
  const [description, setDescription] = useState('')
  const [broken, setBroken] = useState<BrokenSet>(new Set())
  const [finalHeroUrl, setFinalHeroUrl] = useState('')
  const [layout, setLayout] = useState<'right' | 'left' | 'bottom'>('right')
  const [heroFit, setHeroFit] = useState<'crop' | 'inside'>('crop')
  const [previewModalImg, setPreviewModalImg] = useState<string | null>(null)
  const [processingImages, setProcessingImages] = useState<Set<number>>(new Set())
  const [cutoutMap, setCutoutMap] = useState<Record<string, string>>({})

  useEffect(() => {
    localStorage.setItem('hc_dest_url', destinationUrl)
  }, [destinationUrl])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const extData = params.get('ext_data')
    if (!extData) return
    try {
      const decoded = JSON.parse(decodeURIComponent(atob(extData))) as ScrapeResult & { source_url?: string }
      setScraped(decoded)
      setName(decoded.name || '')
      setDimensions(decoded.dimensions || '')
      setDescription(decoded.description || '')
      if (decoded.source_url) setUrl(decoded.source_url)
      setHeroIndex(0); setSupportingIndices([]); setBroken(new Set())
      setCutoutMap({})
      setFinalHeroUrl('')
      setStep('review')
      window.history.replaceState({}, '', window.location.pathname)
    } catch {
      setError('Failed to read data from the Chrome extension. Please try again.')
    }
  }, [])

  const displayedImages = scraped
    ? scraped.images.slice(0, 30).filter(img => !broken.has(img))
    : []

  const MAX_SUPPORTS = 2

  function setHero(i: number) {
    setSupportingIndices(prev => prev.filter(idx => idx !== i))
    setHeroIndex(i); setFinalHeroUrl('')
  }

  function toggleSupporting(i: number, e: React.MouseEvent) {
    e.stopPropagation()
    if (i === heroIndex) return
    setSupportingIndices(prev => {
      if (prev.includes(i)) return prev.filter(idx => idx !== i)
      if (prev.length >= MAX_SUPPORTS) return prev
      return [...prev, i]
    })
  }

  async function handleScrape() {
    setError(''); setLoading(true)
    try {
      const res = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Scrape failed') }
      const data: ScrapeResult = await res.json()
      setScraped(data); setName(data.name); setDimensions(data.dimensions); setDescription(data.description)
      setHeroIndex(0); setSupportingIndices([]); setBroken(new Set())
      setCutoutMap({})
      setFinalHeroUrl('')
      setStep('review')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  async function handleRemoveBackground(i: number, originalUrl: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!scraped) return
    
    setProcessingImages(prev => new Set(prev).add(i))
    setError('')
    try {
      const res = await fetch('/api/process-hero', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: originalUrl }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.detail || 'Failed to remove background')
      }
      const data = await res.json()
      
      setCutoutMap(prev => ({ ...prev, [originalUrl]: data.hero_url }))
    } catch (err: any) {
      setError(err.message || 'Failed to process image cutout')
    } finally {
      setProcessingImages(prev => {
        const newSet = new Set(prev)
        newSet.delete(i)
        return newSet
      })
    }
  }

  async function handleGenerate(prevSlideId?: string, heroFitOverride?: 'crop' | 'inside') {
    if (!scraped) return
    setStep('generating'); setError('')
    const fitToUse = heroFitOverride ?? heroFit
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hero_image_url: cutoutMap[displayedImages[heroIndex]] || displayedImages[heroIndex],
          supporting_image_urls: supportingIndices.map(i => cutoutMap[displayedImages[i]] || displayedImages[i]),
          name, dimensions, description, layout,
          hero_fit: fitToUse,
          keep_background: true,
          ...(finalHeroUrl ? { finalized_hero_url: finalHeroUrl } : {}),
          ...(prevSlideId ? { prev_slide_id: prevSlideId } : {}),
          ...(destinationUrl ? { destination_presentation_id: extractPresentationId(destinationUrl) } : {}),
        }),
      })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Generate failed') }
      const data = await res.json()
      setDeckUrl(data.deck_url); setSlideId(data.slide_id || ''); setThumbnailUrl(data.thumbnail_url || '')
      setStep('preview')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setStep(prevSlideId ? 'preview' : 'review')
    }
  }

  function handleKeep() { setStep('done') }

  async function handleDiscard() {
    if (slideId) {
      try {
        await fetch('/api/delete-slide', { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' }, 
          body: JSON.stringify({ 
            slide_id: slideId,
            presentation_id: extractPresentationId(deckUrl)
          }) 
        })
      } catch { /* non-fatal */ }
    }
    setStep('review')
  }

  function handleReset() {
    setStep('input'); setUrl(''); setScraped(null); setDeckUrl(''); setError('')
    setSlideId(''); setThumbnailUrl('')
    setBroken(new Set()); setSupportingIndices([])
    setCutoutMap({})
    setFinalHeroUrl('')
  }

  const showReview = scraped && (step === 'review' || (step === 'generating' && !thumbnailUrl))
  const showPreview = step === 'preview' || step === 'done' || (step === 'generating' && !!thumbnailUrl)

  function extractPresentationId(urlStr: string) {
    if (!urlStr) return ''
    // e.g. https://docs.google.com/presentation/d/12345abcde/edit -> 12345abcde
    const match = urlStr.match(/\/d\/([a-zA-Z0-9-_]+)/)
    return match ? match[1] : urlStr.trim() // fallback to just passing the raw ID if they pasted that
  }

  return (
    <>
      {previewModalImg && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setPreviewModalImg(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh] bg-white rounded-xl p-3 shadow-2xl overflow-hidden flex flex-col items-center" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setPreviewModalImg(null)}
              className="absolute top-3 right-3 bg-stone-800 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm hover:bg-stone-700"
            >
              ✕
            </button>
            <img
              src={previewModalImg}
              alt="Full size preview"
              referrerPolicy="no-referrer"
              className="max-h-[82vh] w-auto object-contain rounded-lg"
            />
            <p className="text-xs text-stone-500 mt-2">Click anywhere or ✕ to close</p>
          </div>
        </div>
      )}

      <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
        <h2 className="font-medium text-stone-700">1. Google Slide Destination (Optional)</h2>
        <p className="text-xs text-stone-500">Paste your presentation URL to push the slide instantly into the presentation</p>
        <div className="flex gap-3">
          <input
            className="flex-1 border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-blue-50/30"
            placeholder="https://docs.google.com/presentation/d/..."
            value={destinationUrl} onChange={e => setDestinationUrl(e.target.value)}
          />
        </div>
      </section>

      <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
        <h2 className="font-medium text-stone-700">2. Paste a vendor product URL</h2>
        <div className="flex gap-3">
          <input
            className="flex-1 border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
            placeholder="https://www.potterybarn.com/products/..."
            value={url} onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && handleScrape()}
            disabled={loading}
          />
          <button onClick={handleScrape} disabled={!url.trim() || loading}
            className="bg-stone-800 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors">
            {loading ? 'Scraping…' : 'Scrape'}
          </button>
        </div>
        {error && <p className="text-red-500 text-sm">{error}</p>}
      </section>

      {showReview && (
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-6">
          <h2 className="font-medium text-stone-700">3. Select images &amp; review text</h2>
          <div>
            <p className="text-xs text-stone-500 mb-3">
              Click an image to set it as the <strong>hero</strong>. Use <strong>+</strong> to add <span className="text-emerald-700 font-medium">supporting</span> images.
            </p>
            <div className="grid grid-cols-4 gap-3">
              {displayedImages.map((originalImg, i) => {
                const isHero = heroIndex === i
                const supportRank = supportingIndices.indexOf(i)
                const isSupporting = supportRank !== -1
                const canAdd = !isHero && !isSupporting && supportingIndices.length < MAX_SUPPORTS
                const isProcessing = processingImages.has(i)
                
                const displayImg = cutoutMap[originalImg] || originalImg
                const isCutout = !!cutoutMap[originalImg]
                
                return (
                  <button key={originalImg} onClick={() => setHero(i)} onDoubleClick={() => setPreviewModalImg(displayImg)}
                    className={`relative rounded-lg overflow-hidden border-2 transition-all aspect-square bg-stone-50 ${
                      isHero ? 'border-stone-800 ring-2 ring-stone-300'
                      : isSupporting ? 'border-emerald-500 ring-2 ring-emerald-200'
                      : 'border-stone-200 hover:border-stone-400'}`}>
                    
                    {/* Checkered background behind transparent images */}
                    <div className="absolute inset-0 z-0" style={{ backgroundImage: 'repeating-conic-gradient(#e5e5e5 0% 25%, #f7f7f7 0% 50%)', backgroundSize: '12px 12px' }} />
                    
                    <img src={displayImg} alt={`Product image ${i + 1}`} referrerPolicy="no-referrer" className="relative z-10 w-full h-full object-contain p-1"
                      onError={() => {
                        setBroken(prev => new Set(prev).add(originalImg))
                        if (heroIndex === i) setHeroIndex(0)
                        setSupportingIndices(prev => prev.filter(idx => idx !== i))
                      }} />
                    
                    {isProcessing && (
                      <div className="absolute inset-0 bg-white/60 flex items-center justify-center z-20 backdrop-blur-[1px]">
                        <div className="w-6 h-6 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}

                    {isHero && <span className="absolute z-20 bottom-1 left-1/2 -translate-x-1/2 bg-stone-800 text-white text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap shadow-sm">Hero</span>}
                    {isSupporting && <span className="absolute z-20 bottom-1 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap shadow-sm">Support {supportRank + 1}</span>}
                    
                    {isCutout ? (
                      <button onClick={e => {
                          e.stopPropagation();
                          setCutoutMap(prev => {
                            const newMap = { ...prev }
                            delete newMap[originalImg]
                            return newMap
                          })
                        }} 
                        title="Revert to original (remove cutout)"
                        className={`absolute z-30 top-1 left-1 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center transition-colors bg-stone-800 text-white hover:bg-stone-700 shadow-sm`}>
                        ↩️
                      </button>
                    ) : (
                      <button onClick={e => handleRemoveBackground(i, originalImg, e)} disabled={isProcessing} title="Remove background (magic wand)"
                        className={`absolute z-30 top-1 left-1 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center transition-colors bg-white/90 text-stone-600 hover:bg-white border border-stone-300 shadow-sm ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}>
                        🪄
                      </button>
                    )}

                    {!isHero && (
                      <button onClick={e => toggleSupporting(i, e)} disabled={!isSupporting && !canAdd}
                        className={`absolute z-30 top-1 right-1 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center transition-colors shadow-sm ${
                          isSupporting ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : canAdd ? 'bg-white/80 text-stone-600 hover:bg-white border border-stone-300'
                          : 'bg-white/40 text-stone-400 cursor-not-allowed'}`}>
                        {isSupporting ? '−' : '+'}
                      </button>
                    )}
                  </button>
                )
              })}
            </div>
            {supportingIndices.length > 0 && (
              <p className="text-xs text-emerald-700 mt-2">
                {supportingIndices.length} supporting image{supportingIndices.length > 1 ? 's' : ''} selected
              </p>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Product Name</label>
              <input className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Dimensions</label>
              <input className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400" value={dimensions} onChange={e => setDimensions(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Description</label>
              <textarea rows={4} className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400 resize-none" value={description} onChange={e => setDescription(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-2">Slide Layout</label>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { id: 'right', label: 'Hero Image Right', desc: 'Hero on Right, Text + Supporting Images on Left' },
                  { id: 'left', label: 'Hero Image Left', desc: 'Hero on Left, Text + Supporting Images on Right' },
                  { id: 'bottom', label: 'Full Horizontal', desc: 'Wide Bottom Hero (For Sofas/Tables)' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setLayout(opt.id as any)}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      layout === opt.id
                        ? 'border-stone-800 bg-stone-50 ring-2 ring-stone-300'
                        : 'border-stone-200 hover:border-stone-400 bg-white'
                    }`}
                  >
                    <div className="font-medium text-sm text-stone-800">{opt.label}</div>
                    <div className="text-xs text-stone-500 mt-0.5">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button onClick={() => handleGenerate()} disabled={step === 'generating'}
            className="w-full bg-stone-800 text-white text-sm font-medium py-3 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors">
            {step === 'generating' ? 'Generating preview… (slide creation, ~15s)' : 'Generate Slide'}
          </button>
        </section>
      )}

      {showPreview && (
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-5">
          <h2 className="font-medium text-stone-700">4. Preview</h2>
          <div className="relative rounded-lg overflow-hidden border border-stone-200 shadow-sm bg-stone-100 min-h-[160px]">
            {thumbnailUrl && (
              <img src={thumbnailUrl} alt="Slide preview"
                referrerPolicy="no-referrer"
                className={`w-full transition-opacity duration-300 ${step === 'generating' ? 'opacity-25' : 'opacity-100'}`} />
            )}
            {step === 'generating' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div className="w-8 h-8 border-4 border-stone-300 border-t-stone-700 rounded-full animate-spin" />
                <p className="text-sm text-stone-600 font-medium">Generating new preview…</p>
              </div>
            )}
          </div>

          {step === 'preview' && (
            <>
              <p className="text-xs text-stone-400">This is the actual slide — every element is individually editable in Google Slides.</p>
              <div className="flex flex-wrap gap-3 items-center mt-3">
                <button onClick={handleKeep} className="bg-emerald-700 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-emerald-600 transition-colors">
                  Keep — looks good ✓
                </button>
                {/* Hero Fit Toggle */}
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-xs text-stone-500">Hero image:</span>
                  <button
                    onClick={() => {
                      const newFit = heroFit === 'crop' ? 'inside' : 'crop'
                      setHeroFit(newFit)
                      handleGenerate(slideId, newFit)
                    }}
                    title={heroFit === 'crop' ? 'Fill mode: zooms in to cover full space (may crop). Click to switch to Fit.' : 'Fit mode: shows full image (may have white gaps). Click to switch to Fill.'}
                    className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-all ${
                      heroFit === 'crop'
                        ? 'bg-stone-100 border-stone-300 text-stone-600 hover:bg-stone-200'
                        : 'bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100'
                    }`}
                  >
                    {heroFit === 'crop' ? '✂️ Switch to Fit (full image)' : '🔲 Switch to Fill (cover space)'}
                  </button>
                </div>
                <a href={deckUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-stone-500 hover:text-stone-700 underline">
                  Open in Google Slides →
                </a>
              </div>
              {error && <p className="text-red-500 text-sm">{error}</p>}
              <div className="flex items-center gap-4 pt-2">
                <button onClick={handleDiscard} className="text-xs text-stone-500 hover:text-stone-800 underline">
                  Discard slide &amp; pick new images
                </button>
                <span className="text-stone-300">|</span>
                <button onClick={handleReset} className="text-xs text-stone-500 hover:text-stone-800 underline">
                  Start new product
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 space-y-3">
              <p className="text-sm font-medium text-emerald-800">Slide kept!</p>
              <p className="text-sm text-emerald-700">Open the deck, copy this slide, and paste it into your working presentation. Every element is individually editable.</p>
              <div className="flex gap-3 flex-wrap">
                <a href={deckUrl} target="_blank" rel="noopener noreferrer" className="inline-block bg-emerald-700 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-emerald-600 transition-colors">
                  Open in Google Slides →
                </a>
                <button onClick={handleReset} className="text-sm text-stone-500 hover:text-stone-700 underline">Start new product</button>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  )
}
