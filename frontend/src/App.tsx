import { useState } from 'react'
import type { Mode } from './types'
import { CutoutStudioView } from './views/CutoutStudioView'
import SingleProductView from './views/SingleProductView'

export default function App() {
  const [mode, setMode] = useState<Mode>('single')

  return (
    <div className="min-h-screen bg-stone-50 text-stone-800">
      <header className="bg-white border-b border-stone-200 px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight text-stone-900">
          Hudson &amp; Crane — <span className="text-stone-500 font-normal">Slide Generator</span>
        </h1>

        <nav className="flex items-center bg-stone-100 p-1.5 rounded-xl border border-stone-200 gap-1">
          <button
            onClick={() => setMode('single')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              mode === 'single'
                ? 'bg-white text-stone-900 shadow-sm ring-1 ring-stone-200'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <span>🛋️</span> Product Spec Slide
          </button>
          <button
            onClick={() => setMode('cutout')}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              mode === 'cutout'
                ? 'bg-white text-stone-900 shadow-sm ring-1 ring-stone-200'
                : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            <span>✂️</span> Cutout Studio (Moodboards)
          </button>
        </nav>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        <div className={mode === 'single' ? 'block' : 'hidden'}>
          <SingleProductView />
        </div>
        <div className={mode === 'cutout' ? 'block' : 'hidden'}>
          <CutoutStudioView />
        </div>
      </main>
    </div>
  )
}


