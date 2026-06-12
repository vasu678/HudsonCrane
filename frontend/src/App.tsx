import { useState } from 'react'
import type { Mode } from './types'
import SingleProductView from './views/SingleProductView'
import TwoProductView from './views/TwoProductView'

export default function App() {
  const [mode, setMode] = useState<Mode>('single')

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      <header className="bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Hudson &amp; Crane — Slide Generator</h1>
        <div className="flex rounded-lg border border-stone-200 overflow-hidden text-sm">
          <button
            onClick={() => setMode('single')}
            className={`px-4 py-1.5 transition-colors ${mode === 'single' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-50'}`}
          >
            Single product
          </button>
          <button
            onClick={() => setMode('two')}
            className={`px-4 py-1.5 transition-colors ${mode === 'two' ? 'bg-stone-800 text-white' : 'text-stone-500 hover:bg-stone-50'}`}
          >
            Two products
          </button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-6 py-10 space-y-6">
        {mode === 'single' ? <SingleProductView key="single" /> : <TwoProductView key="two" />}
      </main>
    </div>
  )
}
