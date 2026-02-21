import clsx from 'clsx'
import { useSettings } from '../contexts/SettingsContext'

// Standard 4-period set (cards & collection)
export const CARD_PERIODS = [
  { key: '1d', de: '1T', en: '1D' },
  { key: '7d', de: '7T', en: '7D' },
  { key: '30d', de: '30T', en: '30D' },
  { key: 'total', de: 'Gesamt', en: 'Total' },
]

// 5-period set for products page (adds 1Y)
export const PRODUCT_PERIODS = [
  { key: '1d', de: '1T', en: '1D' },
  { key: '7d', de: '7T', en: '7D' },
  { key: '30d', de: '30T', en: '30D' },
  { key: '1y', de: '1J', en: '1Y' },
  { key: 'total', de: 'Gesamt', en: 'Total' },
]

// Maps period key → Card DB price field
export const PERIOD_PRICE_FIELD = {
  '1d': 'price_avg1',
  '7d': 'price_avg7',
  '30d': 'price_avg30',
  'total': 'price_trend',
}

// Maps period key → days (for top-movers API)
export const PERIOD_DAYS = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  'total': 90,
}

// Maps period key → cutoff date string (for product date filtering)
export function getPeriodCutoff(periodKey) {
  const now = new Date()
  switch (periodKey) {
    case '1d':
      now.setDate(now.getDate() - 1)
      break
    case '7d':
      now.setDate(now.getDate() - 7)
      break
    case '30d':
      now.setDate(now.getDate() - 30)
      break
    case '1y':
      now.setFullYear(now.getFullYear() - 1)
      break
    case 'total':
    default:
      return null
  }
  return now.toISOString().split('T')[0]
}

/**
 * PeriodSelector — broker-style horizontal button bar.
 */
export default function PeriodSelector({ value, onChange, periods = CARD_PERIODS, size = 'sm' }) {
  const { language } = useSettings()

  return (
    <div className="period-selector-wrapper">
      <div className="inline-flex items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1">
        {periods.map(p => {
          const label = language === 'de' ? p.de : p.en
          const isActive = value === p.key
          return (
            <button
              key={p.key}
              onClick={() => onChange(p.key)}
              className={clsx(
                'rounded-md font-semibold transition-all duration-150 min-h-[36px] touch-manipulation',
                size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-4 py-1.5 text-sm',
                isActive
                  ? 'bg-brand-red text-white shadow-sm'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-elevated'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
