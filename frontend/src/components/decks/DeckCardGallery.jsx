import { Minus, Plus, Trash2 } from 'lucide-react'
import { CollectionCardDisplay } from '../CollectionCardImage'

export default function DeckCardGallery({ entries, onOpen, onQuantityChange, onRemove, t, label, pendingEntryIds, isRemoving }) {
  if (entries.length === 0) {
    return <div className="card py-14 text-center text-sm text-text-muted">{t('decks.emptyDeck')}</div>
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {entries.map((entry, index) => (
        <article key={entry.id} className="group relative overflow-hidden rounded-xl border border-border bg-bg-card shadow-sm">
          <button
            type="button"
            onClick={() => onOpen(index)}
            className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
            aria-label={label('decks.openCard', { name: entry.card?.name || entry.card_id })}
          >
            <CollectionCardDisplay variant="artwork" item={{ card: entry.card }} card={entry.card} variantEffectSource={entry.display_variant || entry.card} alt={entry.card?.name || entry.card_id} />
          </button>
          <span className="absolute left-2 top-2 rounded-full bg-black/80 px-2 py-0.5 text-xs font-black text-white shadow">x{entry.required_quantity}</span>
          {entry.shortage > 0 && <span className="absolute right-2 top-2 rounded-full bg-brand-red px-2 py-0.5 text-[10px] font-bold text-white shadow">{label('decks.shortage', { count: entry.shortage })}</span>}
          <div className="flex items-center justify-between gap-1 border-t border-border bg-bg-surface/95 px-1.5 py-1.5">
            <button type="button" className="rounded-md p-1.5 text-text-muted hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40" disabled={entry.required_quantity <= 1} onClick={() => onQuantityChange(entry, -1)} aria-label={label('decks.decreaseQuantity', { name: entry.card?.name || entry.card_id })}><Minus size={14} /></button>
            <button type="button" className="min-w-0 flex-1 truncate text-xs font-semibold text-text-primary hover:text-brand-red" onClick={() => onOpen(index)}>{entry.card?.name || entry.card_id}</button>
            <button type="button" className="rounded-md p-1.5 text-text-muted hover:bg-bg-elevated hover:text-text-primary" onClick={() => onQuantityChange(entry, 1)} aria-busy={pendingEntryIds?.has(entry.id)} aria-label={label('decks.increaseQuantity', { name: entry.card?.name || entry.card_id })}><Plus size={14} /></button>
            <button type="button" className="rounded-md p-1.5 text-text-muted hover:bg-brand-red/15 hover:text-brand-red disabled:opacity-40" disabled={isRemoving || pendingEntryIds?.has(entry.id)} onClick={() => onRemove(entry)} aria-label={label('decks.removeCard', { name: entry.card?.name || entry.card_id })}><Trash2 size={14} /></button>
          </div>
        </article>
      ))}
    </div>
  )
}
