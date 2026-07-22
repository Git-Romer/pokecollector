import clsx from 'clsx'
import { Circle, Medal, Sparkles, SquareAsterisk } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import { getOwnedVariants, VARIANT_PILL_META } from '../utils/cardVariants'

// Icons live here rather than in cardVariants.js: that module is pure data and logic,
// and should not pull in React components. A variant with no icon (a CSV-imported
// "Full Art", say) falls back to its 3-letter code.
// Holo and Reverse Holo are a deliberate pair: bare sparkles for foil on the art,
// sparkle-inside-a-square for foil across the whole card.
const VARIANT_ICONS = {
  'Normal': Circle,
  'Holo': Sparkles,
  'Reverse Holo': SquareAsterisk,
  'First Edition': Medal,
}

export default function VariantPills({ rows, className = '' }) {
  const { t } = useSettings()
  const owned = getOwnedVariants(rows)
  if (owned.length === 0) return null

  return (
    <div className={clsx('flex flex-wrap gap-1', className)}>
      {owned.map(({ variant, quantity }) => {
        const meta = VARIANT_PILL_META[variant]
        const Icon = VARIANT_ICONS[variant]

        // A non-canonical variant has no i18n key, and t() returns the raw path when it
        // can't resolve one. Show the variant name rather than "variants.Full Art".
        const key = `variants.${variant}`
        const translated = t(key)
        const label = translated === key ? variant : translated
        const title = quantity > 1 ? `${label} ×${quantity}` : label

        return (
          <span
            key={variant}
            title={title}
            aria-label={title}
            className={clsx(
              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border shadow-sm',
              'text-[10px] font-bold leading-none tracking-wide',
              meta?.className || 'bg-zinc-700 text-white border-zinc-500',
            )}
          >
            {Icon
              ? <Icon size={11} strokeWidth={2.5} aria-hidden className="flex-shrink-0" />
              : (meta?.code || variant.slice(0, 3).toUpperCase())}
            {quantity > 1 && <span className="opacity-90">×{quantity}</span>}
          </span>
        )
      })}
    </div>
  )
}
