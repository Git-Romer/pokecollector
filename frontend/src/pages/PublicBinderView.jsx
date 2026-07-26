import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPublicBinder } from '../api/publicClient'
import { formatEur } from '../utils/formatEur'
import { groupCardsByPrint } from '../utils/groupCardsByPrint'
import { getOwnedVariants, VARIANT_PILL_META } from '../utils/cardVariants'
import { useSettings } from '../contexts/SettingsContext'

function PublicVariantPills({ prints, t }) {
  const variants = getOwnedVariants(prints)
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {variants.map(({ variant, quantity }) => {
        const meta = VARIANT_PILL_META[variant]
        const translated = t(`variants.${variant}`)
        const label = translated === `variants.${variant}` ? variant : translated
        const title = quantity > 1 ? `${label} ×${quantity}` : label
        return (
          <span
            key={variant}
            title={title}
            aria-label={title}
            className={`inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] font-bold leading-none shadow-sm ${meta?.className || 'border-zinc-500 bg-zinc-700 text-white'}`}
          >
            {meta?.code || variant.slice(0, 3).toUpperCase()}
            {quantity > 1 && <span>×{quantity}</span>}
          </span>
        )
      })}
    </div>
  )
}

export default function PublicBinderView() {
  const { handle, binderId } = useParams()
  const [binder, setBinder] = useState(null)
  const [error, setError] = useState(null)
  const { t } = useSettings()

  useEffect(() => {
    let cancelled = false
    setBinder(null)
    setError(null)
    getPublicBinder(handle, binderId)
      .then(data => { if (!cancelled) setBinder(data) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [handle, binderId])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('publicProfiles.binderUnavailable')}</div>
  if (!binder) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('common.loading')}</div>

  const tiles = groupCardsByPrint(binder.cards)

  return (
    <main className="min-h-screen bg-bg-primary px-3 py-6 text-text-primary sm:px-4">
      <div className="mx-auto max-w-5xl">
        <Link to={`/u/${handle}`} className="text-sm font-semibold text-text-secondary transition hover:text-text-primary">← @{handle}</Link>
        <div className="my-4 flex flex-wrap items-baseline justify-between gap-2 rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted">{t('publicProfiles.sharedBinder')}</p>
            <h1 className="text-2xl font-bold">{binder.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {binder.unique_card_count} {binder.unique_card_count === 1 ? t('binders.uniqueCard') : t('binders.uniqueCards')}
            </p>
          </div>
          {binder.total_value != null && (
            <span className="text-lg font-semibold">{formatEur(binder.total_value)}</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {tiles.map(tile => {
          // Depth follows distinct prints: 1 layer behind for 2 variants, 2 for 3+.
          const backLayers = Math.min(tile.variantCount - 1, 2)
          return (
            <article key={tile.id} className="rounded-xl border border-border bg-bg-secondary p-2 shadow-sm">
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
              <PublicVariantPills prints={tile.prints} t={t} />
              {tile.total_value != null && (
                <div className="text-xs font-semibold">{formatEur(tile.total_value)}</div>
              )}
            </article>
          )
        })}
        </div>
      </div>
    </main>
  )
}
