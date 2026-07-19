import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPublicBinder } from '../api/publicClient'
import { formatEur } from '../utils/formatEur'

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
        {binder.cards.map(card => (
          <div key={card.id} className="rounded-lg border border-border p-2">
            {card.image
              ? <img src={card.image} alt={card.name} className="w-full rounded" loading="lazy" />
              : <div className="aspect-[3/4] bg-bg-secondary rounded" />}
            <div className="mt-1 text-sm font-medium truncate">{card.name}</div>
            <div className="text-xs text-text-secondary">
              {card.set_name} · #{card.number}{card.quantity > 1 ? ` · ×${card.quantity}` : ''}
            </div>
            {card.market_value != null && (
              <div className="text-xs font-semibold">{formatEur(card.market_value)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
