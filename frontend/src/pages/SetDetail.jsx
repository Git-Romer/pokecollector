import { useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, X, BookMarked, HelpCircle } from 'lucide-react'
import { getSetChecklist, getBinders, addOwnedSetToBinder, addOwnedSetToAutoBinder } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { resolveCardImageUrl, resolveSetImageUrl } from '../utils/imageUrl'
import { HOLO_FIELD_MAP } from '../utils/prices'
import { useDetailBackNavigation, useScrollToTopOnPush } from '../hooks/useListScrollRestoration'
import { CardDisplay, CardLegend } from '../components/card-system'
import { CardModal } from '../components/CardItem'

const SET_SORT_OPTIONS = [
  'number',
  'price_desc',
  'price_asc',
  'name_asc',
  'name_desc',
]

function numberSortKey(value) {
  const text = value == null ? '' : String(value)
  const match = text.match(/^(\D*)(\d+)(.*)$/)
  if (!match) return [text.toLowerCase(), Number.MAX_SAFE_INTEGER, '']
  return [match[1].toLowerCase(), Number(match[2]), match[3].toLowerCase()]
}

function compareNumberLike(a, b) {
  const left = numberSortKey(a)
  const right = numberSortKey(b)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' })
}

function positivePrice(value) {
  if (value == null) return null
  const price = Number(value)
  return Number.isFinite(price) && price > 0 ? price : null
}

function setSortPrice(card, pricePrimaryField) {
  const holoField = HOLO_FIELD_MAP[pricePrimaryField]
  const candidates = [
    card?.[pricePrimaryField],
    holoField ? card?.[holoField] : null,
    card?.price_market_holo,
    card?.price_market,
  ]
    .map(positivePrice)
    .filter(price => price != null)
  return candidates.length ? Math.max(...candidates) : 0
}

function sortSetCards(cards, sortBy, pricePrimaryField) {
  const sorted = [...cards]
  sorted.sort((a, b) => {
    if (sortBy === 'price_desc' || sortBy === 'price_asc') {
      const priceA = setSortPrice(a, pricePrimaryField)
      const priceB = setSortPrice(b, pricePrimaryField)
      const priceCompare = sortBy === 'price_desc' ? priceB - priceA : priceA - priceB
      if (priceCompare !== 0) return priceCompare
      return compareNumberLike(a.number, b.number)
    }
    if (sortBy === 'name_asc' || sortBy === 'name_desc') {
      const nameCompare = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
      if (nameCompare !== 0) return sortBy === 'name_asc' ? nameCompare : -nameCompare
      return compareNumberLike(a.number, b.number)
    }
    return compareNumberLike(a.number, b.number)
  })
  return sorted
}

export default function SetDetail() {
  const { setId } = useParams()
  const goBack = useDetailBackNavigation('sets', '/sets')
  useScrollToTopOnPush()
  const { t, pricePrimaryField, formatPrice } = useSettings()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('all')
  const [sortBy, setSortBy] = useState('number')
  const [rarityFilter, setRarityFilter] = useState('all')
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedCardTab, setSelectedCardTab] = useState('add')
  const [binderPickerOpen, setBinderPickerOpen] = useState(false)
  const [badgeLegendOpen, setBadgeLegendOpen] = useState(false)
  const [isReturningToSets, setIsReturningToSets] = useState(false)

  const returnToSets = () => {
    flushSync(() => setIsReturningToSets(true))
    goBack()
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['set-checklist', setId],
    queryFn: () => getSetChecklist(setId).then(r => r.data),
  })

  const setLang = data?.set?.lang || 'en'

  const bindersQuery = useQuery({
    queryKey: ['binders'],
    queryFn: () => getBinders().then(r => r.data),
    enabled: binderPickerOpen,
  })

  // Synchronous re-entry lock. `disabled={isPending}` is async React state and
  // does not block a rapid second click before the re-render, which would create
  // a duplicate binder; this ref blocks it immediately.
  const addOwnedSubmittingRef = useRef(false)

  const addOwnedMutation = useMutation({
    mutationFn: async ({ binderId, setId }) => {
      if (!binderId) return addOwnedSetToAutoBinder(setId)
      return addOwnedSetToBinder(binderId, setId)
    },
    onSuccess: (result) => {
      const skipped = (result.skipped_present || 0) + (result.skipped_no_capacity || 0)
      toast.success(t('setDetail.addOwnedToBinderResult').replace('{added}', result.added).replace('{skipped}', skipped))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setBinderPickerOpen(false)
    },
    onError: () => toast.error(t('setDetail.addOwnedToBinderFailed')),
    onSettled: () => { addOwnedSubmittingRef.current = false },
  })

  const submitAddOwned = (args) => {
    if (addOwnedSubmittingRef.current) return
    addOwnedSubmittingRef.current = true
    addOwnedMutation.mutate(args)
  }

  if (isReturningToSets) {
    return <div className="fixed inset-0 z-40 bg-bg" aria-hidden="true" />
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-32 rounded" />
        <div className="skeleton h-24 rounded-xl" />
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {[...Array(20)].map((_, i) => <div key={i} className="skeleton aspect-[2.5/3.5] rounded-lg" />)}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card text-center py-12">
        <p className="text-brand-red">{t('setDetail.loadFailed')} {error.message}</p>
        <button onClick={returnToSets} className="btn-ghost mt-4 mx-auto">
          <ArrowLeft size={16} /> {t('setDetail.goBack')}
        </button>
      </div>
    )
  }

  const { set, cards = [], owned_count, total_count, progress } = data || {}
  const numericProgress = Number(progress)
  const safeProgress = Number.isFinite(numericProgress)
    ? Math.min(100, Math.max(0, numericProgress))
    : 0

  const rarityOptions = [...new Set(cards.map(card => card.rarity).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }))

  const filteredCards = sortSetCards(cards.filter(card => {
    if (filter === 'owned' && !card.owned) return false
    if (filter === 'missing' && card.owned) return false
    if (rarityFilter !== 'all' && card.rarity !== rarityFilter) return false
    return true
  }), sortBy, pricePrimaryField)

  return (
    <div className="space-y-4 pb-2">
      <button onClick={returnToSets} className="btn-ghost text-sm py-1.5">
        <ArrowLeft size={14} /> {t('nav.sets')}
      </button>

      {/* Set Header */}
      <div className="card">
        <div className="flex items-start gap-4">
          {resolveSetImageUrl(set, 'logo') && (
            <img src={resolveSetImageUrl(set, 'logo')} alt={set.name} className="h-12 sm:h-16 object-contain flex-shrink-0 max-w-[120px]" />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text-primary truncate">{set?.name}</h1>
            <p className="text-sm text-text-secondary">{set?.series} · {total_count} {t('setDetail.cards')}</p>

            <div className="mt-3">
              <div className="mb-1 flex items-baseline gap-2 text-sm">
                <span className="text-text-secondary">
                  {owned_count} / {total_count} {t('setDetail.ownedOf')}
                </span>
                <span className="shrink-0 whitespace-nowrap font-bold tabular-nums text-brand-red">
                  {safeProgress}%
                </span>
              </div>
              <div className="hp-bar-track">
                <div
                  className={`hp-bar-fill ${safeProgress >= 66 ? 'healthy' : safeProgress >= 33 ? 'medium' : 'low'}`}
                  style={{ width: `${safeProgress}%` }}
                />
              </div>
            </div>

            <div className="flex gap-4 mt-3 md:hidden">
              <div>
                <p className="text-lg font-bold text-green">{owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.owned')}</p>
              </div>
              <div>
                <p className="text-lg font-bold text-brand-red">{total_count - owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.missing')}</p>
              </div>
            </div>
          </div>

          <div className="hidden md:flex flex-col items-end gap-3 flex-shrink-0">
            <div className="flex gap-4">
              <div>
                <p className="text-2xl font-bold text-green">{owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.owned')}</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-brand-red">{total_count - owned_count}</p>
                <p className="text-xs text-text-muted">{t('setDetail.missing')}</p>
              </div>
            </div>
          </div>
        </div>

        <button
          onClick={() => setBinderPickerOpen(true)}
          className="btn-ghost flex items-center justify-center gap-1.5 text-sm whitespace-nowrap w-full mt-3 md:w-auto md:ml-auto md:mt-3"
        >
          <BookMarked size={14} /> {t('setDetail.addOwnedToBinder')}
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex w-full min-w-0 gap-2 overflow-x-auto pb-1 sm:w-auto">
          {[
            { key: 'all', label: `${t('setDetail.all')} (${cards.length})` },
            { key: 'owned', label: `${t('setDetail.owned')} (${owned_count})` },
            { key: 'missing', label: `${t('setDetail.missing')} (${total_count - owned_count})` },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setFilter(key)}
              className={clsx(
                'px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap',
                filter === key
                  ? 'bg-brand-red/20 text-brand-red border border-brand-red/30'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
              )}>
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setBadgeLegendOpen(open => !open)}
          className={clsx(
            'btn-ghost flex-shrink-0 self-start px-3 py-2 text-sm sm:self-auto',
            badgeLegendOpen && 'border-brand-red/30 bg-brand-red/10 text-brand-red'
          )}
          aria-expanded={badgeLegendOpen}
          aria-controls="card-badge-legend"
          aria-label={t('setDetail.badgeLegend')}
        >
          <HelpCircle size={15} />
          <span>{t('setDetail.badgeLegend')}</span>
        </button>
      </div>

      {badgeLegendOpen && (
        <div id="card-badge-legend" className="card p-3">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('setDetail.badgeLegend')}
          </p>
          <CardLegend collapsible={false} />
        </div>
      )}

      {/* Sort and rarity controls */}
      <div className="card p-3">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <label className="block">
            <span className="text-xs text-text-muted mb-1 block">{t('setDetail.sortBy')}</span>
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="select">
              {SET_SORT_OPTIONS.map(option => (
                <option key={option} value={option}>{t(`setDetail.sort.${option}`)}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs text-text-muted mb-1 block">{t('setDetail.rarityFilter')}</span>
            <select value={rarityFilter} onChange={(event) => setRarityFilter(event.target.value)} className="select">
              <option value="all">{t('setDetail.allRarities')}</option>
              {rarityOptions.map(rarity => (
                <option key={rarity} value={rarity}>{rarity}</option>
              ))}
            </select>
          </label>

          <div className="text-xs text-text-muted md:text-right">
            {t('setDetail.showingCards').replace('{count}', filteredCards.length).replace('{total}', cards.length)}
          </div>
        </div>
      </div>

      {/* Card Grid */}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
        {filteredCards.map((card) => (
          <CardDisplay
            key={card.id}
            card={card}
            image={resolveCardImageUrl(card)}
            price={setSortPrice(card, pricePrimaryField) > 0 ? formatPrice(setSortPrice(card, pricePrimaryField)) : null}
            dimWhenUnowned
            onClick={() => {
              setSelectedCardTab('add')
              setSelectedCard(card)
            }}
            onAdd={() => {
              setSelectedCardTab('add')
              setSelectedCard(card)
            }}
          />
        ))}
      </div>

      {selectedCard && <CardModal
        key={selectedCard.id}
        card={selectedCard}
        defaultLang={setLang}
        initialTab={selectedCardTab}
        onClose={() => setSelectedCard(null)}
      />}

      {binderPickerOpen && createPortal(
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm md:flex md:items-center md:justify-center md:bg-black/80"
          onClick={() => setBinderPickerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-owned-to-binder-title"
            className={[
              'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
              'bg-bg-surface border-t border-border more-sheet-enter',
              'md:static md:w-full md:max-w-md md:rounded-2xl md:border md:max-h-[85vh] md:animate-none',
            ].join(' ')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-border rounded-full" />
            </div>

            <div className="p-5">
              <div className="flex items-start justify-between gap-3 mb-4">
                <h2 id="add-owned-to-binder-title" className="text-lg font-bold text-text-primary">
                  {t('setDetail.addOwnedToBinderTitle')}
                </h2>
                <button
                  onClick={() => setBinderPickerOpen(false)}
                  className="text-text-muted hover:text-text-primary flex-shrink-0 p-1"
                  aria-label={t('common.close')}
                >
                  <X size={18} />
                </button>
              </div>

              {owned_count === 0 ? (
                <p className="text-sm text-text-secondary">{t('setDetail.addOwnedToBinderEmpty')}</p>
              ) : (
                <>
                  <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">
                    {t('setDetail.addOwnedToBinderPick')}
                  </p>
                  <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                    {bindersQuery.isLoading && (
                      <p className="text-sm text-text-secondary">{t('common.loading')}</p>
                    )}
                    {bindersQuery.isError && (
                      <p className="text-sm text-brand-red">{t('setDetail.addOwnedToBinderLoadFailed')}</p>
                    )}
                    {!bindersQuery.isLoading && !bindersQuery.isError && (bindersQuery.data || []).filter(b => (b.binder_type || 'collection') === 'collection').length === 0 && (
                      <p className="text-sm text-text-secondary">{t('setDetail.addOwnedToBinderNoBinders')}</p>
                    )}
                    {(bindersQuery.data || []).filter(b => (b.binder_type || 'collection') === 'collection').map(b => (
                      <button
                        key={b.id}
                        disabled={addOwnedMutation.isPending}
                        onClick={() => submitAddOwned({ binderId: b.id, setId: set.id })}
                        className="text-left px-3 py-2.5 rounded-xl border border-border bg-bg-card hover:border-brand-red/40 hover:bg-brand-red/10 text-sm text-text-primary transition-colors disabled:opacity-50"
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                  <button
                    disabled={addOwnedMutation.isPending}
                    onClick={() => submitAddOwned({ binderId: null, setId: set.id })}
                    className="btn-primary w-full mt-3 flex items-center justify-center gap-1.5 text-sm disabled:opacity-50"
                  >
                    <Plus size={14} /> {t('setDetail.addOwnedToBinderNew')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
