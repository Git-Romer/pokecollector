import { Fragment, useEffect, useId, useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts'
import { Plus, Trash2, Edit2, TrendingUp, TrendingDown, Package, Check, X, SortAsc, Filter, ChevronUp, ChevronDown, Link2, DollarSign, History, AlertCircle, Search, ExternalLink } from 'lucide-react'
import { getProducts, createProductBatch, updateProduct, bulkUpdateProductLifecycle, deleteProduct, getProductsSummary, getCollection, linkProductCards, unlinkProductCard, sellProductCard, addProductLedgerEntry, getApiErrorMessage } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { CardRow } from '../components/card-system'
import MoneyInput from '../components/MoneyInput'
import PeriodSelector, { PRODUCT_PERIODS, getPeriodCutoff } from '../components/PeriodSelector'
import AnalyticsSectionNav from '../components/AnalyticsSectionNav'
import Modal from '../components/ui/Modal'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { formatMoneyInputValue, isValidMoneyInputValue, parseMoneyInputValue } from '../utils/moneyInput'
import { productImageUrl, resolveCardImageUrl } from '../utils/imageUrl'
import {
  PRODUCT_CARD_SELECTION_LIMIT,
  PRODUCT_CARD_TIME_RANGES,
  filterProductCardCandidates,
  parseCollectionAddedAt,
  selectVisibleProductCardCandidates,
} from '../utils/productCardPicker'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { buildProductDisplayRows, summarizeProductBatch } from '../utils/productBatches'

const PRODUCT_TYPES = ['Booster Pack', 'Booster Box', 'Elite Trainer Box', 'Tin', 'Bundle', 'Collection Box', 'Blister', 'Other']

function ProductForm({ initial = {}, onSubmit, onCancel, loading }) {
  const { t, formatPrice, exchangeRate, exchangeRateReady } = useSettings()
  const today = new Date().toISOString().split('T')[0]
  const isCreating = !initial.id
  const formId = useId()
  const fieldId = (name) => `${formId}-${name}`
  const [form, setForm] = useState({
    product_name: initial.product_name || '',
    product_type: initial.product_type || 'Booster Pack',
    purchase_price: formatMoneyInputValue(initial.purchase_price, exchangeRate),
    current_value: formatMoneyInputValue(initial.current_value, exchangeRate),
    sold_price: formatMoneyInputValue(initial.sold_price, exchangeRate),
    purchase_date: initial.purchase_date || today,
    sold_date: initial.sold_date || '',
    lifecycle_status: ['sealed', 'opened'].includes(initial.lifecycle_status)
      ? initial.lifecycle_status
      : initial.lifecycle_status ? '' : 'sealed',
    quantity: initial.quantity || 1,
    image_url: initial.image_url || '',
    cardmarket_url: initial.cardmarket_url || '',
    notes: initial.notes || '',
  })
  const [moneyTouched, setMoneyTouched] = useState(false)

  useEffect(() => {
    if (moneyTouched) return
    setForm(prev => ({
      ...prev,
      purchase_price: formatMoneyInputValue(initial.purchase_price, exchangeRate),
      current_value: formatMoneyInputValue(initial.current_value, exchangeRate),
      sold_price: formatMoneyInputValue(initial.sold_price, exchangeRate),
    }))
  }, [initial.purchase_price, initial.current_value, initial.sold_price, exchangeRate, moneyTouched])

  const set = (key, val) => setForm(p => ({ ...p, [key]: val }))
  const setMoney = (key, val) => {
    setMoneyTouched(true)
    set(key, val)
  }
  const purchasePriceValid = isValidMoneyInputValue(form.purchase_price)
  const currentValueValid = form.current_value === '' || isValidMoneyInputValue(form.current_value)
  const soldPriceValid = form.sold_price === '' || isValidMoneyInputValue(form.sold_price)
  const quantity = Number(form.quantity)
  const quantityValid = Number.isInteger(quantity) && quantity >= 1 && quantity <= 200
  const hasSale = form.sold_price !== ''
  const saleDateWithoutPrice = form.sold_date !== '' && !hasSale
  const saleConflictsWithOpened = hasSale && form.lifecycle_status === 'opened'
  const canSubmit = form.product_name.trim()
    && form.purchase_price !== ''
    && purchasePriceValid
    && currentValueValid
    && soldPriceValid
    && (!isCreating || quantityValid)
    && !saleDateWithoutPrice
    && !saleConflictsWithOpened
    && (hasSale || form.lifecycle_status)
    && exchangeRateReady
  const batchPurchaseTotal = isCreating && quantity > 1 && purchasePriceValid && form.purchase_price !== ''
    ? parseMoneyInputValue(form.purchase_price, exchangeRate) * quantity
    : null

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label htmlFor={fieldId('name')} className="text-xs text-text-muted mb-1 block">{t('products.productName')}</label>
        <input id={fieldId('name')} type="text" placeholder={t('products.productNamePlaceholder')}
          value={form.product_name} onChange={(e) => set('product_name', e.target.value)} className="input" />
      </div>
      <div>
        <label htmlFor={fieldId('type')} className="text-xs text-text-muted mb-1 block">{t('products.productType')}</label>
        <select id={fieldId('type')} className="select" value={form.product_type} onChange={(e) => set('product_type', e.target.value)}>
          {PRODUCT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
      </div>
      {isCreating && (
        <div>
          <label htmlFor={fieldId('quantity')} className="text-xs text-text-muted mb-1 block">{t('products.quantity')}</label>
          <input
            id={fieldId('quantity')}
            type="number"
            min="1"
            max="200"
            step="1"
            value={form.quantity}
            onChange={(e) => set('quantity', e.target.value)}
            className="input"
          />
          <p className="mt-1 text-xs text-text-muted">{t('products.quantityHelp')}</p>
          {!quantityValid && (
            <p className="mt-1 text-xs text-brand-red">{t('products.quantityInvalid')}</p>
          )}
        </div>
      )}
      <div className={isCreating ? 'col-span-2' : ''}>
        <label htmlFor={fieldId('purchase-date')} className="text-xs text-text-muted mb-1 block">{t('products.purchaseDate')}</label>
        <input id={fieldId('purchase-date')} type="date" value={form.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} className="input" />
      </div>
      <div className="col-span-2">
        <label htmlFor={fieldId('status')} className="text-xs text-text-muted mb-1 block">{t('products.lifecycleStatus')}</label>
        {hasSale && !saleConflictsWithOpened ? (
          <div id={fieldId('status')} className="input flex items-center text-text-secondary">{t('products.statusSold')}</div>
        ) : (
          <select id={fieldId('status')} className="select" value={form.lifecycle_status} onChange={(e) => set('lifecycle_status', e.target.value)}>
            {!form.lifecycle_status && <option value="">{t('products.chooseStatus')}</option>}
            <option value="sealed">{t('products.statusSealed')}</option>
            <option value="opened">{t('products.statusOpened')}</option>
          </select>
        )}
        <p className="mt-1 text-xs text-text-muted">{t('products.lifecycleHelp')}</p>
      </div>
      <div>
        <label htmlFor={fieldId('purchase-price')} className="text-xs text-text-muted mb-1 block">{t('products.purchasePricePerItem')}</label>
        <MoneyInput id={fieldId('purchase-price')} value={form.purchase_price} onChange={(e) => setMoney('purchase_price', e.target.value)} />
      </div>
      <div>
        <label htmlFor={fieldId('current-value')} className="text-xs text-text-muted mb-1 block">{t('products.currentValuePerItem')}</label>
        <MoneyInput id={fieldId('current-value')} value={form.current_value} onChange={(e) => setMoney('current_value', e.target.value)} />
      </div>
      <div>
        <label htmlFor={fieldId('sold-price')} className="text-xs text-text-muted mb-1 block">{t('products.soldPricePerItem')}</label>
        <MoneyInput id={fieldId('sold-price')} placeholder={t('products.soldPriceHint')} value={form.sold_price} onChange={(e) => setMoney('sold_price', e.target.value)} />
      </div>
      <div>
        <label htmlFor={fieldId('sold-date')} className="text-xs text-text-muted mb-1 block">{t('products.soldDate')}</label>
        <input id={fieldId('sold-date')} type="date" value={form.sold_date} onChange={(e) => set('sold_date', e.target.value)} className="input" />
      </div>
      {saleDateWithoutPrice && (
        <p className="col-span-2 text-xs text-brand-red">{t('products.salePriceRequired')}</p>
      )}
      {saleConflictsWithOpened && (
        <p className="col-span-2 text-xs text-brand-red">{t('products.openedSaleConflict')}</p>
      )}
      {batchPurchaseTotal != null && (
        <div className="col-span-2 rounded-lg border border-border bg-bg-elevated/50 px-3 py-2 text-sm text-text-secondary">
          {t('products.batchTotal').replace('{total}', formatPrice(batchPurchaseTotal))}
        </div>
      )}
      <div className="col-span-2">
        <label htmlFor={fieldId('image-url')} className="text-xs text-text-muted mb-1 block">{t('products.imageUrl')}</label>
        <input
          id={fieldId('image-url')}
          type="url"
          maxLength={2048}
          placeholder="https://example.com/product.webp"
          value={form.image_url}
          onChange={(e) => set('image_url', e.target.value)}
          className="input"
        />
        <p className="mt-1 text-xs text-text-muted">{t('products.imageUrlHelp')}</p>
      </div>
      <div className="col-span-2">
        <label htmlFor={fieldId('cardmarket-url')} className="text-xs text-text-muted mb-1 block">{t('products.cardmarketUrl')}</label>
        <input
          id={fieldId('cardmarket-url')}
          type="url"
          maxLength={2048}
          placeholder="https://www.cardmarket.com/en/Pokemon/Products/..."
          value={form.cardmarket_url}
          onChange={(e) => set('cardmarket_url', e.target.value)}
          className="input"
        />
        <p className="mt-1 text-xs text-text-muted">{t('products.cardmarketUrlHelp')}</p>
      </div>
      <div className="col-span-2">
        <label htmlFor={fieldId('notes')} className="text-xs text-text-muted mb-1 block">{t('products.notes')}</label>
        <input id={fieldId('notes')} type="text" placeholder={t('products.notesHint')} value={form.notes}
          onChange={(e) => set('notes', e.target.value)} className="input" />
      </div>
      <div className="col-span-2 sticky bottom-0 z-10 -mx-4 flex gap-2 border-t border-border bg-bg-surface px-4 pb-2 pt-3 sm:-mx-5 sm:px-5 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0">
        <button type="button" onClick={() => {
          const payload = {
            ...form,
            purchase_price: parseMoneyInputValue(form.purchase_price, exchangeRate),
            current_value: parseMoneyInputValue(form.current_value, exchangeRate, null),
            sold_price: parseMoneyInputValue(form.sold_price, exchangeRate, null),
            sold_date: form.sold_date || null,
          }
          if (isCreating) payload.quantity = quantity
          else delete payload.quantity
          if (hasSale && !form.lifecycle_status) delete payload.lifecycle_status
          onSubmit(payload)
        }} disabled={!canSubmit || loading || !exchangeRateReady} className="btn-primary flex-1">
          <Check size={14} /> {loading ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" onClick={onCancel} disabled={loading} className="btn-ghost">
          <X size={14} /> {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

const getProductValue = (product) => {
  if (product?.computed_current_value != null) return product.computed_current_value
  if (product?.sold_price != null) return product.sold_price
  if (product?.current_value != null) return product.current_value
  return product?.purchase_price ?? 0
}

const getProductLifecycleStatus = (product) => {
  if (product?.lifecycle_status) return product.lifecycle_status
  if (product?.sold_price != null || product?.sold_date) return 'sold'
  if ((product?.product_cards?.length || 0) > 0 || (product?.ledger_entries?.length || 0) > 0) return 'opened'
  return 'sealed'
}

const getProductLifecycleLabel = (product, t) => ({
  sealed: t('products.statusSealed'),
  opened: t('products.statusOpened'),
  sold: t('products.statusSold'),
  review: t('products.statusReview'),
})[getProductLifecycleStatus(product)]

function linkedActiveQuantityByCollectionItem(products) {
  const totals = new Map()
  products.forEach(product => {
    ;(product.product_cards || []).forEach(entry => {
      if (!entry.collection_item_id) return
      totals.set(entry.collection_item_id, (totals.get(entry.collection_item_id) || 0) + (entry.active_quantity || 0))
    })
  })
  return totals
}

function ProductCardPicker({ isOpen, onClose, product, candidates, formatPrice, t, onLink, loading }) {
  const [search, setSearch] = useState('')
  const [timeRange, setTimeRange] = useState('all')
  const [selections, setSelections] = useState({})
  const [selectionNotice, setSelectionNotice] = useState('')
  const filteredCandidates = useMemo(
    () => filterProductCardCandidates(candidates, { search, timeRange }),
    [candidates, search, timeRange],
  )
  const selectedCount = Object.keys(selections).length
  const visibleUnselectedCount = filteredCandidates.filter(({ item }) => selections[item.id] == null).length
  const displayedSelectionNotice = selectionNotice || (
    selectedCount >= PRODUCT_CARD_SELECTION_LIMIT
      ? t('products.selectionMaximum').replace('{limit}', PRODUCT_CARD_SELECTION_LIMIT)
      : ''
  )

  useEffect(() => {
    if (isOpen) return
    setSearch('')
    setTimeRange('all')
    setSelections({})
    setSelectionNotice('')
  }, [isOpen])

  const toggleSelection = (itemId, available) => {
    setSelectionNotice('')
    setSelections(current => {
      if (current[itemId]) {
        const next = { ...current }
        delete next[itemId]
        return next
      }
      if (Object.keys(current).length >= PRODUCT_CARD_SELECTION_LIMIT) return current
      return { ...current, [itemId]: Math.min(1, available) }
    })
  }

  const selectAllVisible = () => {
    const remainingSlots = Math.max(PRODUCT_CARD_SELECTION_LIMIT - selectedCount, 0)
    const newlySelected = Math.min(visibleUnselectedCount, remainingSlots)
    const skipped = Math.max(visibleUnselectedCount - newlySelected, 0)
    setSelections(current => selectVisibleProductCardCandidates(current, filteredCandidates))
    setSelectionNotice(
      skipped > 0
        ? t('products.selectVisibleLimit')
          .replace('{selected}', newlySelected)
          .replace('{skipped}', skipped)
          .replace('{limit}', PRODUCT_CARD_SELECTION_LIMIT)
        : t('products.selectVisibleResult').replace('{count}', newlySelected),
    )
  }

  const clearSelections = () => {
    setSelections({})
    setSelectionNotice('')
  }

  const setQuantity = (itemId, value, available) => {
    const quantity = Number(value)
    setSelections(current => ({
      ...current,
      [itemId]: Number.isInteger(quantity) ? Math.max(1, Math.min(quantity, available)) : 1,
    }))
  }

  const submit = async () => {
    const items = Object.entries(selections).map(([collectionItemId, quantity]) => ({
      collection_item_id: Number(collectionItemId),
      quantity,
    }))
    if (!items.length) return
    await onLink(product.id, items)
    onClose()
  }

  const timeRangeLabel = {
    hour: t('products.addedLastHour'),
    day: t('products.addedLastDay'),
    week: t('products.addedLastWeek'),
    month: t('products.addedLastMonth'),
    all: t('products.allCards'),
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('products.selectCardsTitle').replace('{product}', product.product_name)}
      size="xl"
    >
      <div className="p-4 sm:p-5 space-y-4">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            type="search"
            className="input pl-9"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setSelectionNotice('')
            }}
            placeholder={t('products.searchCollectionCards')}
            autoFocus
          />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1" aria-label={t('products.filterByAddedTime')}>
          {PRODUCT_CARD_TIME_RANGES.map(option => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                setTimeRange(option.id)
                setSelectionNotice('')
              }}
              className={clsx(
                'flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                timeRange === option.id
                  ? 'border-brand-red bg-brand-red/10 text-brand-red'
                  : 'border-border bg-bg-elevated text-text-secondary hover:text-text-primary',
              )}
              aria-pressed={timeRange === option.id}
            >
              {timeRangeLabel[option.id]}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-text-muted">
            {t('products.visibleCards').replace('{count}', filteredCandidates.length)}
          </p>
          <button
            type="button"
            className="btn-ghost px-3 py-1.5 text-xs"
            onClick={selectAllVisible}
            disabled={!visibleUnselectedCount || selectedCount >= PRODUCT_CARD_SELECTION_LIMIT || loading}
          >
            {t('products.selectAllVisible')}
          </button>
        </div>

        {displayedSelectionNotice && (
          <p className="text-xs text-text-secondary" role="status" aria-live="polite">
            {displayedSelectionNotice}
          </p>
        )}

        <div className="max-h-[48vh] divide-y divide-border overflow-y-auto rounded-xl border border-border bg-bg-elevated/30">
          {filteredCandidates.length ? filteredCandidates.map(({ item, available }) => {
            const card = item.card || {}
            const selected = selections[item.id] != null
            const addedAtTimestamp = parseCollectionAddedAt(item.added_at)
            const addedAt = Number.isFinite(addedAtTimestamp) ? new Date(addedAtTimestamp).toLocaleString() : null
            return (
              <div key={item.id} className={clsx('flex items-center gap-3 p-3', selected && 'bg-brand-red/5')}>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleSelection(item.id, available)}
                  className="h-5 w-5 flex-shrink-0 accent-brand-red"
                  aria-label={t('products.selectCard').replace('{card}', card.name || item.card_id)}
                />
                <img
                  src={resolveCardImageUrl(card)}
                  alt=""
                  className="h-14 w-10 flex-shrink-0 rounded object-cover bg-bg-card"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => toggleSelection(item.id, available)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-semibold text-text-primary">{card.name || item.card_id}</p>
                  <p className="truncate text-xs text-text-muted">
                    {card.set_ref?.name || card.set_id || '-'} #{card.number || '?'} · {item.variant || 'Normal'} · {item.condition || 'NM'} · {item.lang || 'en'}
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {t('products.availableCopies').replace('{count}', available)}
                    {item.purchase_price != null ? ` · ${t('products.paidPerCard').replace('{price}', formatPrice(item.purchase_price))}` : ''}
                    {addedAt ? ` · ${t('products.addedOn').replace('{date}', addedAt)}` : ''}
                  </p>
                </button>
                {selected && (
                  <div className="w-16 flex-shrink-0 sm:w-20">
                    <label className="mb-1 block text-[10px] text-text-muted" htmlFor={`product-card-quantity-${item.id}`}>
                      {t('common.quantity')}
                    </label>
                    <input
                      id={`product-card-quantity-${item.id}`}
                      type="number"
                      min="1"
                      max={available}
                      step="1"
                      className="input px-2 py-1.5 text-sm"
                      value={selections[item.id]}
                      onChange={(event) => setQuantity(item.id, event.target.value, available)}
                    />
                  </div>
                )}
              </div>
            )
          }) : (
            <div className="p-8 text-center text-sm text-text-muted">
              {candidates.length ? t('products.noCardsInRange') : t('products.noUnlinkedCards')}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-border bg-bg-surface pb-2 pt-4 sm:static sm:flex-row sm:items-center sm:justify-between sm:bg-transparent sm:pb-1">
          <p className="text-sm text-text-muted">{t('products.selectedCards').replace('{count}', selectedCount)}</p>
          <div className="flex gap-2">
            {selectedCount > 0 && (
              <button type="button" className="btn-ghost flex-1 sm:flex-none" onClick={clearSelections} disabled={loading}>
                {t('products.clearSelection')}
              </button>
            )}
            <button type="button" className="btn-primary flex-1 sm:flex-none" onClick={submit} disabled={!selectedCount || loading}>
              <Link2 size={14} /> {t('products.linkSelectedCards')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function ProductLedgerPanel({
  product,
  products,
  collectionItems,
  formatPrice,
  t,
  onLink,
  onUnlink,
  onSell,
  onFlatGain,
  loading,
  linkPickerOpen,
  onLinkPickerOpenChange,
}) {
  const { exchangeRate, exchangeRateReady } = useSettings()
  const today = new Date().toISOString().split('T')[0]
  const [internalLinkPickerOpen, setInternalLinkPickerOpen] = useState(false)
  const isLinkPickerOpen = linkPickerOpen ?? internalLinkPickerOpen
  const setLinkPickerOpen = onLinkPickerOpenChange ?? setInternalLinkPickerOpen
  const [saleForms, setSaleForms] = useState({})
  const [flatGain, setFlatGain] = useState({ amount: '', event_date: today, notes: '' })
  const linkedByItem = useMemo(() => linkedActiveQuantityByCollectionItem(products), [products])
  const availableCollectionItems = collectionItems
    .map(item => ({ item, available: Math.max((item.quantity || 0) - (linkedByItem.get(item.id) || 0), 0) }))
    .filter(({ available }) => available > 0)
  const canAddFlatGain = exchangeRateReady && isValidMoneyInputValue(flatGain.amount)

  const updateSaleForm = (entryId, key, value) => {
    setSaleForms(prev => ({
      ...prev,
      [entryId]: {
        quantity: 1,
        sold_price: '',
        sold_date: today,
        notes: '',
        ...(prev[entryId] || {}),
        [key]: value,
      },
    }))
  }

  const resetSaleForm = (entryId) => {
    setSaleForms(prev => {
      const copy = { ...prev }
      delete copy[entryId]
      return copy
    })
  }

  const submitSale = (entry) => {
    if (!exchangeRateReady) return
    const form = saleForms[entry.id] || { quantity: 1, sold_price: '', sold_date: today, notes: '' }
    const saleQuantity = Number(form.quantity)
    const salePrice = parseMoneyInputValue(form.sold_price, exchangeRate)
    if (!Number.isInteger(saleQuantity) || saleQuantity < 1 || saleQuantity > entry.active_quantity || salePrice == null || salePrice < 0) return
    return onSell(product.id, entry.id, {
      quantity: saleQuantity,
      sold_price: salePrice,
      sold_date: form.sold_date || today,
      notes: form.notes || null,
    }).then(() => resetSaleForm(entry.id))
  }

  const submitFlatGain = () => {
    if (!canAddFlatGain || !exchangeRateReady) return
    onFlatGain(product.id, {
      entry_type: 'flat_gain',
      amount: parseMoneyInputValue(flatGain.amount, exchangeRate),
      event_date: flatGain.event_date || today,
      notes: flatGain.notes || null,
    }).then(() => setFlatGain({ amount: '', event_date: today, notes: '' }))
  }

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="stat-card p-3">
          <p className="stat-label">{t('products.liveCardsValue')}</p>
          <p className="text-base font-bold text-text-primary">{formatPrice(product.linked_live_value || 0)}</p>
        </div>
        <div className="stat-card p-3">
          <p className="stat-label">{t('products.realizedGains')}</p>
          <p className="text-base font-bold text-green">{formatPrice(product.realized_gains || 0)}</p>
        </div>
        <div className="stat-card p-3">
          <p className="stat-label">{t('products.activeLinkedCards')}</p>
          <p className="text-base font-bold text-text-primary">{product.active_linked_cards_count || 0}</p>
        </div>
        <div className="stat-card p-3">
          <p className="stat-label">{t('products.soldLinkedCards')}</p>
          <p className="text-base font-bold text-text-primary">{product.sold_linked_cards_count || 0}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">{t('products.linkOwnedCards')}</p>
          <p className="text-xs text-text-muted">{t('products.linkOwnedCardsHelp')}</p>
        </div>
        <button disabled={!availableCollectionItems.length || loading} onClick={() => setLinkPickerOpen(true)} className="btn-primary w-full sm:w-auto">
          <Link2 size={14} /> {t('products.selectCards')}
        </button>
      </div>

      <ProductCardPicker
        isOpen={isLinkPickerOpen}
        onClose={() => setLinkPickerOpen(false)}
        product={product}
        candidates={availableCollectionItems}
        formatPrice={formatPrice}
        t={t}
        onLink={onLink}
        loading={loading}
      />

      {(product.product_cards || []).length > 0 ? (
        <div className="space-y-3">
          {(product.product_cards || []).map(entry => {
            const form = saleForms[entry.id] || { quantity: 1, sold_price: '', sold_date: today, notes: '' }
            const saleQuantity = Number(form.quantity)
            const canSell = Number.isInteger(saleQuantity)
              && saleQuantity >= 1
              && saleQuantity <= entry.active_quantity
              && form.sold_price !== ''
              && isValidMoneyInputValue(form.sold_price)
              && exchangeRateReady
            return (
              <div key={entry.id} className="bg-bg-card border border-border rounded-lg p-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-text-primary truncate">{entry.card?.name || entry.card_id}</p>
                    <p className="text-xs text-text-muted">
                      {entry.card?.set_ref?.name || entry.card?.set_id || '-'} #{entry.card?.number || '?'} · {entry.variant} · {entry.condition} · {entry.lang}
                    </p>
                    <p className="text-xs text-text-secondary mt-1">
                      {t('products.active')}: {entry.active_quantity} · {t('common.sold')}: {entry.sold_quantity} · {t('products.live')}: {formatPrice(entry.live_value || 0)} · {t('products.realized')}: {formatPrice(entry.realized_gains || 0)}
                    </p>
                  </div>
                  <button disabled={loading || entry.sold_quantity > 0} onClick={() => onUnlink(product.id, entry.id)} className="btn-ghost shrink-0 whitespace-nowrap px-2 text-xs py-1.5">
                    <X size={12} /> {t('products.unlink')}
                  </button>
                </div>

                {entry.active_quantity > 0 && (
                  <div className="grid gap-2 md:grid-cols-[0.5fr_0.8fr_0.8fr_1fr_auto]">
                    <input type="number" min="1" max={entry.active_quantity} step="1" className="input text-sm py-1.5" value={form.quantity} onChange={(e) => updateSaleForm(entry.id, 'quantity', e.target.value)} aria-label={t('common.quantity')} />
                    <MoneyInput className="input text-sm py-1.5" placeholder={t('products.saleTotal')} value={form.sold_price} onChange={(e) => updateSaleForm(entry.id, 'sold_price', e.target.value)} />
                    <input type="date" className="input text-sm py-1.5" value={form.sold_date} onChange={(e) => updateSaleForm(entry.id, 'sold_date', e.target.value)} />
                    <input type="text" className="input text-sm py-1.5" placeholder={t('products.saleNotes')} value={form.notes} onChange={(e) => updateSaleForm(entry.id, 'notes', e.target.value)} />
                    <button disabled={loading || !canSell} onClick={() => submitSale(entry)} className="btn-primary text-sm py-1.5">
                      <DollarSign size={13} /> {t('products.markSold')}
                    </button>
                  </div>
                )}

                {(entry.ledger_entries || []).length > 0 && (
                  <div className="pt-2 border-t border-border/70 space-y-1">
                    {(entry.ledger_entries || []).map(ledger => (
                      <p key={ledger.id} className="text-xs text-text-muted flex items-center gap-1">
                        <History size={12} /> {ledger.event_date}: {ledger.quantity} × {ledger.entry_type === 'trade_out' ? `${t('products.tradeOut')} - ${ledger.card_name || entry.card?.name || entry.card_id}` : (entry.card?.name || entry.card_id)} · {formatPrice(ledger.amount)}{ledger.notes ? ` · ${ledger.notes}` : ''}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-text-muted">{t('products.noLinkedCards')}</p>
      )}

      <div className="grid gap-2 md:grid-cols-[0.8fr_0.8fr_1fr_auto] pt-3 border-t border-border">
        <MoneyInput className="input text-sm py-1.5" placeholder={t('products.flatGainAmount')} value={flatGain.amount} onChange={(e) => setFlatGain(prev => ({ ...prev, amount: e.target.value }))} />
        <input type="date" className="input text-sm py-1.5" value={flatGain.event_date} onChange={(e) => setFlatGain(prev => ({ ...prev, event_date: e.target.value }))} />
        <input type="text" className="input text-sm py-1.5" placeholder={t('products.flatGainNotes')} value={flatGain.notes} onChange={(e) => setFlatGain(prev => ({ ...prev, notes: e.target.value }))} />
        <button disabled={loading || !canAddFlatGain} onClick={submitFlatGain} className="btn-ghost text-sm py-1.5">
          <Plus size={13} /> {t('products.addFlatGain')}
        </button>
      </div>

      {(product.ledger_entries || []).length > 0 && (
        <div className="space-y-1">
          {(product.ledger_entries || []).map(entry => (
            <p key={entry.id} className="text-xs text-text-muted flex items-center gap-1">
              <History size={12} /> {entry.event_date}: {t('products.flatGain')} · {formatPrice(entry.amount)}{entry.notes ? ` · ${entry.notes}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

const getLinkedCardCount = (product) => (
  (product.active_linked_cards_count || 0) + (product.sold_linked_cards_count || 0)
)

const getCardsActionLabel = (product, t) => {
  const count = getLinkedCardCount(product)
  return count > 0
    ? t('products.cardsCount').replace('{count}', count)
    : t('products.linkCardsAction')
}

function ProductCardsModal({
  product,
  products,
  collectionItems,
  formatPrice,
  t,
  onClose,
  onLink,
  onUnlink,
  onSell,
  onFlatGain,
  loading,
}) {
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)

  useEffect(() => {
    setLinkPickerOpen(false)
  }, [product?.id])

  if (!product) return null

  return (
    <Modal
      isOpen
      onClose={() => {
        if (!linkPickerOpen) onClose()
      }}
      title={t('products.cardsFor').replace('{product}', product.product_name)}
      size="xl"
      isObscured={linkPickerOpen}
    >
      <ProductLedgerPanel
        product={product}
        products={products}
        collectionItems={collectionItems}
        formatPrice={formatPrice}
        t={t}
        loading={loading}
        linkPickerOpen={linkPickerOpen}
        onLinkPickerOpenChange={setLinkPickerOpen}
        onLink={onLink}
        onUnlink={onUnlink}
        onSell={onSell}
        onFlatGain={onFlatGain}
      />
    </Modal>
  )
}

export default function Products() {
  const { t, formatPrice, pricePrimaryField } = useSettings()
  const confirmDialog = useConfirmDialog()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [cardProductId, setCardProductId] = useState(null)
  const [expandedBatchIds, setExpandedBatchIds] = useState(() => new Set())
  const [period, setPeriod] = useState('total')
  const [sortBy, setSortBy] = useState('purchase_date')
  const [sortOrder, setSortOrder] = useState('desc')
  const [filterType, setFilterType] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterPnl, setFilterPnl] = useState('all')
  const [showFilters, setShowFilters] = useState(false)
  const queryClient = useQueryClient()
  const { data: products = [], isLoading } = useQuery({
    queryKey: ['products', pricePrimaryField],
    queryFn: () => getProducts({ price_field: pricePrimaryField }).then(r => r.data),
  })

  const { data: summary } = useQuery({
    queryKey: ['products-summary', pricePrimaryField],
    queryFn: () => getProductsSummary({ price_field: pricePrimaryField }).then(r => r.data),
  })

  const { data: collectionItems = [] } = useQuery({
    queryKey: ['collection', 'products-linking'],
    queryFn: () => getCollection().then(r => r.data),
    enabled: products.length > 0,
  })

  const invalidateProducts = () => {
    queryClient.invalidateQueries({ queryKey: ['products'] })
    queryClient.invalidateQueries({ queryKey: ['products-summary'] })
    queryClient.invalidateQueries({ queryKey: ['collection'] })
    queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const createMutation = useMutation({
    mutationFn: createProductBatch,
    onSuccess: (response) => {
      toast.success(
        response.data.length === 1
          ? t('products.added')
          : t('products.addedCount').replace('{count}', response.data.length),
      )
      invalidateProducts()
      setCreating(false)
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.addFailed'))),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateProduct(id, data),
    onSuccess: () => {
      toast.success(t('products.updated'))
      invalidateProducts()
      setEditingId(null)
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.updateFailed'))),
  })

  const bulkLifecycleMutation = useMutation({
    mutationFn: bulkUpdateProductLifecycle,
    onSuccess: (response) => {
      toast.success(t('products.classifiedCount').replace('{count}', response.data.updated))
      invalidateProducts()
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.classificationFailed'))),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProduct,
    onSuccess: () => {
      toast.success(t('products.deleted'))
      invalidateProducts()
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.deleteFailed'))),
  })

  const linkCardsMutation = useMutation({
    mutationFn: ({ productId, items }) => linkProductCards(productId, { items }),
    onSuccess: (_response, variables) => {
      toast.success(t('products.cardsLinked').replace('{count}', variables.items.length))
      invalidateProducts()
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.cardLinkFailed'))),
  })

  const unlinkCardMutation = useMutation({
    mutationFn: ({ productId, productCardId }) => unlinkProductCard(productId, productCardId),
    onSuccess: () => {
      toast.success(t('products.cardUnlinked'))
      invalidateProducts()
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.cardUnlinkFailed'))),
  })

  const sellCardMutation = useMutation({
    mutationFn: ({ productId, productCardId, data }) => sellProductCard(productId, productCardId, data),
    onSuccess: () => {
      toast.success(t('products.cardSold'))
      invalidateProducts()
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.cardSellFailed'))),
  })

  const flatGainMutation = useMutation({
    mutationFn: ({ productId, data }) => addProductLedgerEntry(productId, data),
    onSuccess: () => {
      toast.success(t('products.flatGainAdded'))
      invalidateProducts()
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('products.flatGainFailed'))),
  })

  const hasActiveFilters = filterType || filterDateFrom || filterDateTo || filterPnl !== 'all'
  const reviewProducts = useMemo(
    () => products.filter(product => getProductLifecycleStatus(product) === 'review'),
    [products],
  )
  const periodCutoff = useMemo(() => getPeriodCutoff(period), [period])

  const periodStats = useMemo(() => {
    const cutoff = periodCutoff
    const periodProducts = products.filter(p => {
      if (cutoff && p.purchase_date < cutoff) return false
      return true
    })
    const totalInvested = periodProducts.reduce((s, p) => s + (p.purchase_price || 0), 0)
    const totalValue = periodProducts.reduce((s, p) => s + getProductValue(p), 0)
    const totalPnl = totalValue - totalInvested
    const pnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0
    return { totalInvested, totalValue, totalPnl, pnlPct, count: periodProducts.length }
  }, [products, periodCutoff])

  const filteredAndSorted = useMemo(() => {
    return products.filter(p => {
      if (filterType && p.product_type !== filterType) return false
      if (filterDateFrom && p.purchase_date < filterDateFrom) return false
      if (filterDateTo && p.purchase_date > filterDateTo) return false
      if (filterPnl === 'profit' && (p.pnl == null || p.pnl < 0)) return false
      if (filterPnl === 'loss' && (p.pnl == null || p.pnl >= 0)) return false
      if (periodCutoff && p.purchase_date < periodCutoff) return false
      return true
    })
  }, [products, filterType, filterDateFrom, filterDateTo, filterPnl, periodCutoff])

  const productDisplayRows = useMemo(
    () => buildProductDisplayRows(filteredAndSorted, expandedBatchIds, { sortBy, sortOrder }),
    [filteredAndSorted, expandedBatchIds, sortBy, sortOrder],
  )
  const editingProduct = products.find(product => product.id === editingId) || null
  const cardProduct = products.find(product => product.id === cardProductId) || null

  const toggleBatch = (batchId) => {
    setExpandedBatchIds(current => {
      const next = new Set(current)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  const resetFilters = () => { setFilterType(''); setFilterDateFrom(''); setFilterDateTo(''); setFilterPnl('all') }

  const monthlyChartData = summary?.monthly?.map(m => ({
    month: m.month, invested: m.invested, current: m.current, pnl: m.pnl,
  })) || []

  return (
    <div className="space-y-4 pb-2">
      <AnalyticsSectionNav />
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{t('products.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('products.subtitle')}</p>
        </div>
        <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
          <PeriodSelector value={period} onChange={setPeriod} periods={PRODUCT_PERIODS} />
          <button onClick={() => setCreating(true)} className="btn-primary justify-center whitespace-nowrap">
            <Plus size={16} /> {t('products.logPurchase')}
          </button>
        </div>
      </div>

      {reviewProducts.length > 0 && (
        <div className="card border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertCircle size={20} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-text-primary">
                {t('products.reviewTitle').replace('{count}', reviewProducts.length)}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">{t('products.reviewDescription')}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  className="btn-ghost justify-center"
                  disabled={bulkLifecycleMutation.isPending}
                  onClick={async () => {
                    const confirmed = await confirmDialog({
                      title: t('products.markAllOpened'),
                      message: t('products.confirmAllOpened').replace('{count}', reviewProducts.length),
                      confirmLabel: t('products.markAllOpened'),
                      destructive: false,
                    })
                    if (!confirmed) return
                    bulkLifecycleMutation.mutate({
                      product_ids: reviewProducts.map(product => product.id),
                      lifecycle_status: 'opened',
                    })
                  }}
                >
                  {t('products.markAllOpened')}
                </button>
                <button
                  className="btn-ghost justify-center"
                  disabled={bulkLifecycleMutation.isPending}
                  onClick={async () => {
                    const confirmed = await confirmDialog({
                      title: t('products.markAllSealed'),
                      message: t('products.confirmAllSealed').replace('{count}', reviewProducts.length),
                      confirmLabel: t('products.markAllSealed'),
                      destructive: false,
                    })
                    if (!confirmed) return
                    bulkLifecycleMutation.mutate({
                      product_ids: reviewProducts.map(product => product.id),
                      lifecycle_status: 'sealed',
                    })
                  }}
                >
                  {t('products.markAllSealed')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      {products.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.totalInvested')}</p>
            <p className="stat-value">{formatPrice(periodStats.totalInvested)}</p>
            <p className="text-xs text-text-muted">{periodStats.count} {t('products.items')}</p>
          </div>
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.currentValue')}</p>
            <p className="stat-value">{formatPrice(periodStats.totalValue)}</p>
          </div>
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.totalPnl')}</p>
            <p className={clsx('text-xl font-bold', periodStats.totalPnl >= 0 ? 'text-green' : 'text-brand-red')}>
              {periodStats.totalPnl >= 0 ? '+' : ''}{formatPrice(periodStats.totalPnl)}
            </p>
          </div>
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.return')}</p>
            <div className={clsx('flex items-center gap-1 whitespace-nowrap text-lg font-bold sm:text-xl', periodStats.pnlPct >= 0 ? 'text-green' : 'text-brand-red')}>
              {periodStats.pnlPct >= 0 ? <TrendingUp size={18} className="shrink-0" /> : <TrendingDown size={18} className="shrink-0" />}
              {periodStats.pnlPct >= 0 ? '+' : ''}{periodStats.pnlPct.toFixed(2)}%
            </div>
          </div>
        </div>
      )}

      {/* Monthly Chart */}
      {monthlyChartData.length > 0 && (
        <div className="card">
          <h3 className="text-base font-semibold text-text-primary mb-4">{t('products.monthlyPnl')}</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
              <XAxis dataKey="month" tick={{ fill: '#606078', fontSize: 11 }} />
              <YAxis tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => formatPrice(v)} />
              <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #2a2a3d', borderRadius: '8px', color: '#fff' }}
                formatter={(val, name) => [formatPrice(val), name]} />
              <Bar dataKey="invested" name={t('products.invested')} fill="#606078" radius={[4, 4, 0, 0]} />
              <Bar dataKey="current" name={t('products.currentValue')} fill="#EF1515" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Sort & Filter Bar */}
      {products.length > 0 && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <SortAsc size={14} className="text-text-muted" />
              <select className="select text-sm py-1.5 w-40" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="purchase_date">{t('products.sortDate')}</option>
                <option value="purchase_price">{t('products.sortPrice')}</option>
                <option value="product_name">{t('products.sortName')}</option>
                <option value="pnl">{t('products.sortPnl')}</option>
              </select>
              <button onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')} className="btn-ghost py-1.5 px-2">
                {sortOrder === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>

            <button onClick={() => setShowFilters(f => !f)}
              className={`btn-ghost text-sm py-1.5 ${showFilters || hasActiveFilters ? 'border-brand-red/30 text-brand-red' : ''}`}>
              <Filter size={14} /> {t('common.filter')}
              {hasActiveFilters && <span className="ml-1 bg-brand-red text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">!</span>}
            </button>

            {hasActiveFilters && (
              <button onClick={resetFilters} className="btn-ghost text-sm py-1.5">
                <X size={14} /> {t('common.clear')}
              </button>
            )}

            <div className="flex items-center gap-1 ml-auto">
              {[
                { value: 'all', label: t('products.filterAll') },
                { value: 'profit', label: t('products.filterOnlyProfit') },
                { value: 'loss', label: t('products.filterOnlyLoss') },
              ].map(opt => (
                <button key={opt.value} onClick={() => setFilterPnl(opt.value)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    filterPnl === opt.value
                      ? opt.value === 'profit' ? 'bg-green text-white'
                        : opt.value === 'loss' ? 'bg-brand-red text-white'
                        : 'bg-brand-red text-white'
                      : 'bg-bg-card text-text-secondary hover:text-text-primary border border-border'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {showFilters && (
            <div className="pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('products.filterType')}</label>
                <select className="select text-sm py-1.5" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                  <option value="">{t('products.allTypes')}</option>
                  {PRODUCT_TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('products.filterDateFrom')}</label>
                <input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="input text-sm py-1.5" />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('products.filterDateTo')}</label>
                <input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} className="input text-sm py-1.5" />
              </div>
              <div className="flex items-end">
                <span className="text-xs text-text-muted">{filteredAndSorted.length} / {products.length} {t('products.items')}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Products List */}
      {isLoading ? (
        <div className="skeleton h-64 rounded-xl" />
      ) : products.length === 0 ? (
        <div className="card text-center py-20">
          <Package size={48} className="mx-auto mb-4 text-text-muted" />
          <p className="text-text-muted">{t('products.empty')}</p>
          <button onClick={() => setCreating(true)} className="btn-primary mt-4 mx-auto w-fit">
            <Plus size={16} /> {t('products.logFirst')}
          </button>
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-text-muted">{t('products.noResults')}</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg/50">
                  <th className="text-left px-4 py-3 text-text-muted font-medium">{t('products.product')}</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">{t('products.productType')}</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.date')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.paidPrice')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.valueLabel')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.pnlLabel')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.pnlPct')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {productDisplayRows.map((row) => {
                  if (row.kind === 'batch') {
                    const first = row.products[0]
                    const totals = summarizeProductBatch(row.products)
                    const isExpanded = expandedBatchIds.has(row.batchId)
                    return (
                      <tr key={row.key} className="border-b border-border bg-bg-elevated/40">
                        <td className="px-4 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <img
                              src={productImageUrl(first)}
                              alt=""
                              className="h-12 w-10 flex-shrink-0 rounded-md border border-border bg-bg-elevated object-contain"
                              loading="lazy"
                            />
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-text-primary">{first.product_name}</p>
                              <span className="badge badge-gray mt-1 text-xs">
                                {t('products.batchItems').replace('{count}', row.products.length)}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-text-secondary">{first.product_type || '-'}</td>
                        <td className="px-4 py-3 text-xs text-text-secondary">{first.purchase_date}</td>
                        <td className="px-4 py-3 text-right font-semibold text-text-primary">{formatPrice(totals.purchasePrice)}</td>
                        <td className="px-4 py-3 text-right text-text-primary">
                          {totals.currentValue != null ? formatPrice(totals.currentValue) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">
                          {totals.pnl != null ? (
                            <span className={totals.pnl >= 0 ? 'text-green' : 'text-brand-red'}>
                              {totals.pnl >= 0 ? '+' : ''}{formatPrice(totals.pnl)}
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {totals.pnlPercent != null ? (
                            <span className={clsx('text-xs font-medium', totals.pnlPercent >= 0 ? 'text-green' : 'text-brand-red')}>
                              {totals.pnlPercent >= 0 ? '+' : ''}{totals.pnlPercent.toFixed(1)}%
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => toggleBatch(row.batchId)}
                            className="p-1 text-text-muted transition-colors hover:text-text-primary"
                            aria-label={`${t(isExpanded ? 'products.collapseBatch' : 'products.expandBatch')}: ${first.product_name}`}
                            aria-expanded={isExpanded}
                          >
                            <ChevronDown size={16} className={clsx('transition-transform', !isExpanded && '-rotate-90')} />
                          </button>
                        </td>
                      </tr>
                    )
                  }

                  const p = row.product
                  return (
                  <tr key={row.key} className="border-b border-border/50 hover:bg-bg-elevated/50">
                        <td className="px-4 py-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <img
                              src={productImageUrl(p)}
                              alt=""
                              className="h-12 w-10 flex-shrink-0 rounded-md border border-border bg-bg-elevated object-contain"
                              loading="lazy"
                            />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-text-primary">{p.product_name}</p>
                              {row.batchPosition && (
                                <p className="text-[10px] text-text-muted">
                                  {t('products.batchItem')
                                    .replace('{position}', row.batchPosition)
                                    .replace('{count}', row.batchSize)}
                                </p>
                              )}
                              {p.notes && <p className="max-w-[160px] truncate text-xs text-text-muted">{p.notes}</p>}
                              <span className={clsx(
                                'badge mt-1 text-xs',
                                getProductLifecycleStatus(p) === 'sold' ? 'badge-green' : 'badge-gray',
                              )}>
                                {getProductLifecycleLabel(p, t)}
                              </span>
                            </div>
                          </div>
                          {getProductLifecycleStatus(p) === 'review' && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              <button
                                className="rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
                                disabled={updateMutation.isPending}
                                onClick={() => updateMutation.mutate({ id: p.id, data: { lifecycle_status: 'opened' } })}
                              >
                                {t('products.markOpened')}
                              </button>
                              <button
                                className="rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
                                disabled={updateMutation.isPending}
                                onClick={() => updateMutation.mutate({ id: p.id, data: { lifecycle_status: 'sealed' } })}
                              >
                                {t('products.markSealed')}
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{p.product_type || '-'}</td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{p.purchase_date}</td>
                        <td className="px-4 py-3 text-right font-medium text-text-primary">{formatPrice(p.purchase_price)}</td>
                        <td className="px-4 py-3 text-right text-text-primary">
                          {p.value_source === 'needs_review'
                            ? '-'
                            : p.computed_current_value != null ? formatPrice(p.computed_current_value) : '-'}
                          {p.value_source === 'linked_cards' && <p className="text-[10px] text-text-muted">{t('products.dynamic')}</p>}
                          {p.value_source === 'purchase_cost_fallback' && <p className="text-[10px] text-text-muted">{t('products.costFallback')}</p>}
                          {p.value_source === 'opened_unlinked' && <p className="text-[10px] text-text-muted">{t('products.openedUnlinked')}</p>}
                          {p.value_source === 'needs_review' && <p className="text-[10px] text-amber-400">{t('products.excludedUntilReviewed')}</p>}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {p.pnl !== null ? (
                            <span className={p.pnl >= 0 ? 'text-green' : 'text-brand-red'}>
                              {p.pnl >= 0 ? '+' : ''}{formatPrice(p.pnl)}
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {p.pnl_percent !== null ? (
                            <span className={clsx('font-medium text-xs', p.pnl_percent >= 0 ? 'text-green' : 'text-brand-red')}>
                              {p.pnl_percent >= 0 ? '+' : ''}{p.pnl_percent?.toFixed(1)}%
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            {p.cardmarket_url && (
                              <a
                                href={p.cardmarket_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn-ghost whitespace-nowrap px-2 py-1.5 text-xs"
                                aria-label={`${t('products.openCardmarket')}: ${p.product_name}`}
                              >
                                <ExternalLink size={13} /> Cardmarket
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => setCardProductId(p.id)}
                              className="btn-ghost whitespace-nowrap px-2 py-1.5 text-xs"
                              aria-label={`${getCardsActionLabel(p, t)}: ${p.product_name}`}
                            >
                              <Link2 size={13} /> {getCardsActionLabel(p, t)}
                            </button>
                            <button onClick={() => setEditingId(p.id)} className="text-text-muted hover:text-text-primary p-1 transition-colors" aria-label={`${t('common.edit')}: ${p.product_name}`}>
                              <Edit2 size={14} />
                            </button>
                            <button onClick={async () => {
                              const confirmed = await confirmDialog({
                                title: t('common.delete'),
                                message: `${t('products.deleteConfirm')} "${p.product_name}"?`,
                                confirmLabel: t('common.delete'),
                                destructive: true,
                              })
                              if (confirmed) deleteMutation.mutate(p.id)
                            }} className="text-text-muted hover:text-brand-red p-1 transition-colors" aria-label={`${t('common.delete')}: ${p.product_name}`}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card Layout */}
          <div className="md:hidden space-y-2 p-2">
            {productDisplayRows.map((row) => {
              if (row.kind === 'batch') {
                const first = row.products[0]
                const totals = summarizeProductBatch(row.products)
                const isExpanded = expandedBatchIds.has(row.batchId)
                return (
                  <CardRow
                    key={row.key}
                    image={productImageUrl(first)}
                    name={first.product_name}
                    subtext={`${first.purchase_date} · ${t('products.paidPrice')}: ${formatPrice(totals.purchasePrice)} · ${t('products.valueLabel')}: ${totals.currentValue != null ? formatPrice(totals.currentValue) : '-'}`}
                    badges={[
                      { label: t('products.batchItems').replace('{count}', row.products.length), variant: 'gray' },
                      ...(first.product_type ? [{ label: first.product_type, variant: 'gray' }] : []),
                    ]}
                    value={totals.pnl != null ? `${totals.pnl >= 0 ? '+' : ''}${formatPrice(totals.pnl)}` : '-'}
                    valueSecondary={totals.pnlPercent != null ? `${totals.pnlPercent >= 0 ? '+' : ''}${totals.pnlPercent.toFixed(1)}%` : undefined}
                    onClick={() => toggleBatch(row.batchId)}
                    ariaLabel={`${t(isExpanded ? 'products.collapseBatch' : 'products.expandBatch')}: ${first.product_name}`}
                    ariaExpanded={isExpanded}
                    rightAction={
                      <ChevronDown
                        size={16}
                        className={clsx('text-text-muted transition-transform', !isExpanded && '-rotate-90')}
                        aria-hidden="true"
                      />
                    }
                  />
                )
              }

              const p = row.product
              const badges = []
              if (p.product_type) badges.push({ label: p.product_type, variant: 'gray' })
              badges.push({
                label: getProductLifecycleLabel(p, t),
                variant: getProductLifecycleStatus(p) === 'sold' ? 'green' : 'gray',
              })
              if (p.value_source === 'purchase_cost_fallback') badges.push({ label: t('products.costFallback'), variant: 'gray' })
              if (p.value_source === 'opened_unlinked') badges.push({ label: t('products.openedUnlinked'), variant: 'gray' })
              if (p.value_source === 'needs_review') badges.push({ label: t('products.excludedUntilReviewed'), variant: 'gray' })

              return (
                <div key={row.key}>
                  <CardRow
                    image={productImageUrl(p)}
                    name={p.product_name}
                    subtext={`${row.batchPosition ? `${t('products.batchItem').replace('{position}', row.batchPosition).replace('{count}', row.batchSize)} · ` : ''}${p.purchase_date} · ${formatPrice(p.purchase_price)} · ${t('products.valueLabel')}: ${p.value_source === 'needs_review' ? '-' : p.computed_current_value != null ? formatPrice(p.computed_current_value) : '-'}`}
                    badges={badges}
                    value={p.pnl !== null ? `${p.pnl >= 0 ? '+' : ''}${formatPrice(p.pnl)}` : '-'}
                    valueSecondary={p.pnl_percent !== null ? `${p.pnl_percent >= 0 ? '+' : ''}${p.pnl_percent?.toFixed(1)}%` : undefined}
                    className="!rounded-b-none"
                  />
                  <div className="flex min-h-[52px] items-center justify-end gap-1 rounded-b-xl border border-t-0 border-[rgba(255,255,255,0.05)] bg-[rgba(20,20,40,0.6)] px-2">
                    {p.cardmarket_url && (
                      <a
                        href={p.cardmarket_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-h-[44px] items-center gap-1 whitespace-nowrap rounded-lg px-1 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                        aria-label={`${t('products.openCardmarket')}: ${p.product_name}`}
                      >
                        <ExternalLink size={12} /> Cardmarket
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => setCardProductId(p.id)}
                      className="flex min-h-[44px] items-center gap-1 whitespace-nowrap rounded-lg px-1 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                      aria-label={`${getCardsActionLabel(p, t)}: ${p.product_name}`}
                    >
                      <Link2 size={12} /> {getCardsActionLabel(p, t)}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(p.id)}
                      className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:text-text-primary"
                      aria-label={`${t('common.edit')}: ${p.product_name}`}
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const confirmed = await confirmDialog({
                          title: t('common.delete'),
                          message: `${t('products.deleteConfirm')} "${p.product_name}"?`,
                          confirmLabel: t('common.delete'),
                          destructive: true,
                        })
                        if (confirmed) deleteMutation.mutate(p.id)
                      }}
                      className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:text-brand-red"
                      aria-label={`${t('common.delete')}: ${p.product_name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {getProductLifecycleStatus(p) === 'review' && (
                    <div className="mx-1 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
                      <button
                        className="btn-ghost flex-1 justify-center py-1.5 text-xs"
                        disabled={updateMutation.isPending}
                        onClick={() => updateMutation.mutate({ id: p.id, data: { lifecycle_status: 'opened' } })}
                      >
                        {t('products.markOpened')}
                      </button>
                      <button
                        className="btn-ghost flex-1 justify-center py-1.5 text-xs"
                        disabled={updateMutation.isPending}
                        onClick={() => updateMutation.mutate({ id: p.id, data: { lifecycle_status: 'sealed' } })}
                      >
                        {t('products.markSealed')}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <Modal
        isOpen={creating}
        onClose={() => {
          if (!createMutation.isPending) setCreating(false)
        }}
        title={t('products.logNew')}
        size="lg"
      >
        <div className="p-4 sm:p-5">
          <ProductForm
            onSubmit={(data) => createMutation.mutate(data)}
            onCancel={() => setCreating(false)}
            loading={createMutation.isPending}
          />
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(editingProduct)}
        onClose={() => {
          if (!updateMutation.isPending) setEditingId(null)
        }}
        title={t('products.editPurchase')}
        size="lg"
      >
        {editingProduct && (
          <div className="p-4 sm:p-5">
            <ProductForm
              key={editingProduct.id}
              initial={editingProduct}
              onSubmit={(data) => updateMutation.mutate({ id: editingProduct.id, data })}
              onCancel={() => setEditingId(null)}
              loading={updateMutation.isPending}
            />
          </div>
        )}
      </Modal>

      <ProductCardsModal
        product={cardProduct}
        products={products}
        collectionItems={collectionItems}
        formatPrice={formatPrice}
        t={t}
        onClose={() => setCardProductId(null)}
        loading={linkCardsMutation.isPending || unlinkCardMutation.isPending || sellCardMutation.isPending || flatGainMutation.isPending}
        onLink={(productId, items) => linkCardsMutation.mutateAsync({ productId, items })}
        onUnlink={(productId, productCardId) => unlinkCardMutation.mutateAsync({ productId, productCardId })}
        onSell={(productId, productCardId, data) => sellCardMutation.mutateAsync({ productId, productCardId, data })}
        onFlatGain={(productId, data) => flatGainMutation.mutateAsync({ productId, data })}
      />

      {/* By Type Breakdown */}
      {summary?.by_type?.length > 0 && (
        <div className="card">
          <h3 className="text-base font-semibold text-text-primary mb-4">{t('products.byType')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {summary.by_type.map((type) => (
              <div key={type.type} className="bg-bg-card border border-border rounded-lg p-3">
                <p className="text-xs text-text-muted mb-1">{type.type}</p>
                <p className="text-sm font-medium text-text-primary">{type.count} {t('products.items')}</p>
                <p className="text-xs text-text-secondary">{t('products.invested')}: {formatPrice(type.invested)}</p>
                <p className={clsx('text-sm font-bold mt-1', type.pnl >= 0 ? 'text-green' : 'text-brand-red')}>
                  {type.pnl >= 0 ? '+' : ''}{formatPrice(type.pnl)} ({type.pnl_pct >= 0 ? '+' : ''}{type.pnl_pct.toFixed(1)}%)
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
