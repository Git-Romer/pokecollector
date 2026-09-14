import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus, Trash2 } from 'lucide-react'
import { CardDialog } from '../card-system'
import { CollectionCardDisplay } from '../CollectionCardImage'
import PrintingDetailBadges from '../PrintingDetailBadges'
import { resolveCardImageUrl } from '../../utils/imageUrl'

export default function DeckCardViewer({ entries, activeIndex, onClose, onPrevious, onNext, onQuantityChange, onRemove, pendingEntryIds, isRemoving, t, label, equivalentPrints = [], equivalentPrintsLoading = false, onSwitchPrint, isSwitchingPrint = false, isRealDeck = false }) {
  const entry = activeIndex === null ? null : entries[activeIndex]
  const [activeTab, setActiveTab] = useState('deck')

  useEffect(() => {
    setActiveTab('deck')
  }, [entry?.id])

  useEffect(() => {
    if (!entry) return undefined
    const onKeyDown = event => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onPrevious()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onNext()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [entry, onNext, onPrevious])

  if (!entry) return null

  const stats = [
    [t('decks.required'), entry.required_quantity, 'text-text-primary'],
    [t('decks.ownedLabel'), entry.owned_quantity, 'text-green'],
    ...(isRealDeck ? [[t('decks.inRealDeck'), entry.allocated_quantity || 0, 'text-blue']] : []),
    [t('decks.available'), entry.available_quantity ?? entry.owned_quantity, 'text-text-primary'],
    [t('decks.missingLabel'), entry.shortage || 0, entry.shortage > 0 ? 'text-brand-red' : 'text-text-primary'],
  ]

  return (
    <CardDialog
      card={entry.card}
      image={resolveCardImageUrl(entry.card, 'large')}
      variantEffectSource={entry.display_variant || entry.card}
      imageAccessory={(
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2" role="group" aria-label={t('decks.cards')}>
          <button type="button" onClick={onPrevious} className="btn-ghost justify-center px-3" aria-label={t('decks.previousCard')}><ChevronLeft size={18} /></button>
          <span className="text-center text-xs font-semibold text-text-muted">{activeIndex + 1} / {entries.length}</span>
          <button type="button" onClick={onNext} className="btn-ghost justify-center px-3" aria-label={t('decks.nextCard')}><ChevronRight size={18} /></button>
        </div>
      )}
      tabs={[
        { id: 'deck', label: t('binderTypes.deck') },
        ...(!isRealDeck ? [{ id: 'equivalents', label: t('cardTabs.equivalents') }] : []),
      ]}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
    >
      {activeTab === 'deck' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-bg-card p-3">
            <p className="mb-2 text-xs font-medium text-text-muted">{t('decks.quantity')}</p>
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center rounded-full border border-border bg-bg-surface p-1 shadow-sm">
                <button type="button" className="grid h-9 w-9 place-items-center rounded-full text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-30" disabled={entry.required_quantity <= 1} onClick={() => onQuantityChange?.(entry, -1)} aria-label={label('decks.decreaseQuantity', { name: entry.card?.name || entry.card_id })}><Minus size={16} /></button>
                <span className="min-w-12 text-center text-base font-black text-text-primary" aria-live="polite">{entry.required_quantity}</span>
                <button type="button" className="grid h-9 w-9 place-items-center rounded-full text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary disabled:opacity-30" disabled={entry.required_quantity >= 99} onClick={() => onQuantityChange?.(entry, 1)} aria-label={label('decks.increaseQuantity', { name: entry.card?.name || entry.card_id })}><Plus size={16} /></button>
              </div>
              <button type="button" className="btn-ghost ml-auto px-3 text-brand-red hover:text-brand-red" disabled={isRemoving || pendingEntryIds?.has(entry.id)} onClick={() => onRemove?.(entry)} aria-label={label('decks.removeCard', { name: entry.card?.name || entry.card_id })}><Trash2 size={16} /> <span className="hidden sm:inline">{t('common.delete')}</span></button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {stats.map(([title, value, color]) => (
              <div key={title} className="rounded-xl border border-border bg-bg-card p-3">
                <p className="text-xs text-text-muted">{title}</p>
                <p className={`mt-1 text-lg font-bold ${color}`}>{value}</p>
              </div>
            ))}
          </div>
          {isRealDeck && entry.allocated_prints?.length > 0 && (
            <div className="rounded-xl border border-border bg-bg-card p-3">
              <p className="mb-2 text-xs font-medium text-text-muted">{t('printingDetails.label')}</p>
              <div className="space-y-2">
                {entry.allocated_prints.map(print => (
                  <div key={print.collection_item_id} className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <span className="font-semibold text-text-primary">{print.quantity}×</span>
                    <span>{print.variant}</span>
                    <span>{print.condition}</span>
                    <span>{print.lang}</span>
                    <PrintingDetailBadges details={print.printing_details} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {entry.shortage > 0 && <p className="rounded-xl border border-brand-red/25 bg-brand-red/10 px-3 py-2 text-sm font-medium text-brand-red">{label('decks.shortage', { count: entry.shortage })}</p>}
        </div>
      )}

      {activeTab === 'equivalents' && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">{t('decks.equivalentPrintsHelp')}</p>
          {equivalentPrintsLoading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
          {!equivalentPrintsLoading && equivalentPrints.length === 0 && <p className="text-sm text-text-muted">{t('binderTypes.noEquivalentPrints')}</p>}
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {equivalentPrints.map(print => (
              <div key={print.id} className={`flex items-center gap-3 rounded-xl border p-3 ${print.is_current ? 'border-yellow/40 bg-yellow/5' : 'border-border bg-bg-card'}`}>
                <CollectionCardDisplay variant="compact-artwork" item={{ card: print }} card={print} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{print.set_name || print.set_id} #{print.number}</p>
                  <p className="text-xs text-text-muted">{print.owned_quantity ? `${t('binderTypes.owned')} ${print.owned_quantity}x` : t('decks.notOwned')}</p>
                </div>
                <button type="button" className="btn-ghost flex-shrink-0 px-2 py-1 text-xs" disabled={print.is_current || isSwitchingPrint} onClick={() => onSwitchPrint?.(print.id)}>{print.is_current ? t('binderTypes.currentPrint') : t('binderTypes.switchPrint')}</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </CardDialog>
  )
}
