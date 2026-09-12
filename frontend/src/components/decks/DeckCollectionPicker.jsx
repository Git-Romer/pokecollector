import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, RotateCcw } from 'lucide-react'
import Modal from '../ui/Modal'
import { CollectionCardDisplay } from '../CollectionCardImage'
import { aggregateDeckCollectionItems, deckPickerOptions, filterDeckCollectionCards } from '../../utils/deckCollectionPicker'
import DeckCollectionPreview from './DeckCollectionPreview'

export default function DeckCollectionPicker({ collection, entries, onAdd, optimisticAddQuantities, pendingCardIds, t, label }) {
  const storageKey = 'pokecollector.deckEditor.ownedCardsCollapsed'
  // Older saved values use true for collapsed and false for expanded. Missing is now collapsed.
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem(storageKey) !== 'false')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [set, setSet] = useState('')
  const [language, setLanguage] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches)
  const ownedCards = useMemo(() => aggregateDeckCollectionItems(collection), [collection])
  const options = useMemo(() => deckPickerOptions(ownedCards), [ownedCards])
  const filteredCards = useMemo(() => filterDeckCollectionCards(ownedCards, { search, type, set, language }), [ownedCards, search, type, set, language])
  const selected = filteredCards.find(item => item.card.id === selectedId) || ownedCards.find(item => item.card.id === selectedId) || null
  const quantitiesByCard = useMemo(() => Object.fromEntries(entries.map(entry => [entry.card_id || entry.card?.id, entry.required_quantity])), [entries])
  const hasFilters = Boolean(search || type || set || language)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia('(min-width: 1024px)')
    const update = event => setIsDesktop(event.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (isDesktop && filteredCards[0] && !filteredCards.some(item => item.card.id === selectedId)) setSelectedId(filteredCards[0].card.id)
  }, [filteredCards, isDesktop, selectedId])

  const reset = () => { setSearch(''); setType(''); setSet(''); setLanguage('') }
  const toggleCollapsed = () => setCollapsed(value => {
    const next = !value
    window.localStorage.setItem(storageKey, String(next))
    return next
  })
  const allocations = useMemo(() => Object.fromEntries(entries.map(entry => [entry.card_id, entry])), [entries])
  const preview = selected && <DeckCollectionPreview item={selected} deckQuantity={optimisticAddQuantities[selected.card.id] ?? quantitiesByCard[selected.card.id] ?? 0} allocation={allocations[selected.card.id]} onAdd={onAdd} isAdding={pendingCardIds?.has(selected.card.id)} t={t} label={label} compact={!isDesktop} />

  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-text-primary">{t('decks.addCards')}</h2><button type="button" className="btn-ghost px-2 text-xs" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-controls="deck-owned-cards-content" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${t('decks.addCards')}`}>{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}{collapsed ? 'Expand' : 'Collapse'}</button></div>
      <div id="deck-owned-cards-content" className={`space-y-3 overflow-hidden transition-[max-height,opacity] duration-200 ${collapsed ? 'pointer-events-none max-h-0 opacity-0' : 'max-h-[80rem] opacity-100'}`} aria-hidden={collapsed}>
      <div className="flex justify-end">{hasFilters && <button type="button" className="btn-ghost px-2 text-xs" onClick={reset}><RotateCcw size={13} /> {t('decks.clearFilters')}</button>}</div>
      <input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('decks.searchOwned')} />
      <div className="grid grid-cols-3 gap-2">
        <select className="select min-w-0 py-1.5 text-xs" value={type} onChange={event => setType(event.target.value)} aria-label={t('decks.filterType')}><option value="">{t('decks.allTypes')}</option><option value="Pokemon">{t('decks.Pokemon')}</option><option value="Trainer">{t('decks.Trainer')}</option><option value="Energy">{t('decks.Energy')}</option></select>
        <select className="select min-w-0 py-1.5 text-xs" value={set} onChange={event => setSet(event.target.value)} aria-label={t('decks.filterSet')}><option value="">{t('decks.allSets')}</option>{options.sets.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select>
        <select className="select min-w-0 py-1.5 text-xs" value={language} onChange={event => setLanguage(event.target.value)} aria-label={t('decks.filterLanguage')}><option value="">{t('decks.allLanguages')}</option>{options.languages.map(option => <option key={option} value={option}>{option}</option>)}</select>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,18rem)]">
        <div className="grid max-h-[30rem] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
          {filteredCards.map(item => {
            const inDeck = optimisticAddQuantities[item.card.id] ?? quantitiesByCard[item.card.id] ?? 0
            return <article key={item.card.id} className={`relative overflow-hidden rounded-lg border ${selected?.card.id === item.card.id ? 'border-brand-red ring-1 ring-brand-red/50' : 'border-border'} bg-bg-card`}>
              <button type="button" className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red" onClick={() => setSelectedId(item.card.id)} aria-label={label('decks.previewCard', { name: item.card.name })}><CollectionCardDisplay variant="artwork" item={item} card={item.card} alt={item.card.name} /></button>
              <span className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/80 px-1.5 py-0.5 text-[10px] font-bold text-white">{label('decks.owned', { count: item.quantity })}</span>
              <div className="flex items-center gap-1 border-t border-border p-1"><span className="min-w-0 flex-1 truncate text-[10px] text-text-secondary">{inDeck ? label('decks.inDeck', { count: inDeck }) : item.card.name}</span><button type="button" className="rounded p-1 text-brand-red hover:bg-brand-red/10" onClick={() => onAdd(item.card.id)} aria-busy={pendingCardIds?.has(item.card.id)} aria-label={label('decks.addCard', { name: item.card.name })}><Plus size={15} /></button></div>
            </article>
          })}
          {filteredCards.length === 0 && <p className="col-span-full py-8 text-center text-xs text-text-muted">{t('decks.noOwnedCards')}</p>}
        </div>
        <div className="hidden lg:block">{preview}</div>
      </div>
      </div>
      {!collapsed && <Modal isOpen={Boolean(selected) && !isDesktop} onClose={() => setSelectedId(null)} title={selected?.card.name} size="lg">{preview}</Modal>}
    </section>
  )
}
