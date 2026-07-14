import clsx from 'clsx'
import { useSettings } from '../contexts/SettingsContext'
import { getOwnedVariants, VARIANT_PILL_META } from '../utils/cardVariants'

export default function VariantPills({ rows, className = '' }) {
  const { t } = useSettings()
  const owned = getOwnedVariants(rows)
  if (owned.length === 0) return null

  return (
    <div className={clsx('flex flex-wrap gap-0.5', className)}>
      {owned.map(({ variant, quantity }) => {
        const meta = VARIANT_PILL_META[variant]
        const label = t(`variants.${variant}`) || variant
        return (
          <span
            key={variant}
            title={quantity > 1 ? `${label} ×${quantity}` : label}
            className={clsx(
              'px-1 py-px rounded border text-[9px] font-bold leading-none tracking-wide',
              meta?.className || 'bg-bg-elevated text-text-muted border-border',
            )}
          >
            {meta?.code || variant.slice(0, 3).toUpperCase()}
            {quantity > 1 && <span className="ml-0.5 opacity-80">×{quantity}</span>}
          </span>
        )
      })}
    </div>
  )
}
