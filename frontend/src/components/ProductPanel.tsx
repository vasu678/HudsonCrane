import type { BrokenSet } from '../types'

interface ProductPanelProps {
  label: string
  heroIdx: number
  setHeroIdx: (i: number) => void
  brokenSet: BrokenSet
  setBrokenSet: (fn: (prev: BrokenSet) => BrokenSet) => void
  displayedImgs: string[]
  nameVal: string
  setNameVal: (v: string) => void
  dimsVal: string
  setDimsVal: (v: string) => void
  descVal: string
  setDescVal: (v: string) => void
}

export default function ProductPanel({
  label, heroIdx, setHeroIdx, brokenSet: _brokenSet, setBrokenSet, displayedImgs,
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
