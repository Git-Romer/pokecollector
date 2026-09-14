import { deckComposition } from '../../utils/deckProgress'

export const DECK_CATEGORY_STYLES = {
  Pokemon: { fill: 'bg-red-500', dot: 'bg-red-400' },
  Trainer: { fill: 'bg-blue-500', dot: 'bg-blue-400' },
  Energy: { fill: 'bg-yellow-400', dot: 'bg-yellow-300' },
  Other: { fill: 'bg-slate-500', dot: 'bg-slate-400' },
}

export default function DeckCompositionBar({ entries, compositionCounts, progress, t, label, compact = false }) {
  const composition = deckComposition(entries, progress.target, compositionCounts)
  const categories = ['Pokemon', 'Trainer', 'Energy', 'Other'].filter(category => composition.counts[category] > 0 || category !== 'Other')

  return (
    <div className={compact ? 'space-y-2' : 'card space-y-3'}>
      {!compact && <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xl font-black text-text-primary">{progress.current} <span className="text-text-muted">/ {progress.target}</span></p>
          <p className={`mt-1 text-xs font-medium ${progress.status === 'over' ? 'text-brand-red' : progress.status === 'complete' ? 'text-green' : 'text-yellow'}`}>
            {progress.status === 'complete' ? t('decks.complete') : progress.status === 'over' ? label('decks.over', { count: progress.over }) : label('decks.remaining', { count: progress.remaining })}
          </p>
        </div>
        {progress.missing > 0 && <p className="text-xs font-medium text-brand-red">{label('decks.missingCopies', { count: progress.missing })}</p>}
      </div>}
      <div className={`${compact ? 'h-2' : 'h-4'} flex min-w-0 max-w-full overflow-hidden rounded-full border border-border bg-bg-elevated`} aria-label={t('decks.composition')}>
        {composition.segments.map(segment => segment.visibleCount > 0 && (
          <span
            key={segment.category}
            className={`${DECK_CATEGORY_STYLES[segment.category].fill} flex-none transition-[width]`}
            style={{ width: `${segment.widthPercent}%` }}
            title={`${t(`decks.${segment.category}`)} ${segment.count}`}
          />
        ))}
        {composition.remaining > 0 && <span className="flex-none bg-bg-elevated" style={{ width: `${composition.remainingPercent}%` }} />}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-secondary">
        {categories.map(category => (
          <span key={category} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${DECK_CATEGORY_STYLES[category].dot}`} />
            {t(`decks.${category}`)} {composition.counts[category]}
          </span>
        ))}
      </div>
    </div>
  )
}
