import CollectionCardImage from '../CollectionCardImage'

export default function DeckCollectionPreview({ item, deckQuantity, allocation, onAdd, isAdding, t, label, compact = false }) {
  if (!item) return <div className="flex min-h-64 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-muted">{t('decks.selectCard')}</div>
  const card = item.card
  return (
    <div className={`space-y-3 ${compact ? 'p-4' : 'sticky top-3 rounded-xl border border-border bg-bg-card p-3'}`}>
      <div className="mx-auto w-full max-w-xs"><CollectionCardImage item={item} alt={card.name} size="large" className="w-full rounded-xl shadow-xl" /></div>
      <div><h3 className="font-semibold text-text-primary">{card.name}</h3><p className="text-xs text-text-secondary">{card.set_ref?.name || card.set_name || card.set_id || '-'} · {card.number || '-'}</p><p className="text-xs text-text-muted">{card.lang || item.lang || '-'}</p></div>
       <div className="grid grid-cols-2 gap-2 text-xs"><p>Owned: {item.quantity}</p><p>Reserved elsewhere: {allocation?.reserved_elsewhere || 0}</p><p>Free: {allocation?.available_quantity ?? item.quantity}</p><p>{label('decks.inDeck', { count: deckQuantity })}</p></div>
      <button type="button" className="btn-primary w-full justify-center" disabled={isAdding} onClick={() => onAdd(item.card.id)}>{t('decks.addToDeck')}</button>
    </div>
  )
}
