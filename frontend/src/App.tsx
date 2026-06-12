import { useState } from 'react'
import MaskEditor from './components/MaskEditor'

interface ScrapeResult {
  name: string
  dimensions: string
  description: string
  images: string[]
}

type Step = 'input' | 'review' | 'generating' | 'done'
type Mode = 'single' | 'two'
type BrokenSet = Set<string>

// ── Reusable panel for one product (two-product mode) ──────────────────────

interface ProductPanelProps {
  label: string
  heroIdx: number
  setHeroIdx: (i: number) => void
  brokenSet: BrokenSet
  setBrokenSet: (fn: (prev: BrokenSet) => BrokenSet) => void
  displayedImgs: string[]
  nameVal: string; setNameVal: (v: string) => void
  dimsVal: string; setDimsVal: (v: string) => void
  descVal: string; setDescVal: (v: string) => void
}

function ProductPanel({
  label, heroIdx, setHeroIdx, brokenSet, setBrokenSet, displayedImgs,
  nameVal, setNameVal, dimsVal, setDimsVal, descVal, setDescVal,
}: ProductPanelProps) {
  return (
    <div className="flex-1 space-y-4 min-w-0">
      <h3 className="text-xs font-semibold text-stone-500 uppercase tracking-wider">{label}</h3>
      <div>
        <p className="text-xs text-stone-400 mb-2">Click to set hero (background removed)</p>
        <div className="grid grid-cols-2 gap-2">
          {displayedImgs.map((img, i) => (
            <button
              key={img}
              onClick={() => setHeroIdx(i)}
              className={`relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                heroIdx === i
                  ? 'border-stone-800 ring-2 ring-stone-300'
                  : 'border-stone-200 hover:border-stone-400'
              }`}
            >
              <img
                src={img}
                alt={`${label} image ${i + 1}`}
                className="w-full h-full object-cover"
                onError={() => {
                  setBrokenSet(prev => new Set(prev).add(img))
                  if (heroIdx === i) setHeroIdx(0)
                }}
              />
              {heroIdx === i && (
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-stone-800 text-white text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">
                  Hero
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1">Name</label>
          <input
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
            value={nameVal} onChange={e => setNameVal(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1">Dimensions</label>
          <input
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
            value={dimsVal} onChange={e => setDimsVal(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-500 mb-1">Description</label>
          <textarea
            rows={3}
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400 resize-none"
            value={descVal} onChange={e => setDescVal(e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}

// ── Main app ───────────────────────────────────────────────────────────────

export default function App() {
  const [mode, setMode] = useState<Mode>('single')

  // shared
  const [step, setStep] = useState<Step>('input')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [deckUrl, setDeckUrl] = useState('')

  // single-product
  const [url, setUrl] = useState('')
  const [scraped, setScraped] = useState<ScrapeResult | null>(null)
  const [heroIndex, setHeroIndex] = useState(0)
  const [supportingIndices, setSupportingIndices] = useState<number[]>([])
  const [name, setName] = useState('')
  const [dimensions, setDimensions] = useState('')
  const [description, setDescription] = useState('')
  const [broken, setBroken] = useState<BrokenSet>(new Set())

  // mask editor (single-product only)
  const [processingHero, setProcessingHero] = useState(false)
  const [processedHeroUrl, setProcessedHeroUrl] = useState('')
  const [editingHero, setEditingHero] = useState(false)

  // two-product
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

  // derived
  const displayedImages = scraped
    ? scraped.images.slice(0, 12).filter(img => !broken.has(img)).slice(0, 8)
    : []
  const displayedA = scrapedA
    ? scrapedA.images.slice(0, 12).filter(img => !brokenA.has(img)).slice(0, 4)
    : []
  const displayedB = scrapedB
    ? scrapedB.images.slice(0, 12).filter(img => !brokenB.has(img)).slice(0, 4)
    : []

  // ── mode switch ──────────────────────────────────────────────────────
  function switchMode(next: Mode) {
    setMode(next)
    setStep('input')
    setError('')
    setDeckUrl('')
  }

  // ── single-product handlers ──────────────────────────────────────────
  function setHero(i: number) {
    setSupportingIndices(prev => prev.filter(idx => idx !== i))
    setHeroIndex(i)
    setProcessedHeroUrl('')  // stale once hero changes
  }

  function toggleSupporting(i: number, e: React.MouseEvent) {
    e.stopPropagation()
    if (i === heroIndex) return
    setSupportingIndices(prev => {
      if (prev.includes(i)) return prev.filter(idx => idx !== i)
      if (prev.length >= 2) return prev
      return [...prev, i]
    })
  }

  async function handleScrape() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Scrape failed') }
      const data: ScrapeResult = await res.json()
      setScraped(data); setName(data.name); setDimensions(data.dimensions); setDescription(data.description)
      setHeroIndex(0); setSupportingIndices([]); setBroken(new Set())
      setStep('review')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerate() {
    if (!scraped) return
    setStep('generating'); setError('')
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hero_image_url: displayedImages[heroIndex],
          supporting_image_urls: supportingIndices.map(i => displayedImages[i]),
          name, dimensions, description,
        }),
      })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Generate failed') }
      const data = await res.json()
      setDeckUrl(data.deck_url); setStep('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e)); setStep('review')
    }
  }

  // ── mask editor handler ──────────────────────────────────────────────
  async function handleEditCutout() {
    const vendorUrl = displayedImages[heroIndex]
    if (!vendorUrl) return
    setProcessingHero(true)
    setError('')
    try {
      const res = await fetch('/api/process-hero', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: vendorUrl }),
      })
      if (!res.ok) { const b = await res.json(); throw new Error(b.detail || 'Processing failed') }
      const { hero_url } = await res.json()
      setProcessedHeroUrl(hero_url)
      setEditingHero(true)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessingHero(false)
    }
  }

  // ── two-product handlers ─────────────────────────────────────────────
  async function handleScrapeTwo() {
    setError('')
    setLoading(true)
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
    setStep('input'); setUrl(''); setScraped(null); setDeckUrl(''); setError('')
    setBroken(new Set()); setSupportingIndices([])
    setProcessedHeroUrl(''); setEditingHero(false); setProcessingHero(false)
    setUrlA(''); setUrlB(''); setScrapedA(null); setScrapedB(null)
    setBrokenA(new Set()); setBrokenB(new Set())
  }

  // ── render ───────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      <header className="bg-white border-b border-stone-200 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">Hudson &amp; Crane — Slide Generator</h1>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10 space-y-6">

        {/* Step 1 — URL input */}
        <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="font-medium text-stone-700">1. Paste a vendor product URL</h2>
            <div className="flex rounded-lg border border-stone-200 overflow-hidden text-sm">
              <button
                onClick={() => switchMode('single')}
                className={`px-4 py-1.5 transition-colors ${mode === 'single' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-50'}`}
              >
                Single product
              </button>
              <button
                onClick={() => switchMode('two')}
                className={`px-4 py-1.5 transition-colors ${mode === 'two' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-50'}`}
              >
                Two products
              </button>
            </div>
          </div>

          {mode === 'single' ? (
            <div className="flex gap-3">
              <input
                className="flex-1 border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
                placeholder="https://www.potterybarn.com/products/..."
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !loading && handleScrape()}
                disabled={loading}
              />
              <button
                onClick={handleScrape}
                disabled={!url.trim() || loading}
                className="bg-stone-800 text-white text-sm font-medium px-5 py-2 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors"
              >
                {loading ? 'Scraping…' : 'Scrape'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Product A URL</label>
                  <input
                    className="w-full border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
                    placeholder="https://www.potterybarn.com/products/..."
                    value={urlA}
                    onChange={e => setUrlA(e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-500 mb-1">Product B URL</label>
                  <input
                    className="w-full border border-stone-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-400"
                    placeholder="https://www.potterybarn.com/products/..."
                    value={urlB}
                    onChange={e => setUrlB(e.target.value)}
                    disabled={loading}
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
            </div>
          )}
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </section>

        {/* Step 2 — Review (single-product) */}
        {mode === 'single' && (step === 'review' || step === 'generating' || step === 'done') && scraped && (
          <section className="bg-white rounded-xl border border-stone-200 p-6 space-y-6">
            <h2 className="font-medium text-stone-700">2. Select images &amp; review text</h2>
            <div>
              <p className="text-xs text-stone-500 mb-3">
                Click an image to set it as the <strong>hero</strong> (background removed).
                Use <strong>+</strong> to add up to 2 <span className="text-emerald-700 font-medium">supporting</span> images (kept as-is).
              </p>
              <div className="grid grid-cols-4 gap-3">
                {displayedImages.map((img, i) => {
                  const isHero = heroIndex === i
                  const supportRank = supportingIndices.indexOf(i)
                  const isSupporting = supportRank !== -1
                  const canAdd = !isHero && !isSupporting && supportingIndices.length < 2
                  return (
                    <button
                      key={img}
                      onClick={() => setHero(i)}
                      className={`relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                        isHero ? 'border-stone-800 ring-2 ring-stone-300'
                        : isSupporting ? 'border-emerald-500 ring-2 ring-emerald-200'
                        : 'border-stone-200 hover:border-stone-400'
                      }`}
                    >
                      <img
                        src={img} alt={`Product image ${i + 1}`} className="w-full h-full object-cover"
                        onError={() => {
                          setBroken(prev => new Set(prev).add(img))
                          if (heroIndex === i) setHeroIndex(0)
                          setSupportingIndices(prev => prev.filter(idx => idx !== i))
                        }}
                      />
                      {isHero && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-stone-800 text-white text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">Hero</span>}
                      {isSupporting && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-emerald-600 text-white text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap">Support {supportRank + 1}</span>}
                      {!isHero && (
                        <button
                          onClick={e => toggleSupporting(i, e)}
                          disabled={!isSupporting && !canAdd}
                          className={`absolute top-1 right-1 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center transition-colors ${
                            isSupporting ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                            : canAdd ? 'bg-white/80 text-stone-600 hover:bg-white border border-stone-300'
                            : 'bg-white/40 text-stone-400 cursor-not-allowed'
                          }`}
                        >
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
                  {supportingIndices.length < 2 && ' (you can add 1 more)'}
                </p>
              )}
            </div>

            {/* Optional mask editor entry point */}
            <div className="flex items-center justify-between py-1">
              <p className="text-xs text-stone-400">
                Background removal runs on the hero.{' '}
                {processedHeroUrl ? (
                  <span className="text-emerald-600 font-medium">Cutout preview ready.</span>
                ) : (
                  'Optionally inspect and touch up the cutout before generating.'
                )}
              </p>
              <button
                onClick={handleEditCutout}
                disabled={processingHero || step !== 'review'}
                className="shrink-0 ml-4 text-xs border border-stone-300 text-stone-600 px-3 py-1.5 rounded-lg hover:border-stone-600 hover:text-stone-800 disabled:opacity-40 transition-colors"
              >
                {processingHero ? 'Processing…' : processedHeroUrl ? 'Re-edit cutout' : 'Edit cutout'}
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
            <button
              onClick={handleGenerate}
              disabled={step === 'generating' || step === 'done'}
              className="w-full bg-stone-800 text-white text-sm font-medium py-3 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors"
            >
              {step === 'generating' ? 'Generating… (removing background, creating slide)' : 'Generate Slide'}
            </button>
          </section>
        )}

        {/* Step 2 — Review (two-product) */}
        {mode === 'two' && (step === 'review' || step === 'generating' || step === 'done') && scrapedA && scrapedB && (
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
                href={deckUrl}
                target="_blank"
                rel="noopener noreferrer"
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

      </main>

      {/* Mask editor modal (single-product only) */}
      {editingHero && processedHeroUrl && (
        <MaskEditor
          originalUrl={displayedImages[heroIndex]}
          rembgUrl={processedHeroUrl}
          onApply={(_dataUrl) => {
            // Placeholder — full wiring in step 6
            setEditingHero(false)
          }}
          onCancel={() => setEditingHero(false)}
        />
      )}
    </div>
  )
}
