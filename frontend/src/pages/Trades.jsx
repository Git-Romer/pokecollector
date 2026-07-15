import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Check, History, PenLine, Plus, Search, Trash2, Wallet } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import {
  createTrade,
  getApiErrorMessage,
  getCollection,
  getCustomCards,
  getTrades,
  searchCards,
} from '../api/client'
import CardImage from '../components/CardImage'
import MoneyInput from '../components/MoneyInput'
import { CustomCardModal } from '../components/CardItem'
import { useSettings } from '../contexts/SettingsContext'
import { CARD_VARIANTS, getDefaultVariantOrNull } from '../utils/cardVariants'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { getEffectiveCardPrice, priceFieldFromPrimary } from '../utils/prices'
import { formatMoneyInputValue, parseMoneyInputValue } from '../utils/moneyInput'
import { invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'

const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']

const today = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function cardTitle(card) {
  return card?.name || card?.card?.name || card?.card_id || card?.id || '-'
}

function cardSubtitle(card) {
  const source = card?.card || card
  const setName = source?.set_ref?.name || source?.set_id || '-'
  const number = source?.number ? ` #${source.number}` : ''
  return `${setName}${number}`
}

function snapshotCard(item) {
  return {
    ...(item.card || {}),
    id: item.card_id,
    name: item.card_name || item.card?.name,
    set_id: item.set_id || item.card?.set_id,
    number: item.card_number || item.card?.number,
    images_small: item.card?.images_small,
    images_large: item.card?.images_large,
    custom_image_url: item.card?.custom_image_url,
  }
}

function isCashTradeItem(item) {
  if (item?.card_id) return false
  if ((item?.card_name || '').toLowerCase() !== 'cash') return false
  if ((item?.set_id || '').toLowerCase() === 'cash' && (item?.card_number || '').toLowerCase() === 'cash') return true
  return ['cash added to trade', 'cash received in trade'].includes((item?.notes || '').toLowerCase())
}

function moneyToEur(value, exchangeRate) {
  const parsed = parseMoneyInputValue(value, exchangeRate, null)
  return parsed == null ? 0 : parsed
}

function TradeHealthBar({ outgoingValue, incomingValue, scoreOutgoingValue, missingPrices, t, formatPrice }) {
  const delta = incomingValue - outgoingValue
  const deltaPct = scoreOutgoingValue > 0
    ? (delta / scoreOutgoingValue) * 100
    : (delta > 0 ? 100 : (delta < 0 ? -100 : 0))
  let label = t('trades.emptyTrade')
  let score = 12
  let barColor = '#6b7280'

  if (missingPrices) {
    label = t('trades.missingPrices')
    score = 45
    barColor = '#f5c842'
  } else if (outgoingValue > 0 || incomingValue > 0) {
    if (deltaPct >= 15) {
      label = t('trades.youGain')
      score = 96
      barColor = '#66bb6a'
    } else if (deltaPct >= -5) {
      label = t('trades.fairTrade')
      score = 72
      barColor = '#66bb6a'
    } else if (deltaPct >= -15) {
      label = t('trades.closeTrade')
      score = 44
      barColor = '#f5c842'
    } else {
      label = t('trades.youLose')
      score = 18
      barColor = '#e3000b'
    }
  }
  const barWidth = Math.max(6, Math.min(100, score))

  return (
    <div className="rounded-lg border border-brand-red/30 bg-bg-card p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)] space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-brand-red/30 bg-brand-red/10">
            <ArrowRightLeft size={17} className="text-brand-red flex-shrink-0" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-text-muted">{t('trades.tradeMeter')}</p>
            <p className="text-sm font-black text-text-primary truncate">{label}</p>
            <p className={clsx('text-xs font-black', delta >= 0 ? 'text-green' : 'text-brand-red')}>
              {delta >= 0 ? '+' : ''}{formatPrice(delta)}
            </p>
          </div>
        </div>
        <div className="text-right text-xs font-bold text-text-muted flex-shrink-0">
          <div>{t('trades.give')}: {formatPrice(outgoingValue)}</div>
          <div>{t('trades.receive')}: {formatPrice(incomingValue)}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-full border border-border bg-bg-elevated px-2 py-1">
        <span className="text-[10px] font-black leading-none text-brand-red">{t('trades.profitLossShort')}</span>
        <div className="h-4 flex-1 rounded-full border border-black/50 bg-black/50 p-[3px]">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${barWidth}%`, backgroundColor: barColor }}
          />
        </div>
        <span className="w-14 text-right text-[10px] font-black tabular-nums text-text-secondary">{score}/100</span>
      </div>
    </div>
  )
}

function MiniCardRow({ card, meta, value, rightAction }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-card p-2 min-w-0">
      <div className="h-14 w-10 flex-shrink-0 overflow-hidden rounded bg-bg-elevated">
        <CardImage src={resolveCardImageUrl(card)} alt={cardTitle(card)} className="h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary">{cardTitle(card)}</p>
        <p className="truncate text-xs text-text-muted">{cardSubtitle(card)}</p>
        {meta && <p className="truncate text-xs text-text-secondary">{meta}</p>}
      </div>
      {value && <div className="text-right text-sm font-bold text-text-primary flex-shrink-0">{value}</div>}
      {rightAction}
    </div>
  )
}

function DraftItem({ item, side, onUpdate, onRemove, t, formatPrice, exchangeRate }) {
  const card = side === 'outgoing' ? item.collectionItem.card : item.card
  const total = moneyToEur(item.value_per_card, exchangeRate) * (Number(item.quantity) || 1)

  return (
    <div className="rounded-lg border border-border bg-bg-elevated/40 p-3 space-y-3">
      <MiniCardRow
        card={card}
        meta={`${item.variant || 'Normal'} - ${item.condition || 'NM'} - ${item.lang || card?.lang || 'en'}`}
        value={formatPrice(total)}
        rightAction={
          <button onClick={onRemove} className="btn-ghost p-2 text-brand-red" aria-label={t('common.remove')}>
            <Trash2 size={15} />
          </button>
        }
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('common.quantity')}</label>
          <input
            type="number"
            min="1"
            max={side === 'outgoing' ? item.collectionItem.quantity : 999}
            value={item.quantity}
            onChange={(event) => onUpdate({ quantity: Number(event.target.value) || 1 })}
            className="input"
          />
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('trades.valuePerCard')}</label>
          <MoneyInput value={item.value_per_card} onChange={(event) => onUpdate({ value_per_card: event.target.value })} />
        </div>
      </div>
      {side === 'incoming' && (
        <div className="grid grid-cols-2 gap-2">
          <select className="select" value={item.condition} onChange={(event) => onUpdate({ condition: event.target.value })}>
            {CONDITIONS.map(condition => <option key={condition} value={condition}>{condition}</option>)}
          </select>
          <select className="select" value={item.variant} onChange={(event) => onUpdate({ variant: event.target.value })}>
            {CARD_VARIANTS.map(variant => <option key={variant} value={variant}>{variant}</option>)}
          </select>
        </div>
      )}
      {side === 'outgoing' && item.collectionItem.product_sources?.length > 0 && (
        <p className="rounded border border-yellow/20 bg-yellow/10 px-2 py-1 text-xs text-yellow">
          {t('trades.productLinked')}
        </p>
      )}
    </div>
  )
}

function CashInput({ value, onChange, t }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-bg-elevated/40 p-3">
      <label className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-text-muted">
        <Wallet size={14} />
        {t('trades.cashAmount')}
      </label>
      <MoneyInput value={value} onChange={(event) => onChange(event.target.value)} placeholder={t('trades.cashPlaceholder')} />
    </div>
  )
}

function CashHistoryRow({ item, t, formatPrice }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-card p-2 min-w-0">
      <div className="flex h-14 w-10 flex-shrink-0 items-center justify-center rounded bg-bg-elevated text-text-secondary">
        <Wallet size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary">{t('trades.cashAmount')}</p>
        <p className="truncate text-xs text-text-muted">{t('trades.cashLine')}</p>
      </div>
      <div className="text-right text-sm font-bold text-text-primary flex-shrink-0">{formatPrice(item.value_total)}</div>
    </div>
  )
}

function SelectedPanel({ title, total, children, formatPrice }) {
  return (
    <div className="rounded-lg border-2 border-brand-red/30 bg-bg-card p-3 space-y-3 shadow-[0_0_0_1px_rgba(227,0,11,0.08)]">
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <h3 className="text-xs font-black uppercase tracking-[0.14em] text-brand-red">{title}</h3>
        <span className="text-sm font-bold text-text-primary">{formatPrice(total)}</span>
      </div>
      {children}
    </div>
  )
}

export default function Trades() {
  const { t, formatPrice, pricePrimaryField, exchangeRate } = useSettings()
  const queryClient = useQueryClient()
  const priceField = priceFieldFromPrimary(pricePrimaryField)
  const [tab, setTab] = useState('live')
  const [partnerName, setPartnerName] = useState('')
  const [tradeDate, setTradeDate] = useState(today())
  const [notes, setNotes] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')
  const [incomingSearch, setIncomingSearch] = useState('')
  const [outgoing, setOutgoing] = useState([])
  const [incoming, setIncoming] = useState([])
  const [outgoingCash, setOutgoingCash] = useState('')
  const [incomingCash, setIncomingCash] = useState('')
  const [showCustomModal, setShowCustomModal] = useState(false)

  const { data: collectionItems = [] } = useQuery({
    queryKey: ['collection', 'trades'],
    queryFn: () => getCollection({ sort_by: 'added_at', order: 'desc' }).then(r => r.data),
  })

  const { data: trades = [] } = useQuery({
    queryKey: ['trades'],
    queryFn: getTrades,
  })

  const { data: searchResults } = useQuery({
    queryKey: ['trade-card-search', incomingSearch],
    queryFn: () => searchCards({ name: incomingSearch, lang: 'all', page: 1, page_size: 8 }).then(r => r.data),
    enabled: incomingSearch.trim().length >= 2,
  })

  const { data: customCards = [] } = useQuery({
    queryKey: ['custom-cards'],
    queryFn: () => getCustomCards().then(r => r.data),
  })

  const filteredCollection = useMemo(() => {
    const term = collectionFilter.trim().toLowerCase()
    return collectionItems
      .filter(item => !term || [
        item.card?.name,
        item.card?.set_ref?.name,
        item.card?.set_id,
        item.card?.number,
      ].filter(Boolean).join(' ').toLowerCase().includes(term))
      .slice(0, 12)
  }, [collectionFilter, collectionItems])

  const incomingResults = useMemo(() => {
    const term = incomingSearch.trim().toLowerCase()
    const custom = term
      ? customCards.filter(card => `${card.name || ''} ${card.set_id || ''} ${card.number || ''}`.toLowerCase().includes(term)).slice(0, 4)
      : []
    return [...custom, ...(searchResults?.data || [])].slice(0, 12)
  }, [customCards, incomingSearch, searchResults])

  const addOutgoing = (collectionItem) => {
    const price = getEffectiveCardPrice(collectionItem.card, collectionItem.variant, priceField)
    setOutgoing(prev => {
      const existing = prev.find(item => item.collectionItem.id === collectionItem.id)
      if (existing) {
        return prev.map(item => item.collectionItem.id === collectionItem.id
          ? { ...item, quantity: Math.min((Number(item.quantity) || 1) + 1, 999) }
          : item)
      }
      return [...prev, {
        key: `out-${collectionItem.id}`,
        collectionItem,
        quantity: 1,
        value_per_card: formatMoneyInputValue(price, exchangeRate),
        variant: collectionItem.variant,
        condition: collectionItem.condition,
        lang: collectionItem.lang,
      }]
    })
  }

  const addIncomingCard = (card) => {
    const variant = getDefaultVariantOrNull(card) || 'Normal'
    const condition = 'NM'
    const lang = card.lang || card._lang || 'en'
    const price = getEffectiveCardPrice(card, variant, priceField)
    setIncoming(prev => {
      const existing = prev.find(item => item.card.id === card.id)
      if (existing) {
        return prev.map(item => item.key === existing.key
          ? { ...item, quantity: Math.min((Number(item.quantity) || 1) + 1, 999) }
          : item)
      }
      return [...prev, {
        key: `in-${card.id}-${variant}-${condition}-${lang}`,
        card,
        quantity: 1,
        condition,
        variant,
        lang,
        value_per_card: formatMoneyInputValue(price, exchangeRate),
      }]
    })
  }

  const updateDraft = (side, key, patch) => {
    const setter = side === 'outgoing' ? setOutgoing : setIncoming
    setter(prev => prev.map(item => item.key === key ? { ...item, ...patch } : item))
  }

  const removeDraft = (side, key) => {
    const setter = side === 'outgoing' ? setOutgoing : setIncoming
    setter(prev => prev.filter(item => item.key !== key))
  }

  const totals = useMemo(() => {
    const sum = (items) => items.reduce((total, item) => (
      total + moneyToEur(item.value_per_card, exchangeRate) * (Number(item.quantity) || 1)
    ), 0)
    const outgoingCashValue = moneyToEur(outgoingCash, exchangeRate)
    const incomingCashValue = moneyToEur(incomingCash, exchangeRate)
    const sharedCashValue = Math.min(outgoingCashValue, incomingCashValue)
    const hasMoneyValue = outgoingCashValue > 0 || incomingCashValue > 0
    const missing = !hasMoneyValue && [...outgoing, ...incoming].some(item => moneyToEur(item.value_per_card, exchangeRate) <= 0)
    const outgoingValue = Math.round((sum(outgoing) + outgoingCashValue) * 100) / 100
    const incomingValue = Math.round((sum(incoming) + incomingCashValue) * 100) / 100
    const scoreOutgoingValue = Math.max(0, Math.round((outgoingValue - sharedCashValue) * 100) / 100)
    return { outgoingValue, incomingValue, scoreOutgoingValue, missing }
  }, [exchangeRate, incoming, incomingCash, outgoing, outgoingCash])

  const resetDraft = () => {
    setPartnerName('')
    setTradeDate(today())
    setNotes('')
    setOutgoing([])
    setIncoming([])
    setOutgoingCash('')
    setIncomingCash('')
  }

  const createMutation = useMutation({
    mutationFn: () => createTrade({
      partner_name: partnerName || null,
      trade_date: tradeDate,
      notes: notes || null,
      outgoing_cash: parseMoneyInputValue(outgoingCash, exchangeRate, 0) || 0,
      incoming_cash: parseMoneyInputValue(incomingCash, exchangeRate, 0) || 0,
      outgoing: outgoing.map(item => ({
        collection_item_id: item.collectionItem.id,
        quantity: Number(item.quantity) || 1,
        value_per_card: parseMoneyInputValue(item.value_per_card, exchangeRate, null),
      })),
      incoming: incoming.map(item => {
        const value = parseMoneyInputValue(item.value_per_card, exchangeRate, null)
        return {
          card_id: item.card.id,
          quantity: Number(item.quantity) || 1,
          condition: item.condition,
          variant: item.variant,
          lang: item.lang || item.card.lang || 'en',
          value_per_card: value,
          purchase_price: value,
        }
      }),
    }, { price_field: priceField }),
    onSuccess: () => {
      toast.success(t('trades.saved'))
      resetDraft()
      queryClient.invalidateQueries({ queryKey: ['trades'] })
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
      invalidateTcgdexFilterLanguages(queryClient)
      setTab('history')
    },
    onError: (error) => toast.error(getApiErrorMessage(error, t('trades.saveFailed'))),
  })

  const canSave = (
    outgoing.length > 0
    || incoming.length > 0
    || moneyToEur(outgoingCash, exchangeRate) > 0
    || moneyToEur(incomingCash, exchangeRate) > 0
  ) && tradeDate && !createMutation.isPending

  return (
    <div className="space-y-4 pb-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">{t('trades.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('trades.subtitle')}</p>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-bg-card p-1">
          {[
            ['live', ArrowRightLeft, t('trades.liveTrade')],
            ['history', History, t('trades.history')],
          ].map(([id, Icon, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx(
                'flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition-colors',
                tab === id ? 'bg-brand-red text-white' : 'text-text-muted hover:text-text-primary'
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'live' ? (
        <>
          <TradeHealthBar
            outgoingValue={totals.outgoingValue}
            incomingValue={totals.incomingValue}
            scoreOutgoingValue={totals.scoreOutgoingValue}
            missingPrices={totals.missing}
            t={t}
            formatPrice={formatPrice}
          />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <section className="space-y-3">
              <div className="rounded-lg border border-border bg-bg-elevated/30 p-3 space-y-3 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-text-muted">{t('trades.give')}</h2>
                  <span className="text-sm font-bold text-text-primary">{formatPrice(totals.outgoingValue)}</span>
                </div>
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <input
                    value={collectionFilter}
                    onChange={(event) => setCollectionFilter(event.target.value)}
                    className="input pl-9"
                    placeholder={t('trades.searchCollection')}
                  />
                </div>
                <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                  {filteredCollection.map(item => (
                    <MiniCardRow
                      key={item.id}
                      card={item.card}
                      meta={`${item.variant} - ${item.condition} - ${t('common.quantity')}: ${item.quantity}`}
                      value={formatPrice(getEffectiveCardPrice(item.card, item.variant, priceField))}
                      rightAction={
                        <button onClick={() => addOutgoing(item)} className="btn-ghost p-2" aria-label={t('common.add')}>
                          <Plus size={15} />
                        </button>
                      }
                    />
                  ))}
                  {filteredCollection.length === 0 && <p className="py-4 text-center text-sm text-text-muted">{t('common.noResults')}</p>}
                </div>
              </div>

              <SelectedPanel title={t('trades.selectedGive')} total={totals.outgoingValue} formatPrice={formatPrice}>
                <CashInput value={outgoingCash} onChange={setOutgoingCash} t={t} />
                {outgoing.map(item => (
                  <DraftItem
                    key={item.key}
                    item={item}
                    side="outgoing"
                    onUpdate={(patch) => updateDraft('outgoing', item.key, patch)}
                    onRemove={() => removeDraft('outgoing', item.key)}
                    t={t}
                    formatPrice={formatPrice}
                    exchangeRate={exchangeRate}
                  />
                ))}
                {outgoing.length === 0 && moneyToEur(outgoingCash, exchangeRate) <= 0 && (
                  <p className="rounded-lg border border-dashed border-border py-5 text-center text-sm text-text-muted">{t('trades.noSelectedCards')}</p>
                )}
              </SelectedPanel>
            </section>

            <section className="space-y-3">
              <div className="rounded-lg border border-border bg-bg-elevated/30 p-3 space-y-3 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-text-muted">{t('trades.receive')}</h2>
                  <span className="text-sm font-bold text-text-primary">{formatPrice(totals.incomingValue)}</span>
                </div>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                    <input
                      value={incomingSearch}
                      onChange={(event) => setIncomingSearch(event.target.value)}
                      className="input pl-9"
                      placeholder={t('trades.searchIncoming')}
                    />
                  </div>
                  <button onClick={() => setShowCustomModal(true)} className="btn-ghost flex-shrink-0">
                    <PenLine size={15} />
                    {t('trades.manualCard')}
                  </button>
                </div>
                <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                  {incomingResults.map(card => (
                    <MiniCardRow
                      key={card.id}
                      card={card}
                      meta={card.is_custom ? t('cardSearch.customCard') : cardSubtitle(card)}
                      value={formatPrice(getEffectiveCardPrice(card, getDefaultVariantOrNull(card), priceField))}
                      rightAction={
                        <button onClick={() => addIncomingCard(card)} className="btn-ghost p-2" aria-label={t('common.add')}>
                          <Plus size={15} />
                        </button>
                      }
                    />
                  ))}
                  {incomingSearch.trim().length >= 2 && incomingResults.length === 0 && (
                    <p className="py-4 text-center text-sm text-text-muted">{t('common.noResults')}</p>
                  )}
                </div>
              </div>

              <SelectedPanel title={t('trades.selectedReceive')} total={totals.incomingValue} formatPrice={formatPrice}>
                <CashInput value={incomingCash} onChange={setIncomingCash} t={t} />
                {incoming.map(item => (
                  <DraftItem
                    key={item.key}
                    item={item}
                    side="incoming"
                    onUpdate={(patch) => updateDraft('incoming', item.key, patch)}
                    onRemove={() => removeDraft('incoming', item.key)}
                    t={t}
                    formatPrice={formatPrice}
                    exchangeRate={exchangeRate}
                  />
                ))}
                {incoming.length === 0 && moneyToEur(incomingCash, exchangeRate) <= 0 && (
                  <p className="rounded-lg border border-dashed border-border py-5 text-center text-sm text-text-muted">{t('trades.noSelectedCards')}</p>
                )}
              </SelectedPanel>
            </section>
          </div>

          <div className="rounded-lg border border-border bg-bg-card p-4 space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <input value={partnerName} onChange={(event) => setPartnerName(event.target.value)} className="input" placeholder={t('trades.partnerName')} />
              <input type="date" value={tradeDate} onChange={(event) => setTradeDate(event.target.value)} className="input" />
              <button onClick={() => createMutation.mutate()} disabled={!canSave} className="btn-primary justify-center">
                <Check size={16} />
                {createMutation.isPending ? t('common.saving') : t('trades.commitTrade')}
              </button>
            </div>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} className="input" placeholder={t('common.notes')} />
          </div>
        </>
      ) : (
        <div className="space-y-3">
          {trades.map(trade => (
            <div key={trade.id} className="rounded-lg border border-border bg-bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-bold text-text-primary">{trade.partner_name || t('trades.unnamedTrade')}</p>
                  <p className="text-xs text-text-muted">{trade.trade_date}</p>
                </div>
                <div className="text-right">
                  <p className={clsx('text-sm font-bold', trade.value_delta >= 0 ? 'text-green' : 'text-brand-red')}>
                    {trade.value_delta >= 0 ? '+' : ''}{formatPrice(trade.value_delta)}
                  </p>
                  <p className="text-xs text-text-muted">{formatPrice(trade.outgoing_value)} -&gt; {formatPrice(trade.incoming_value)}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {['outgoing', 'incoming'].map(direction => (
                  <div key={direction} className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-text-muted">
                      {direction === 'outgoing' ? t('trades.give') : t('trades.receive')}
                    </p>
                    {(trade.items || []).filter(item => item.direction === direction).map(item => (
                      isCashTradeItem(item) ? (
                        <CashHistoryRow key={item.id} item={item} t={t} formatPrice={formatPrice} />
                      ) : (
                        <MiniCardRow
                          key={item.id}
                          card={snapshotCard(item)}
                          meta={`${item.quantity} - ${item.variant || 'Normal'} - ${item.condition || 'NM'}`}
                          value={formatPrice(item.value_total)}
                        />
                      )
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {trades.length === 0 && <p className="py-8 text-center text-sm text-text-muted">{t('trades.noTrades')}</p>}
        </div>
      )}

      {showCustomModal && (
        <CustomCardModal
          onClose={() => setShowCustomModal(false)}
          onCreated={(card) => {
            queryClient.invalidateQueries({ queryKey: ['custom-cards'] })
            addIncomingCard(card)
          }}
        />
      )}
    </div>
  )
}
