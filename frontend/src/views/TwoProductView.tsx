import { useState } from 'react'
import ProductPanel from '../components/ProductPanel'
import type { BrokenSet, ScrapeResult, Step } from '../types'

export default function TwoProductView() {
  const [step, setStep] = useState<Step>('input')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [deckUrl, setDeckUrl] = useState('')
  const [slideId, setSlideId] = useState('')
  const [thumbnailUrl, setThumbnailUrl] = useState('')
  const [regenDisabled, setRegenDisabled] = useState(false)
  const [shadowIntensity, setShadowIntensity] = useState(65)
  const [generatedHeroUrl, setGeneratedHeroUrl] = useState('')

  const [urlA, setUrlA] = useState('')
  const [urlB, setUrlB] = useState('')
  const [scrapedA, setScrapedA] = useState<ScrapeResult | null>(null)
  const [scrapedB, setScrapedB] = useState<ScrapeResult | null>(null)
  const [heroIndexA, setHeroIndexA] = useState(0)
  const [heroIndexB, setHeroIndexB] = useState(0)
  const [nameA, setNameA] = useState(''); const [dimsA, setDimsA] = useState(''); const [descA, setDescA] = useState('')
  const [nameB, setNameB] = useState(''); const [dimsB, setDimsB] = useState(''); const [descB, setDescB] = useState('')
  const [brokenA, setBrokenA] = useState<BrokenSet>(new Set())
  const [brokenB, setBrokenB] = useState<BrokenSet>(new Set())

  const displayedA = scrapedA ? scrapedA.images.slice(0, 12).filter(img => !brokenA.has(img)).slice(0, 4) : []
  const displayedB = scrapedB ? scrapedB.images.slice(0, 12).filter(img => !brokenB.has(img)).slice(0, 4) : []

  async function handleScrapeTwo() {
    setError(''); setLoading(true)
    try {
      const [resA, resB] = await Promise.all([
        fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: urlA }) }),
        fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: urlB }) }),
      ])
      if (!resA.ok) { const b = await resA.json(); throw new Error(`Product A: ${b.detail || 'Scrape failed'}`) }
      if (!resB.ok) { const b = await resB.json(); throw new Error(`Product B: ${b.detail || 'Scrape failed'}`) }
      const dataA: ScrapeResult = await resA.json()
      const dataB: ScrapeResult = await resB.json()
      setScrapedA(dataA); setNameA(dataA.name); setDimsA(dataA.dimensions); setDescA(dataA.description); setHeroIndexA(0); setBrokenA(new Set())
      setScrapedB(dataB); setNameB(dataB.name); setDimsB(dataB.dimensions); setDescB(dataB.description); setHeroIndexB(0); setBrokenB(new Set())
      setStep('review')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }

  async function handleGenerateTwo(prevSlideId?: string) {
    if (!scrapedA || !scrapedB) return
    setStep('generating'); setError('')
    try {
      const res = await fetch('/api/generate-two', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_a: { hero_image_url: displayedA[heroIndexA], name: nameA, dimensions: dimsA, description: descA },
          product_b: { hero_image_url: displayedB[heroIndexB], name: nameB, dimensions: dimsB, description: descB },
          shadow_intensity: shadowIntensity / 100,
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
    await handleGenerateTwo(slideId)
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

  function handleReset() {
    setStep('input'); setUrlA(''); setUrlB(''); setScrapedA(null); setScrapedB(null)
    setDeckUrl(''); setError(''); setSlideId(''); setThumbnailUrl(''); setRegenDisabled(false); setGeneratedHeroUrl('')
    setBrokenA(new Set()); setBrokenB(new Set())
  }

  const showReview = scrapedA && scrapedB && (step === 'review' || (step === 'generating' && !thumbnailUrl))
  const showPreview = step === 'preview' || step === 'done' || (step === 'generating' && !!thumbnailUrl)

  return (
    <>
      <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
        <h2 className="font-medium text-stone-700">1. Paste two vendor product URLs</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Product A URL</label>
            <input className="w-full border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
              placeholder="https://www.potterybarn.com/products/..." value={urlA} onChange={e => setUrlA(e.target.value)} disabled={loading} />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Product B URL</label>
            <input className="w-full border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
              placeholder="https://www.potterybarn.com/products/..." value={urlB} onChange={e => setUrlB(e.target.value)} disabled={loading} />
          </div>
        </div>
        <button onClick={handleScrapeTwo} disabled={!urlA.trim() || !urlB.trim() || loading}
          className="bg-stone-800 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors">
          {loading ? 'Scraping…' : 'Scrape Both'}
        </button>
        {error && <p className="text-red-500 text-sm">{error}</p>}
      </section>

      {showReview && (
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-6">
          <h2 className="font-medium text-stone-700">2. Select hero images &amp; review text</h2>
          <div className="flex gap-6">
            <ProductPanel label="Product A" heroIdx={heroIndexA} setHeroIdx={setHeroIndexA}
              brokenSet={brokenA} setBrokenSet={setBrokenA} displayedImgs={displayedA}
              nameVal={nameA} setNameVal={setNameA} dimsVal={dimsA} setDimsVal={setDimsA} descVal={descA} setDescVal={setDescA} />
            <div className="w-px bg-stone-200 self-stretch" />
            <ProductPanel label="Product B" heroIdx={heroIndexB} setHeroIdx={setHeroIndexB}
              brokenSet={brokenB} setBrokenSet={setBrokenB} displayedImgs={displayedB}
              nameVal={nameB} setNameVal={setNameB} dimsVal={dimsB} setDimsVal={setDimsB} descVal={descB} setDescVal={setDescB} />
          </div>
          <button onClick={() => handleGenerateTwo()} disabled={step === 'generating'}
            className="w-full bg-stone-800 text-white text-sm font-medium py-3 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors">
            {step === 'generating' ? 'Generating preview… (removing backgrounds + creating slide, ~30s)' : 'Generate Two-Product Slide'}
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
                  <div className="w-28 h-28 shrink-0 rounded-lg bg-stone-100 flex items-center justify-center p-2">
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
    </>
  )
}
