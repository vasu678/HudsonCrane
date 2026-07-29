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
      </header>
      <main className="max-w-4xl mx-auto px-6 py-10 space-y-6">
        <SingleProductView key="single" />
      </main>
    </div>
  )
}
