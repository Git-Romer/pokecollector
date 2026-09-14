import { useEffect, useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronUp, RotateCcw } from 'lucide-react'
import { searchCards } from '../../api/client'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { resolveCardImageUrl } from '../../utils/imageUrl'
import { cardNumberMatches } from '../../utils/cardNumbers'
import { normalizeSearchText, textIncludes } from '../../utils/textSearch'
import { printingDetailNames } from '../../utils/printingDetails'
import {
  binderPickerItemsWithQuantities,
  binderPickerQuantitiesAreValid,
  binderPickerQuantityMaximum,
  clampBinderPickerQuantity,
} from '../../utils/binderQuantity'
import {
  aggregateCollectionItems,
  cardListPickerOptions,
  filterCollectionCards,
} from '../../utils/cardListPicker'
import { CardDisplay, withCollectionItemState } from '../card-system'
import CardSelectionQuantityModal from '../card-system/CardSelectionQuantityModal'
import { CollectionCardDisplay } from '../CollectionCardImage'

const PAGE_SIZE = 24
const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']

function filterExactCollectionItems(items, filters) {
  const query = normalizeSearchText(filters.search)
  return items.filter(item => {
    const card = item.card
    if (!card) return false
    if (filters.type && normalizeSearchText(card.supertype) !== normalizeSearchText(filters.type)) return false
    if (filters.set && (card.set_ref?.id || card.set_id) !== filters.set) return false
    if (filters.language && (card.lang || item.lang || '') !== filters.language) return false
    if (filters.variant && (item.variant || '') !== filters.variant) return false
    if (filters.condition && item.condition !== filters.condition) return false
    if (!query) return true

    const shortcode = /^([A-Za-z]+\d*)\s+(\d+)$/.exec(query)
    const shortcodeMatches = shortcode && [card.set_ref?.abbreviation, card.set_id, card.set_ref?.tcg_set_id]
      .some(value => normalizeSearchText(value) === shortcode[1])
      && cardNumberMatches(card.number, String(parseInt(shortcode[2], 10)))

    return textIncludes(card.name, query)
      || textIncludes(card.set_ref?.name || card.set_name, query)
      || printingDetailNames(item.printing_details).some(name => textIncludes(name, query))
      || cardNumberMatches(card.number, query)
      || shortcodeMatches
  })
}

function pickerItem(item, selectionMode, maxQuantityById) {
  const card = item.card || item
  const id = selectionMode === 'collection-item' ? item.id : card.id
  const maxQuantity = selectionMode === 'collection-item'
    ? maxQuantityById?.[item.id] ?? item.maxQuantity ?? 0
    : item.maxQuantity

  return {
    id,
    card,
    sourceItem: item,
    name: card.name,
    subtitle: selectionMode === 'collection-item'
      ? [
          card.set_ref?.name || card.set_name,
          card.number,
          item.variant || 'Normal',
          item.condition,
          ...printingDetailNames(item.printing_details),
        ].filter(Boolean).join(' · ')
      : [card.set_ref?.name || card.set_name, card.number].filter(Boolean).join(' · '),
    image: resolveCardImageUrl(card),
    ...(maxQuantity === undefined ? {} : { maxQuantity }),
  }
}

export default function CardListPicker({
  open,
  title,
  collection = [],
  existingCardIds = [],
  unavailableCollectionItemIds = [],
  maxQuantityById = {},
  selectionMode = 'card',
  allowCatalog = false,
  limitOwnedQuantity = false,
  maximumQuantityField,
  unavailableReason,
  onSubmit,
  isSubmitting = false,
  onOpenChange,
  sectionId,
  t,
  label,
}) {
  const generatedId = useId()
  const contentId = sectionId || `card-list-picker-${generatedId.replace(/:/g, '')}`
  const [source, setSource] = useState('owned')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [set, setSet] = useState('')
  const [language, setLanguage] = useState('')
  const [variant, setVariant] = useState('')
  const [condition, setCondition] = useState('')
  const [selectedItems, setSelectedItems] = useState({})
  const [quantityItems, setQuantityItems] = useState([])
  const [quantities, setQuantities] = useState({})
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [submitting, setSubmitting] = useState(false)

  const exactCopyMode = selectionMode === 'collection-item'
  const aggregatedCollection = useMemo(
    () => aggregateCollectionItems(collection, maximumQuantityField),
    [collection, maximumQuantityField],
  )
  const ownedItems = exactCopyMode ? collection : aggregatedCollection
  const options = useMemo(() => cardListPickerOptions(ownedItems), [ownedItems])
  const variants = useMemo(() => [...new Set(collection.map(item => item.variant).filter(Boolean))].sort(), [collection])
  const existingIds = useMemo(() => new Set([...existingCardIds].map(String)), [existingCardIds])
  const unavailableIds = useMemo(() => new Set([...unavailableCollectionItemIds].map(String)), [unavailableCollectionItemIds])
  const selectedIds = useMemo(() => new Set(Object.keys(selectedItems)), [selectedItems])
  const debouncedSearch = useDebouncedValue(search.trim(), 300)

  const { data: catalogData, isFetching: catalogLoading } = useQuery({
    queryKey: ['card-list-picker-catalog', debouncedSearch, visibleCount],
    queryFn: () => searchCards({ name: debouncedSearch, lang: 'all', page: 1, page_size: visibleCount }).then(response => response.data),
    enabled: open && allowCatalog && source === 'catalog' && debouncedSearch.length >= 2,
  })

  const filteredOwnedItems = useMemo(() => {
    const filters = { search, type, set, language, variant, condition }
    return exactCopyMode
      ? filterExactCollectionItems(ownedItems, filters)
      : filterCollectionCards(ownedItems, filters)
  }, [condition, exactCopyMode, language, ownedItems, search, set, type, variant])

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [source, search, type, set, language, variant, condition])

  const displayedOwnedItems = filteredOwnedItems.slice(0, visibleCount)
  const catalogCards = catalogData?.data || []
  const totalCatalogCards = Number(catalogData?.total_count) || catalogCards.length
  const hasMore = source === 'catalog'
    ? catalogCards.length < totalCatalogCards
    : displayedOwnedItems.length < filteredOwnedItems.length
  const hasFilters = Boolean(search || type || set || language || variant || condition)

  const clearSelection = () => setSelectedItems({})
  const resetFilters = () => {
    setSearch('')
    setType('')
    setSet('')
    setLanguage('')
    setVariant('')
    setCondition('')
    clearSelection()
  }
  const switchSource = nextSource => {
    setSource(nextSource)
    resetFilters()
  }
  const toggleSelection = item => {
    const normalized = pickerItem(item, selectionMode, maxQuantityById)
    const id = String(normalized.id)
    const alreadyAdded = !exactCopyMode && existingIds.has(String(normalized.card.id))
    const unavailable = unavailableIds.has(id) || binderPickerQuantityMaximum(normalized) < 1
    if (alreadyAdded || (unavailable && !selectedIds.has(id))) return

    setSelectedItems(current => {
      const next = { ...current }
      if (next[id]) delete next[id]
      else next[id] = normalized
      return next
    })
  }
  const prepareQuantities = () => {
    const items = Object.values(selectedItems).map(item => {
      if (limitOwnedQuantity && item.maxQuantity === undefined) {
        return { ...item, maxQuantity: item.sourceItem.quantity }
      }
      return item
    }).filter(item => binderPickerQuantityMaximum(item) > 0)
    if (!items.length) return
    setQuantities(Object.fromEntries(items.map(item => [item.id, clampBinderPickerQuantity(quantities[item.id] ?? '1', item)])))
    setQuantityItems(items)
  }
  const submitQuantities = async () => {
    const items = binderPickerItemsWithQuantities(quantityItems, quantities)
    if (!binderPickerQuantitiesAreValid(items)) return
    setSubmitting(true)
    try {
      const result = await onSubmit(items)
      const succeeded = new Set((result?.succeededIds || items.map(item => item.id)).map(String))
      setSelectedItems(current => Object.fromEntries(Object.entries(current).filter(([id]) => !succeeded.has(id))))
      setQuantityItems([])
      setQuantities(current => Object.fromEntries(Object.entries(current).filter(([id]) => !succeeded.has(id))))
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  const renderOwnedCard = (item, index) => {
    const normalized = pickerItem(item, selectionMode, maxQuantityById)
    const id = String(normalized.id)
    const card = normalized.card
    const selected = selectedIds.has(id)
    const alreadyAdded = !exactCopyMode && existingIds.has(String(card.id))
    const unavailable = unavailableIds.has(id) || binderPickerQuantityMaximum(normalized) < 1
    const unavailableMessage = alreadyAdded
      ? t('binderTypes.alreadyUsed')
      : unavailable
        ? unavailableReason || t('binderTypes.alreadyUsed')
        : ''
    const cardState = withCollectionItemState(card, item)

    return (
      <CollectionCardDisplay
        key={exactCopyMode ? `${card.id}-${item.id}` : card.id}
        item={item}
        card={exactCopyMode ? card : cardState}
        image={resolveCardImageUrl(card)}
        compact={exactCopyMode}
        selected={selected}
        loading={index < PAGE_SIZE ? 'eager' : 'lazy'}
        variantEffectSource={exactCopyMode ? item.variant : item}
        stateIndicatorProps={{ card: cardState, alwaysShowQuantity: true, showWishlist: false }}
        unavailableReason={unavailableMessage}
        actionLabel={label?.('cardListPicker.selectCardAction', { name: card.name })}
        onClick={() => toggleSelection(item)}
        overlay={exactCopyMode ? (
          <div className="absolute bottom-2 left-2 right-2 z-20 truncate rounded-full bg-black/80 px-2 py-1 text-center text-[9px] text-white">
            {[item.variant || 'Normal', item.condition, ...printingDetailNames(item.printing_details)].filter(Boolean).join(' · ')}
          </div>
        ) : undefined}
      />
    )
  }

  return (
    <>
      <section className="card border-brand-red/20 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-text-primary">{title}</h2>
          <div className="flex items-center gap-2">
            {hasFilters && <button type="button" className="btn-ghost px-2 text-xs" onClick={resetFilters}><RotateCcw size={13} /> {t('cardListPicker.clearFilters')}</button>}
            <button type="button" className="btn-primary-sm hidden sm:inline-flex" disabled={selectedIds.size === 0 || isSubmitting || submitting} onClick={prepareQuantities}>{t('common.add')} {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}</button>
            {onOpenChange && <button type="button" className="btn-ghost px-2 text-xs" onClick={() => onOpenChange(false)} aria-expanded="true" aria-controls={contentId}><ChevronUp size={14} /> {t('cardListPicker.collapse')}</button>}
          </div>
        </div>

        <div id={contentId} className="space-y-3">
          {allowCatalog && <div className="grid grid-cols-2 gap-2" role="tablist">
            <button type="button" role="tab" aria-selected={source === 'owned'} className={source === 'owned' ? 'btn-primary justify-center' : 'btn-secondary justify-center'} onClick={() => switchSource('owned')}>{t('cardListPicker.ownedCards')}</button>
            <button type="button" role="tab" aria-selected={source === 'catalog'} className={source === 'catalog' ? 'btn-primary justify-center' : 'btn-secondary justify-center'} onClick={() => switchSource('catalog')}>{t('cardListPicker.allCards')}</button>
          </div>}

          <input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder={source === 'catalog' ? t('cardListPicker.searchAllCards') : t('cardListPicker.searchOwned')} autoFocus />

          {source === 'owned' && <div className={`grid grid-cols-2 gap-2 ${exactCopyMode ? 'sm:grid-cols-3 lg:grid-cols-5' : 'sm:grid-cols-3'}`}>
            <select className="select min-w-0 py-1.5 text-xs" value={type} onChange={event => setType(event.target.value)} aria-label={t('cardListPicker.filterType')}><option value="">{t('cardListPicker.allTypes')}</option><option value="Pokemon">{t('decks.Pokemon')}</option><option value="Trainer">{t('decks.Trainer')}</option><option value="Energy">{t('decks.Energy')}</option></select>
            <select className="select min-w-0 py-1.5 text-xs" value={set} onChange={event => setSet(event.target.value)} aria-label={t('cardListPicker.filterSet')}><option value="">{t('cardListPicker.allSets')}</option>{options.sets.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select>
            <select className="select min-w-0 py-1.5 text-xs" value={language} onChange={event => setLanguage(event.target.value)} aria-label={t('cardListPicker.filterLanguage')}><option value="">{t('cardListPicker.allLanguages')}</option>{options.languages.map(option => <option key={option} value={option}>{option}</option>)}</select>
            {exactCopyMode && <select className="select min-w-0 py-1.5 text-xs" value={variant} onChange={event => setVariant(event.target.value)} aria-label={t('variants.allVariants')}><option value="">{t('variants.allVariants')}</option>{variants.map(option => <option key={option} value={option}>{option}</option>)}</select>}
            {exactCopyMode && <select className="select min-w-0 py-1.5 text-xs" value={condition} onChange={event => setCondition(event.target.value)} aria-label={t('common.allConditions')}><option value="">{t('common.allConditions')}</option>{CONDITIONS.map(option => <option key={option} value={option}>{option}</option>)}</select>}
          </div>}

          <div className="max-h-[38rem] overflow-y-auto pr-1">
            <div className="grid grid-cols-3 items-start gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8" data-testid="card-list-picker-grid">
              {source === 'owned' && displayedOwnedItems.map(renderOwnedCard)}
              {source === 'catalog' && catalogCards.map(card => {
                const selected = selectedIds.has(String(card.id))
                const alreadyAdded = existingIds.has(String(card.id))
                return <CardDisplay key={card.id} card={card} image={resolveCardImageUrl(card)} selected={selected} unavailableReason={alreadyAdded ? t('binderTypes.alreadyUsed') : ''} actionLabel={label?.('cardListPicker.selectCardAction', { name: card.name })} onClick={() => toggleSelection(card)} />
              })}
              {catalogLoading && <p className="col-span-full py-8 text-center text-xs text-text-muted">{t('common.loading')}</p>}
              {!catalogLoading && source === 'catalog' && debouncedSearch.length < 2 && <p className="col-span-full py-8 text-center text-xs text-text-muted">{t('cardListPicker.searchAllHint')}</p>}
              {!catalogLoading && source === 'catalog' && debouncedSearch.length >= 2 && catalogCards.length === 0 && <p className="col-span-full py-8 text-center text-xs text-text-muted">{t('cardListPicker.noCatalogCards')}</p>}
              {source === 'owned' && filteredOwnedItems.length === 0 && <p className="col-span-full py-8 text-center text-xs text-text-muted">{t('cardListPicker.noOwnedCards')}</p>}
            </div>
            {hasMore && <div className="flex justify-center py-4"><button type="button" className="btn-secondary" onClick={() => setVisibleCount(current => current + PAGE_SIZE)}>{t('common.more')}</button></div>}
          </div>

          <div className="sticky bottom-2 z-30 flex items-center gap-3 rounded-xl border border-white/15 bg-bg-surface/95 p-3 shadow-2xl backdrop-blur sm:hidden">
            <span className="min-w-0 flex-1 text-sm font-semibold text-text-primary">{selectedIds.size} {t('cardSearch.selected')}</span>
            <button type="button" className="btn-primary-sm justify-center" disabled={selectedIds.size === 0 || isSubmitting || submitting} onClick={prepareQuantities}>{t('common.add')} {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}</button>
          </div>
        </div>
      </section>

      <CardSelectionQuantityModal
        t={t}
        items={quantityItems}
        quantities={quantities}
        onQuantityChange={(id, value) => setQuantities(current => ({ ...current, [id]: value }))}
        onClose={() => setQuantityItems([])}
        onSubmit={submitQuantities}
        isSubmitting={isSubmitting || submitting}
      />
    </>
  )
}
