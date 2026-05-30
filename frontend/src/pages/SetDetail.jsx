import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Check, Trash2, X } from 'lucide-react'
import { getSetChecklist, addToCollection, updateCollectionItem, removeFromCollection } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { resolveCardImageUrl, resolveSetImageUrl } from '../utils/imageUrl'
import { CARD_VARIANTS, getAvailableVariants, getDefaultVariantOrNull } from '../utils/cardVariants'
import FallbackBadges from '../components/FallbackBadges'
import { HOLO_FIELD_MAP } from '../utils/prices'

const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']

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

function OwnedVersionRow({ item, onQuantityChange, onRemove, isUpdating, isRemoving, t }) {
  const [quantity, setQuantity] = useState(item.quantity || 1)
  const [savedQuantity, setSavedQuantity] = useState(item.quantity || 1)

  const commitQuantity = () => {
    const nextQuantity = Math.max(1, parseInt(quantity, 10) || 1)
    setQuantity(nextQuantity)
    if (nextQuantity !== savedQuantity) {
      setSavedQuantity(nextQuantity)
      onQuantityChange(item, nextQuantity)
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-xl bg-bg-card border border-border p-2">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary font-medium truncate">
          {[item.variant || 'Normal', item.condition].filter(Boolean).join(' · ')}
        </p>
      </div>
      <input
        type="number"
        min="1"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        onBlur={commitQuantity}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        disabled={isUpdating || isRemoving}
        className="input text-center px-2 py-1.5"
        style={{ width: '4.25rem', colorScheme: 'dark' }}
        aria-label={t('card.quantity')}
        title={t('card.quantity')}
      />
      <button
        onClick={() => onRemove(item)}
        disabled={isRemoving}
        className="btn-ghost text-brand-red border-brand-red/30 hover:bg-brand-red/10 px-2 py-1.5"
        title={t('collection.remove')}
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

function SetCardActionModal({ card, setLang, onClose, onAdd, onQuantityChange, onRemove, isAdding, isUpdatingQuantity, isRemoving, t }) {
  const [addQuantity, setAddQuantity] = useState(1)
  const [addCondition, setAddCondition] = useState('NM')
  const [addVariant, setAddVariant] = useState('Normal')
  const [addLang, setAddLang] = useState(setLang)
  const [addPrice, setAddPrice] = useState('')

  useEffect(() => {
    if (!card) return
    setAddQuantity(1)
    setAddCondition('NM')
    setAddVariant(getDefaultVariantOrNull(card))
    setAddLang(setLang)
    setAddPrice('')
  }, [card, setLang])

  if (!card) return null
  const availableVariants = getAvailableVariants(card)
  const variants = availableVariants.length > 0 ? availableVariants : CARD_VARIANTS
  const ownedItems = card.owned_items || []

  const submitAddVersion = (event) => {
    event.preventDefault()
    onAdd({
      card,
      quantity: Math.max(1, parseInt(addQuantity, 10) || 1),
      condition: addCondition,
      variant: addVariant,
      lang: addLang,
      purchase_price: addPrice ? parseFloat(addPrice) : undefined,
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm md:flex md:items-center md:justify-center md:bg-black/80" onClick={onClose}>
      <div
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
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-text-primary">{card.name}</h2>
              <p className="text-xs text-text-muted">#{card.number} · {setLang.toUpperCase()}</p>
              <FallbackBadges card={card} className="mt-1" />
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={18} /></button>
          </div>

          <div className="space-y-4">
            <form onSubmit={submitAddVersion} className="space-y-3 rounded-xl border border-brand-red/30 bg-bg-card p-3">
              <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">{t('setDetail.addVersion')}</p>
              <p className="text-xs text-text-secondary -mt-1">{t('collection.addAnotherVersionHelp')}</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                  <input
                    type="number"
                    min="1"
                    value={addQuantity}
                    onChange={(e) => setAddQuantity(e.target.value)}
                    className="input"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                  <select value={addCondition} onChange={(e) => setAddCondition(e.target.value)} className="select">
                    {CONDITIONS.map(condition => <option key={condition} value={condition}>{condition}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
                <select value={addVariant} onChange={(e) => setAddVariant(e.target.value)} className="select">
                  {variants.map(variant => <option key={variant} value={variant}>{variant}</option>)}
                </select>
              </div>

              <div>
                <label className="text-xs text-text-muted mb-1.5 block">🌐 {t('lang.selectLabel')}</label>
                <div className="flex gap-2">
                  {['de', 'en'].map(lang => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => setAddLang(lang)}
                      className={clsx(
                        'flex-1 py-1.5 rounded-lg text-sm font-bold transition-all border',
                        addLang === lang
                          ? lang === 'de'
                            ? 'bg-yellow/20 text-yellow border-yellow/50'
                            : 'bg-blue/20 text-blue-400 border-blue-400/50'
                          : 'bg-bg-surface text-text-muted border-border hover:border-text-muted'
                      )}
                    >
                      {lang === 'de' ? `🇩🇪 ${t('lang.de_full')}` : `🇬🇧 ${t('lang.en_full')}`}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder={t('card.purchasePricePlaceholder')}
                  value={addPrice}
                  onChange={(e) => setAddPrice(e.target.value)}
                  className="input"
                />
              </div>

              <button type="submit" disabled={isAdding} className="btn-primary w-full justify-center">
                <Plus size={14} /> {isAdding ? t('card.adding') : t('collection.addVersionToCollection')}
              </button>
            </form>

            {ownedItems.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">{t('setDetail.ownedVersions')}</p>
                <div className="space-y-2">
                  {ownedItems.map(item => (
                    <OwnedVersionRow
                      key={item.id}
                      item={item}
                      onQuantityChange={onQuantityChange}
                      onRemove={onRemove}
                      isUpdating={isUpdatingQuantity}
                      isRemoving={isRemoving}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function SetDetail() {
  const { setId } = useParams()
  const navigate = useNavigate()
  const { t, pricePrimaryField } = useSettings()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('all')
  const [sortBy, setSortBy] = useState('number')
  const [rarityFilter, setRarityFilter] = useState('all')
  const [selectedCard, setSelectedCard] = useState(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['set-checklist', setId],
    queryFn: () => getSetChecklist(setId).then(r => r.data),
  })

  const setLang = data?.set?.lang || 'en'

  const addMutation = useMutation({
    mutationFn: ({ card, quantity = 1, condition = 'NM', variant, lang = setLang, purchase_price }) => addToCollection({
      card_id: card.id,
      quantity,
      condition,
      variant: variant === undefined ? getDefaultVariantOrNull(card) : variant,
      lang,
      purchase_price,
    }),
    onSuccess: () => {
      toast.success(t('card.addedToCollection'))
      queryClient.invalidateQueries({ queryKey: ['set-checklist', setId] })
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      setSelectedCard(null)
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const removeMutation = useMutation({
    mutationFn: (item) => removeFromCollection(item.id),
    onSuccess: () => {
      toast.success(t('collection.removed'))
      queryClient.invalidateQueries({ queryKey: ['set-checklist', setId] })
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      setSelectedCard(null)
    },
    onError: () => toast.error(t('collection.removeFailed')),
  })

  const quantityMutation = useMutation({
    mutationFn: ({ item, quantity }) => updateCollectionItem(item.id, { quantity }),
    onSuccess: () => {
      toast.success(t('collection.updated'))
      queryClient.invalidateQueries({ queryKey: ['set-checklist', setId] })
      queryClient.invalidateQueries({ queryKey: ['collection'] })
    },
    onError: () => toast.error(t('collection.updateFailed')),
  })

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
        <button onClick={() => navigate(-1)} className="btn-ghost mt-4 mx-auto">
          <ArrowLeft size={16} /> {t('setDetail.goBack')}
        </button>
      </div>
    )
  }

  const { set, cards = [], owned_count, total_count, progress } = data || {}

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
      <button onClick={() => navigate('/sets')} className="btn-ghost text-sm py-1.5">
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
              <div className="flex justify-between text-sm mb-1">
                <span className="text-text-secondary">
                  {owned_count} / {total_count} {t('setDetail.ownedOf')}
                </span>
                <span className="font-bold text-brand-red">{progress}%</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
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

          <div className="text-right hidden md:block flex-shrink-0">
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
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
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
          <div key={card.id}
            onClick={() => setSelectedCard(card)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedCard(card) }}
            role="button"
            tabIndex={0}
            className={clsx(
              'relative group rounded-lg overflow-hidden transition-all duration-200',
              card.owned
                ? 'ring-2 ring-green/50 hover:ring-green cursor-pointer'
                : 'opacity-60 hover:opacity-90 ring-1 ring-brand-red/30 hover:ring-brand-red/60 cursor-pointer'
            )}>
            {resolveCardImageUrl(card) ? (
              <img src={resolveCardImageUrl(card)} alt={card.name} className="w-full aspect-[2.5/3.5] object-cover" loading="lazy" />
            ) : (
              <div className="w-full aspect-[2.5/3.5] bg-bg-card flex items-center justify-center text-xs text-text-muted p-1 text-center">
                {card.name}
              </div>
            )}

            <FallbackBadges
              card={card}
              className="absolute left-1 right-1 bottom-5 z-10 justify-center pointer-events-none"
              compact
              variant="overlay"
            />

            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100">
              <p className="text-white text-xs font-medium text-center px-1 line-clamp-2">{card.name}</p>
              <button onClick={(e) => { e.stopPropagation(); setSelectedCard(card) }}
                className="bg-brand-red text-white rounded-full p-1">
                <Plus size={12} />
              </button>
            </div>

            {card.owned && (
              <div className="absolute top-0.5 right-0.5 bg-green rounded-full p-0.5">
                <Check size={8} className="text-white" />
              </div>
            )}
            {card.quantity > 1 && (
              <div className="absolute top-0.5 left-0.5 bg-bg-surface/90 rounded text-xs px-1 text-text-primary font-bold">
                {card.quantity}x
              </div>
            )}

            <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-center text-xs text-text-secondary py-0.5">
              #{card.number}
            </div>
          </div>
        ))}
      </div>

      <SetCardActionModal
        card={selectedCard}
        setLang={setLang}
        onClose={() => setSelectedCard(null)}
        onAdd={(payload) => addMutation.mutate(payload)}
        onQuantityChange={(item, quantity) => quantityMutation.mutate({ item, quantity })}
        onRemove={(item) => removeMutation.mutate(item)}
        isAdding={addMutation.isPending}
        isUpdatingQuantity={quantityMutation.isPending}
        isRemoving={removeMutation.isPending}
        t={t}
      />
    </div>
  )
}
