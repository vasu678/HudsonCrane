import { useState } from 'react'
import ProductPanel from '../components/ProductPanel'
import type { BrokenSet, ScrapeResult, Step } from '../types'

export default function TwoProductView() {
  const [step, setStep] = useState<Step>('input')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [deckUrl, setDeckUrl] = useState('')

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
  const [dropShadow, setDropShadow] = useState(true)

  const displayedA = scrapedA
    ? scrapedA.images.slice(0, 12).filter(img => !brokenA.has(img)).slice(0, 4)
    : []
  const displayedB = scrapedB
    ? scrapedB.images.slice(0, 12).filter(img => !brokenB.has(img)).slice(0, 4)
    : []

  // ── Handlers ────────────────────────────────────────────────────────────

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
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerateTwo() {
    if (!scrapedA || !scrapedB) return
    setStep('generating'); setError('')
    try {
      const res = await fetch('/api/generate-two', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_a: { hero_image_url: displayedA[heroIndexA], name: nameA, dimensions: dimsA, description: descA },
          product_b: { hero_image_url: displayedB[heroIndexB], name: nameB, dimensions: dimsB, description: descB },
          drop_shadow: dropShadow,
        }),
      })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Generate failed') }
      const data = await res.json()
      setDeckUrl(data.deck_url); setStep('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e)); setStep('review')
    }
  }

  function handleReset() {
    setStep('input'); setUrlA(''); setUrlB(''); setScrapedA(null); setScrapedB(null)
    setDeckUrl(''); setError('')
    setBrokenA(new Set()); setBrokenB(new Set())
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Step 1 — URL inputs */}
      <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
        <h2 className="font-medium text-stone-700">1. Paste two vendor product URLs</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Product A URL</label>
            <input
              className="w-full border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
              placeholder="https://www.potterybarn.com/products/..."
              value={urlA} onChange={e => setUrlA(e.target.value)} disabled={loading}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Product B URL</label>
            <input
              className="w-full border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
              placeholder="https://www.potterybarn.com/products/..."
              value={urlB} onChange={e => setUrlB(e.target.value)} disabled={loading}
            />
          </div>
        </div>
        <button
          onClick={handleScrapeTwo}
          disabled={!urlA.trim() || !urlB.trim() || loading}
          className="bg-stone-800 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors"
        >
          {loading ? 'Scraping…' : 'Scrape Both'}
        </button>
        {error && <p className="text-red-500 text-sm">{error}</p>}
      </section>

      {/* Step 2 — Review */}
      {(step === 'review' || step === 'generating' || step === 'done') && scrapedA && scrapedB && (
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-6">
          <h2 className="font-medium text-stone-700">2. Select hero images &amp; review text</h2>
          <div className="flex gap-6">
            <ProductPanel
              label="Product A"
              heroIdx={heroIndexA} setHeroIdx={setHeroIndexA}
              brokenSet={brokenA} setBrokenSet={setBrokenA}
              displayedImgs={displayedA}
              nameVal={nameA} setNameVal={setNameA}
              dimsVal={dimsA} setDimsVal={setDimsA}
              descVal={descA} setDescVal={setDescA}
            />
            <div className="w-px bg-stone-200 self-stretch" />
            <ProductPanel
              label="Product B"
              heroIdx={heroIndexB} setHeroIdx={setHeroIndexB}
              brokenSet={brokenB} setBrokenSet={setBrokenB}
              displayedImgs={displayedB}
              nameVal={nameB} setNameVal={setNameB}
              dimsVal={dimsB} setDimsVal={setDimsB}
              descVal={descB} setDescVal={setDescB}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              id="drop-shadow-two"
              type="checkbox"
              checked={dropShadow}
              onChange={e => setDropShadow(e.target.checked)}
              className="w-4 h-4 accent-stone-700"
            />
            <label htmlFor="drop-shadow-two" className="text-sm text-stone-600 select-none cursor-pointer">
              Drop shadows on images
            </label>
          </div>
          <button
            onClick={handleGenerateTwo}
            disabled={step === 'generating' || step === 'done'}
            className="w-full bg-stone-800 text-white text-sm font-medium py-3 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors"
          >
            {step === 'generating' ? 'Generating… (removing backgrounds, creating slide)' : 'Generate Two-Product Slide'}
          </button>
        </section>
      )}

      {/* Step 3 — Done */}
      {step === 'done' && deckUrl && (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 space-y-3">
          <h2 className="font-medium text-emerald-800">Slide generated!</h2>
          <p className="text-sm text-emerald-700">
            Open the deck, copy the new slide, and paste it into your working presentation.
            Every element is individually editable.
          </p>
          <div className="flex gap-3 flex-wrap">
            <a
              href={deckUrl} target="_blank" rel="noopener noreferrer"
              className="inline-block bg-emerald-700 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-emerald-600 transition-colors"
            >
              Open in Google Slides →
            </a>
            <button onClick={handleReset} className="text-sm text-stone-500 hover:text-stone-700 underline">
              Start over
            </button>
          </div>
        </section>
      )}
    </>
  )
}
