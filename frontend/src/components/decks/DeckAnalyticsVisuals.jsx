import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

export const DECK_COMPOSITION_COLORS = {
  Pokemon: '#ef4444',
  Trainer: '#3b82f6',
  Energy: '#facc15',
  Other: '#64748b',
}

export const DECK_COMPARISON_COLORS = {
  left: '#3b82f6',
  right: '#8b5cf6',
}

const percentage = value => `${(Number(value || 0) * 100).toFixed(1)}%`

export function DeckAnalyticsSection({ title, icon: Icon, description, action, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {Icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-red/10 text-brand-red"><Icon size={18} aria-hidden /></span>}
            <div className="min-w-0">
              <h3 className="font-semibold text-text-primary">{title}</h3>
              {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
            </div>
          </div>
          {action}
        </div>
        {children}
      </div>
    </section>
  )
}

export function DeckMetricGrid({ items, className }) {
  return <div className={`grid gap-2 ${className || 'grid-cols-2 sm:grid-cols-3'}`}>{items.map(({ label, value, accent = 'text-text-primary', detail, icon: Icon }) => <div key={label} className="rounded-xl border border-border bg-bg-card p-3"><div className="flex items-start justify-between gap-2"><div className={`min-w-0 text-xl font-black ${accent}`}>{value}</div>{Icon && <Icon size={17} className={`shrink-0 ${accent}`} aria-hidden />}</div><p className="mt-1 text-xs text-text-muted">{label}</p>{detail && <p className="mt-1 text-xs text-text-secondary">{detail}</p>}</div>)}</div>
}

export function DeckProbabilityBar({ label, value, detail, color = '#e3000b', compact = false }) {
  const numeric = Math.max(0, Math.min(Number(value || 0), 1))
  return <div className={`rounded-xl border border-border bg-bg-card ${compact ? 'p-2.5' : 'p-3'}`}><div className={compact ? 'flex flex-col gap-1' : 'flex items-end justify-between gap-3'}><div className="min-w-0"><p className={`${compact ? 'text-[10px] leading-snug sm:text-xs' : 'text-xs'} text-text-muted`}>{label}</p>{detail && <p className="mt-1 text-xs text-text-secondary">{detail}</p>}</div><strong className={`${compact ? 'text-xl' : 'text-lg'} whitespace-nowrap text-text-primary`}>{percentage(numeric)}</strong></div><div className={`${compact ? 'mt-2' : 'mt-3'} h-2 overflow-hidden rounded-full bg-bg-elevated`}><div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${numeric * 100}%`, backgroundColor: color }} /></div></div>
}

export function DeckCompositionDonut({ items, totalLabel, ariaLabel, compact = false }) {
  const visible = items.filter(item => Number(item.value || 0) > 0)
  const total = visible.reduce((sum, item) => sum + Number(item.value || 0), 0)
  const chartHeight = compact ? 'h-36' : 'h-52'
  const chartWidth = compact ? 'max-w-40' : 'max-w-60'

  return <div className={compact ? 'space-y-3' : 'grid items-center gap-4 sm:grid-cols-[minmax(180px,0.9fr)_minmax(180px,1.1fr)]'}><div className={`relative mx-auto w-full ${chartHeight} ${chartWidth}`} role="img" aria-label={ariaLabel} data-composition-donut><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={visible} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius="58%" outerRadius="86%" paddingAngle={3} cornerRadius={5} stroke="none" isAnimationActive={false}>{visible.map(item => <Cell key={item.key} fill={item.color || DECK_COMPOSITION_COLORS[item.key] || DECK_COMPOSITION_COLORS.Other} />)}</Pie></PieChart></ResponsiveContainer><div className="pointer-events-none absolute inset-0 grid place-content-center text-center"><strong className={`${compact ? 'text-2xl' : 'text-3xl'} font-black text-text-primary`}>{total}</strong><span className="text-[10px] text-text-muted sm:text-[11px]">{totalLabel}</span></div></div><div className="space-y-1.5">{visible.map(item => <div key={item.key} className="flex items-center gap-2 rounded-lg bg-bg-elevated/45 px-2 py-1.5"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color || DECK_COMPOSITION_COLORS[item.key] || DECK_COMPOSITION_COLORS.Other }} /><span className="min-w-0 flex-1 truncate text-xs text-text-secondary sm:text-sm">{item.label}</span><strong className="text-xs text-text-primary sm:text-sm">{item.value}</strong>{item.percent != null && <span className="hidden w-9 text-right text-[10px] text-text-muted sm:inline">{item.percent}%</span>}</div>)}</div></div>
}

export function DeckPairLegend({ leftName, rightName, leftLabel = 'Deck A', rightLabel = 'Deck B' }) {
  return <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold sm:text-xs" data-deck-pair-legend><span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-blue/10 px-2 py-1 text-blue" data-deck-pair="left"><b className="shrink-0">{leftLabel}</b><span className="truncate text-text-secondary">{leftName}</span></span><span className="text-text-muted" aria-hidden>vs</span><span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-violet-500/10 px-2 py-1 text-violet-400" data-deck-pair="right"><b className="shrink-0">{rightLabel}</b><span className="truncate text-text-secondary">{rightName}</span></span></div>
}

export function DeckPairedBar({ label, left, right, max = 1, color = '#64748b', leftName, rightName, leftLabel = 'A', rightLabel = 'B', testId }) {
  const row = (side, value, name, sideLabel) => {
    const accent = DECK_COMPARISON_COLORS[side]
    const width = `${Math.max(0, Math.min(Number(value || 0) / Math.max(Number(max || 0), 1), 1)) * 100}%`
    return <div data-deck-pair={side}><div className="mb-1 flex items-center justify-between gap-2 text-[10px] sm:text-xs"><span className="flex min-w-0 items-center gap-1.5"><b className={`rounded px-1 py-0.5 ${side === 'left' ? 'bg-blue/10 text-blue' : 'bg-violet-500/10 text-violet-400'}`}>{sideLabel}</b><span className="truncate text-text-muted">{name}</span></span><strong className="shrink-0 text-text-primary">{value}</strong></div><div className="h-2 overflow-hidden rounded-full bg-bg-elevated"><div className="h-full rounded-full transition-[width] duration-300" style={{ width, backgroundColor: accent }} /></div></div>
  }
  return <article className="rounded-xl border border-border bg-bg-card p-3" data-comparison-metric={testId || (typeof label === 'string' ? label : undefined)}><h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />{label}</h4><div className="space-y-2.5">{row('left', left, leftName, leftLabel)}{row('right', right, rightName, rightLabel)}</div></article>
}

export function DeckSideMetricCard({ side, name, sideLabel, label, value, detail, barValue, color }) {
  const accent = color || DECK_COMPARISON_COLORS[side]
  return <article className="relative overflow-hidden rounded-xl border border-border bg-bg-card p-3" data-deck-pair={side}><span className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} /><div className="mb-3 flex min-w-0 items-center gap-1.5"><b className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${side === 'left' ? 'bg-blue/10 text-blue' : 'bg-violet-500/10 text-violet-400'}`}>{sideLabel}</b><span className="truncate text-xs font-semibold text-text-secondary">{name}</span></div><DeckProbabilityBar compact label={label} value={barValue} detail={detail} color={accent} />{value != null && <span className="sr-only">{value}</span>}</article>
}
