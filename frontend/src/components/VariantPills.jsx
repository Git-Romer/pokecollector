import clsx from 'clsx'
import { useSettings } from '../contexts/SettingsContext'
import { getOwnedVariants, VARIANT_PILL_META } from '../utils/cardVariants'

export default function VariantPills({ rows, className = '' }) {
  const { t } = useSettings()
  const owned = getOwnedVariants(rows)
  if (owned.length === 0) return null

  return (
    <div className={clsx('flex flex-wrap gap-1', className)}>
      {owned.map(({ variant, quantity }) => {
        const meta = VARIANT_PILL_META[variant]
        // A non-canonical variant (a CSV-imported "Full Art", say) has no i18n key, and
        // t() returns the raw path when it can't resolve one. Show the variant name
        // rather than the string "variants.Full Art".
        const key = `variants.${variant}`
        const translated = t(key)
        const label = translated === key ? variant : translated
        return (
          <span
            key={variant}
            title={quantity > 1 ? `${label} ×${quantity}` : label}
            className={clsx(
              'px-1.5 py-0.5 rounded border text-[10px] font-bold leading-none tracking-wide shadow-sm',
              meta?.className || 'bg-zinc-700 text-white border-zinc-500',
            )}
          >
            {meta?.code || variant.slice(0, 3).toUpperCase()}
            {quantity > 1 && <span className="ml-1 opacity-90">×{quantity}</span>}
          </span>
        )
      })}
    </div>
  )
}
