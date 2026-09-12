import { useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import Modal from '../ui/Modal'
import { CollectionCardDisplay } from '../CollectionCardImage'

export default function DeckCardViewer({ entries, activeIndex, onClose, onPrevious, onNext, t, label }) {
  const entry = activeIndex === null ? null : entries[activeIndex]

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

  return (
    <Modal isOpen={Boolean(entry)} onClose={onClose} title={entry?.card?.name || ''} size="xl" mobileSheet={false} className="max-h-[95dvh]">
      {entry && <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_16rem] sm:p-6">
        <div className="relative mx-auto w-full max-w-md">
          <CollectionCardDisplay variant="artwork" item={{ card: entry.card }} card={entry.card} variantEffectSource={entry.display_variant || entry.card} alt={entry.card?.name || entry.card_id} size="large" className="w-full rounded-xl shadow-2xl" />
          <button type="button" onClick={onPrevious} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/75 p-3 text-white hover:bg-black" aria-label={t('decks.previousCard')}><ChevronLeft size={24} /></button>
          <button type="button" onClick={onNext} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/75 p-3 text-white hover:bg-black" aria-label={t('decks.nextCard')}><ChevronRight size={24} /></button>
        </div>
        <div className="space-y-3 text-sm">
          <div><p className="text-xs uppercase tracking-wider text-text-muted">{t('decks.set')}</p><p className="font-medium text-text-primary">{entry.card?.set_ref?.name || entry.card?.set_id || '-'}</p><p className="text-text-secondary">{entry.card?.number || '-'}</p></div>
          <div className="grid grid-cols-2 gap-2 border-t border-border pt-3"><p>Required: {entry.required_quantity}</p><p>Owned: {entry.owned_quantity}</p><p>Reserved here: {entry.reserved_in_this_deck || 0}</p><p>Reserved elsewhere: {entry.reserved_elsewhere || 0}</p><p>Available: {entry.available_quantity ?? entry.owned_quantity}</p><p>Missing: {entry.shortage || 0}</p></div>
          {entry.shortage > 0 && <p className="rounded-lg bg-brand-red/10 px-3 py-2 font-medium text-brand-red">{label('decks.shortage', { count: entry.shortage })}</p>}
          <p className="text-xs text-text-muted">{activeIndex + 1} / {entries.length}</p>
        </div>
      </div>}
    </Modal>
  )
}
