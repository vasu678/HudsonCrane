import { useState, useEffect } from 'react'
import MaskEditor from '../components/MaskEditor'
import type { BrokenSet, ScrapeResult, Step } from '../types'

export default function SingleProductView() {
  const [step, setStep] = useState<Step>('input')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [deckUrl, setDeckUrl] = useState('')
  const [slideId, setSlideId] = useState('')
  const [thumbnailUrl, setThumbnailUrl] = useState('')
  const [regenDisabled, setRegenDisabled] = useState(false)

  const [url, setUrl] = useState('')
  const [scraped, setScraped] = useState<ScrapeResult | null>(null)
  const [heroIndex, setHeroIndex] = useState(0)
  const [supportingIndices, setSupportingIndices] = useState<number[]>([])
  const [name, setName] = useState('')
  const [dimensions, setDimensions] = useState('')
  const [description, setDescription] = useState('')
  const [broken, setBroken] = useState<BrokenSet>(new Set())
  const [shadowIntensity, setShadowIntensity] = useState(65)
  const [generatedHeroUrl, setGeneratedHeroUrl] = useState('')

  const [processingHero, setProcessingHero] = useState(false)
  const [processedHeroUrl, setProcessedHeroUrl] = useState('')
  const [editingHero, setEditingHero] = useState(false)
  const [finalizingHero, setFinalizingHero] = useState(false)
  const [finalHeroUrl, setFinalHeroUrl] = useState('')

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
      setProcessedHeroUrl(''); setFinalHeroUrl(''); setEditingHero(false); setFinalizingHero(false)
      setStep('review')
      window.history.replaceState({}, '', window.location.pathname)
    } catch {
      setError('Failed to read data from the Chrome extension. Please try again.')
    }
  }, [])

  const displayedImages = scraped
    ? scraped.images.slice(0, 12).filter(img => !broken.has(img)).slice(0, 8)
    : []

  const MAX_SUPPORTS = 5

  function setHero(i: number) {
    setSupportingIndices(prev => prev.filter(idx => idx !== i))
    setHeroIndex(i); setProcessedHeroUrl(''); setFinalHeroUrl('')
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
      setProcessedHeroUrl(''); setFinalHeroUrl(''); setEditingHero(false); setFinalizingHero(false)
      setStep('review')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  async function handleGenerate(prevSlideId?: string) {
    if (!scraped) return
    setStep('generating'); setError('')
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hero_image_url: displayedImages[heroIndex],
          supporting_image_urls: supportingIndices.map(i => displayedImages[i]),
          name, dimensions, description, shadow_intensity: shadowIntensity / 100,
          ...(finalHeroUrl ? { finalized_hero_url: finalHeroUrl } : {}),
          ...(prevSlideId ? { prev_slide_id: prevSlideId } : {}),
        }),
      })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Generate failed') }
      const data = await res.json()
      setDeckUrl(data.deck_url); setSlideId(data.slide_id || ''); setThumbnailUrl(data.thumbnail_url || '')
      if (data.hero_url) setGeneratedHeroUrl(data.hero_url)
      setStep('preview')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setStep(prevSlideId ? 'preview' : 'review')
    }
  }

  async function handleRegenerate() {
    setRegenDisabled(true)
    await handleGenerate(slideId)
    setRegenDisabled(false)
  }

  function handleKeep() { setStep('done') }

  async function handleDiscard() {
    if (slideId) {
      try {
        await fetch('/api/delete-slide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slide_id: slideId }) })
      } catch { /* non-fatal */ }
    }
    handleReset()
  }

  async function handleEditCutout() {
    const vendorUrl = displayedImages[heroIndex]
    if (!vendorUrl) return
    setProcessingHero(true); setError('')
    try {
      const res = await fetch('/api/process-hero', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: vendorUrl }) })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Processing failed') }
      const { hero_url } = await res.json()
      setProcessedHeroUrl(hero_url); setEditingHero(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setProcessingHero(false) }
  }

  async function handleMaskApply(maskDataUrl: string) {
    setEditingHero(false); setFinalizingHero(true); setError('')
    try {
      const res = await fetch('/api/finalize-hero', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ original_url: displayedImages[heroIndex], mask_data_url: maskDataUrl }) })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Finalize failed') }
      const { hero_url } = await res.json()
      setFinalHeroUrl(hero_url)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setFinalizingHero(false) }
  }

  function handleReset() {
    setStep('input'); setUrl(''); setScraped(null); setDeckUrl(''); setError('')
    setSlideId(''); setThumbnailUrl(''); setRegenDisabled(false); setGeneratedHeroUrl('')
    setBroken(new Set()); setSupportingIndices([])
    setProcessedHeroUrl(''); setEditingHero(false); setProcessingHero(false)
    setFinalHeroUrl(''); setFinalizingHero(false)
  }

  const showReview = scraped && (step === 'review' || (step === 'generating' && !thumbnailUrl))
  const showPreview = step === 'preview' || step === 'done' || (step === 'generating' && !!thumbnailUrl)

  return (
    <>
      <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
        <h2 className="font-medium text-stone-700">1. Paste a vendor product URL</h2>
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
          <h2 className="font-medium text-stone-700">2. Select images &amp; review text</h2>
          <div>
            <p className="text-xs text-stone-500 mb-3">
              Click an image to set it as the <strong>hero</strong> (background removed).
              Use <strong>+</strong> to add up to {MAX_SUPPORTS} <span className="text-emerald-700 font-medium">supporting</span> images (kept as-is).
            </p>
            <div className="grid grid-cols-4 gap-3">
              {displayedImages.map((img, i) => {
                const isHero = heroIndex === i
                const supportRank = supportingIndices.indexOf(i)
                const isSupporting = supportRank !== -1
                const canAdd = !isHero && !isSupporting && supportingIndices.length < MAX_SUPPORTS
                return (
                  <button key={img} onClick={() => setHero(i)}
                    className={`relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                      isHero ? 'border-stone-800 ring-2 ring-stone-300'
                      : isSupporting ? 'border-emerald-500 ring-2 ring-emerald-200'
                      : 'border-stone-200 hover:border-stone-400'}`}>
                    <img src={img} alt={`Product image ${i + 1}`} className="w-full h-full object-cover"
                      onError={() => {
                        setBroken(prev => new Set(prev).add(img))
                        if (heroIndex === i) setHeroIndex(0)
                        setSupportingIndices(prev => prev.filter(idx => idx !== i))
                      }} />
                    {isHero && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-stone-800 text-white text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">Hero</span>}
                    {isSupporting && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">Support {supportRank + 1}</span>}
                    {!isHero && (
                      <button onClick={e => toggleSupporting(i, e)} disabled={!isSupporting && !canAdd}
                        className={`absolute top-1 right-1 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center transition-colors ${
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
                {supportingIndices.length < MAX_SUPPORTS && ` (you can add up to ${MAX_SUPPORTS - supportingIndices.length} more)`}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between py-1">
            <p className="text-xs text-stone-400">
              Background removal runs on the hero.{' '}
              {finalHeroUrl ? <span className="text-emerald-600 font-medium">Custom cutout applied.</span>
              : finalizingHero ? <span className="text-stone-500">Uploading edited cutout…</span>
              : processedHeroUrl ? <span className="text-stone-500">Cutout ready — edit or generate.</span>
              : 'Optionally inspect and touch up the cutout before generating.'}
            </p>
            <button onClick={handleEditCutout} disabled={processingHero || finalizingHero || step !== 'review'}
              className="shrink-0 ml-4 text-xs border border-stone-300 text-stone-600 px-3 py-1.5 rounded-lg hover:border-stone-600 hover:text-stone-800 disabled:opacity-40 transition-colors">
              {processingHero ? 'Processing…' : finalizingHero ? 'Uploading…' : (processedHeroUrl || finalHeroUrl) ? 'Re-edit cutout' : 'Edit cutout'}
            </button>
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
          </div>

          <button onClick={() => handleGenerate()} disabled={step === 'generating'}
            className="w-full bg-stone-800 text-white text-sm font-medium py-3 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors">
            {step === 'generating' ? 'Generating preview… (background removal + slide creation, ~30s)' : 'Generate Slide'}
          </button>
        </section>
      )}

      {showPreview && (
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-5">
          <h2 className="font-medium text-stone-700">3. Preview</h2>
          <div className="relative rounded-lg overflow-hidden border border-stone-200 shadow-sm bg-stone-100 min-h-[160px]">
            {thumbnailUrl && (
              <img src={thumbnailUrl} alt="Slide preview"
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
              <div className="flex items-center gap-4 py-1">
                {generatedHeroUrl && (
                  <div className="w-16 h-16 shrink-0 rounded-lg bg-stone-100 flex items-center justify-center p-2">
                    <img
                      src={generatedHeroUrl}
                      alt="Shadow preview"
                      className="max-w-full max-h-full object-contain"
                      style={{
                        filter: shadowIntensity > 0
                          ? `drop-shadow(${(shadowIntensity / 100) * 10}px ${(shadowIntensity / 100) * 10}px ${(shadowIntensity / 100) * 12}px rgba(0,0,0,${(shadowIntensity / 100) * 0.65}))`
                          : 'none',
                        transition: 'filter 0.1s ease',
                      }}
                    />
                  </div>
                )}
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setShadowIntensity(prev => prev > 0 ? 0 : 65)}
                      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${shadowIntensity > 0 ? 'bg-stone-700' : 'bg-stone-300'}`}
                      aria-label="Toggle shadow">
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${shadowIntensity > 0 ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                    <span className="text-xs text-stone-500">Shadow</span>
                    {shadowIntensity > 0 && (
                      <span className="text-xs font-mono text-stone-400 ml-auto">{shadowIntensity}%</span>
                    )}
                  </div>
                  {shadowIntensity > 0 && (
                    <input type="range" min={5} max={100} step={5} value={shadowIntensity}
                      onChange={e => setShadowIntensity(Number(e.target.value))}
                      className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-stone-700 bg-stone-200" />
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-3 items-center">
                <button onClick={handleKeep} className="bg-emerald-700 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-emerald-600 transition-colors">
                  Keep — looks good ✓
                </button>
                <button onClick={handleRegenerate} disabled={regenDisabled}
                  className="border border-stone-300 text-stone-700 text-sm font-medium px-5 py-2 rounded-lg hover:border-stone-600 hover:text-stone-900 disabled:opacity-40 transition-colors">
                  Regenerate
                </button>
                <a href={deckUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-stone-500 hover:text-stone-700 underline">
                  Open in Google Slides →
                </a>
              </div>
              {error && <p className="text-red-500 text-sm">{error}</p>}
              <button onClick={handleDiscard} className="text-xs text-stone-400 hover:text-stone-600 underline block">
                Start over (discards this slide)
              </button>
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
                <button onClick={handleReset} className="text-sm text-stone-500 hover:text-stone-700 underline">Start over</button>
              </div>
            </div>
          )}
        </section>
      )}

      {editingHero && processedHeroUrl && (
        <MaskEditor originalUrl={displayedImages[heroIndex]} rembgUrl={processedHeroUrl} onApply={handleMaskApply} onCancel={() => setEditingHero(false)} />
      )}
    </>
  )
}
