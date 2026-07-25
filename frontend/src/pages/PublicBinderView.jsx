import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPublicBinder } from '../api/publicClient'
import { formatEur } from '../utils/formatEur'
import { groupCardsByPrint } from '../utils/groupCardsByPrint'
import CardStateIndicators from '../components/CardStateIndicators'

export default function PublicBinderView() {
  const { handle, binderId } = useParams()
  const [binder, setBinder] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getPublicBinder(handle, binderId)
      .then(data => { if (!cancelled) setBinder(data) })
      .catch(() => { if (!cancelled) setError('This binder is not available.') })
    return () => { cancelled = true }
  }, [handle, binderId])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{error}</div>
  if (!binder) return <div className="min-h-screen flex items-center justify-center text-text-secondary">Loading…</div>

  const tiles = groupCardsByPrint(binder.cards)

  return (
    <div className="max-w-5xl mx-auto p-4">
      <Link to={`/u/${handle}`} className="text-sm text-text-secondary">← {handle}</Link>
      <div className="flex items-baseline justify-between mt-2 mb-4">
        <h1 className="text-2xl font-bold">{binder.name}</h1>
        {binder.total_value != null && (
          <span className="text-lg font-semibold">{formatEur(binder.total_value)}</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {tiles.map(tile => {
          // Depth follows distinct prints: 1 layer behind for 2 variants, 2 for 3+.
          const backLayers = Math.min(tile.variantCount - 1, 2)
          return (
            <div key={tile.id} className="rounded-lg border border-border p-2">
              <div className="relative" style={{ marginRight: backLayers * 5, marginBottom: backLayers * 5 }}>
                {Array.from({ length: backLayers }).map((_, idx) => {
                  const depth = idx + 1
                  return (
                    <div
                      key={idx}
                      aria-hidden
                      className="absolute inset-0 rounded border border-border bg-bg-secondary shadow-sm"
                      style={{ transform: `translate(${depth * 5}px, ${depth * 5}px) rotate(${depth * 2}deg)`, zIndex: 0 }}
                    />
                  )
                })}
                <div className="relative z-10 rounded overflow-hidden aspect-[5/7] bg-bg-secondary">
                  {tile.image
                    ? <img src={tile.image} alt={tile.name} className="w-full h-full object-cover" loading="lazy" />
                    : <div className="w-full h-full" />}
                </div>
              </div>
              <div className="mt-1 text-sm font-medium truncate">{tile.name}</div>
              <div className="text-xs text-text-secondary">{tile.set_name} · #{tile.number}</div>
              <CardStateIndicators card={{ owned_items: tile.prints }} showWishlist={false} className="mt-1" />
              {tile.total_value != null && (
                <div className="text-xs font-semibold">{formatEur(tile.total_value)}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
