import { ExternalLink, Package } from 'lucide-react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'

export function ProductSourceLink({ source, t, className = '', showName = false }) {
  if (source?.product_id == null) return null

  const label = t('products.openLinkedProduct')
  return (
    <Link
      to={`/products?productId=${encodeURIComponent(source.product_id)}`}
      aria-label={`${label}: ${source.product_name}`}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded text-xs font-semibold text-brand-red underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-red/50',
        className,
      )}
    >
      <ExternalLink size={12} aria-hidden="true" />
      {showName ? `${label}: ${source.product_name}` : label}
    </Link>
  )
}

export default function ProductSourceList({ sources = [], t, className = '' }) {
  const activeSources = (Array.isArray(sources) ? sources : [])
    .filter(source => Number(source?.active_quantity) > 0)

  if (activeSources.length === 0) return null

  return (
    <section
      aria-label={t('collection.foundIn')}
      className={clsx('space-y-1 rounded-xl border border-border/70 bg-bg-card/40 p-3', className)}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        <Package size={14} aria-hidden="true" />
        <span>{t('collection.foundIn')}</span>
      </div>
      <ul className="divide-y divide-border/50">
        {activeSources.map((source, index) => (
          <li
            key={source.product_card_id || `${source.product_id}-${index}`}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary" title={source.product_name}>
                {source.product_name}
              </p>
              <p className="text-xs text-text-muted">
                {[source.product_type, source.purchase_date, `${t('collection.qty')} ×${source.active_quantity}`].filter(Boolean).join(' · ')}
              </p>
            </div>
            <ProductSourceLink source={source} t={t} />
          </li>
        ))}
      </ul>
    </section>
  )
}
