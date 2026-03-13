import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, Check, X, Filter, SortAsc, Download, ChevronUp, ChevronDown, Search, PenLine, Grid2X2, List } from 'lucide-react'
import { getCollection, updateCollectionItem, removeFromCollection, exportCSV, exportPDF, getSets } from '../api/client'
import { CustomCardModal } from '../components/CardItem'
import { useSettings } from '../contexts/SettingsContext'
import CardListItem from '../components/CardListItem'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { useTilt } from '../hooks/useTilt'
import { resolveCardImageUrl } from '../utils/imageUrl'

function TiltBinderCard({ className, onClick, children }) {
  const { ref, onMouseMove, onMouseEnter, onMouseLeave } = useTilt(10)
  return (
    <div
      ref={ref}
      className={className}
      onClick={onClick}
      onMouseMove={onMouseMove}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  )
}

const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']
const CONDITION_COLORS = {
  Mint: 'badge-green',
  NM: 'badge-blue',
  LP: 'badge-yellow',
  MP: 'badge-red',
  HP: 'badge-red',
}
const CARD_VARIANTS = [
  'Normal', 'Holo', 'Reverse Holo', 'Full Art', 'Alt Art', 'Gold', 'Rainbow',
  'Illustration Rare', 'Special Illustration Rare', 'Crown Rare', 'Promo',
  'Art Rare', 'Ultra Rare', 'Secret Rare', 'Shiny',
]
const VARIANT_COLORS = {
  'Holo': 'badge-purple',
  'Reverse Holo': 'badge-blue',
  'Full Art': 'badge-yellow',
  'Alt Art': 'badge-pink',
  'Gold': 'badge-yellow',
  'Rainbow': 'badge-purple',
  'Illustration Rare': 'badge-blue',
  'Special Illustration Rare': 'badge-purple',
  'Crown Rare': 'badge-yellow',
  'Promo': 'badge-green',
  'Art Rare': 'badge-red',
  'Ultra Rare': 'badge-yellow',
  'Secret Rare': 'badge-red',
  'Shiny': 'badge-blue',
  'Normal': 'badge-gray',
}

const GRADE_OPTIONS = ['raw', 'PSA 9', 'PSA 10', 'BGS 9', 'BGS 9.5', 'CGC 9', 'CGC 10']

const HOLO_VARIANTS = new Set(['Holo', 'Holo Rare', 'Holo V', 'Holo VMAX', 'Holo VSTAR', 'Holo ex'])
const HOLO_FIELD_MAP = {
  price_market: 'price_market_holo',
  price_trend: 'price_trend_holo',
  price_avg1: 'price_avg1_holo',
  price_avg7: 'price_avg7_holo',
  price_avg30: 'price_avg30_holo',
}

// ─── Holo shimmer overlay ──────────────────────────────────────────────────
const HOLO_KEYFRAMES = `
@keyframes holoShimmer {
  0%   { transform: translateX(-100%) rotate(25deg); opacity: 0; }
  15%  { opacity: 0.7; }
  50%  { opacity: 0.5; }
  85%  { opacity: 0.7; }
  100% { transform: translateX(200%) rotate(25deg); opacity: 0; }
}
@keyframes holoShimmerAlt {
  0%   { transform: translateX(-120%) rotate(-20deg); opacity: 0; }
  20%  { opacity: 0.6; }
  80%  { opacity: 0.4; }
  100% { transform: translateX(220%) rotate(-20deg); opacity: 0; }
}
`

if (typeof document !== 'undefined' && !document.getElementById('holo-keyframes')) {
  const style = document.createElement('style')
  style.id = 'holo-keyframes'
  style.textContent = HOLO_KEYFRAMES
  document.head.appendChild(style)
}

function HoloOverlay({ variant }) {
  if (!variant) return null
  const v = variant.toLowerCase()

  let gradient = null
  let animationName = 'holoShimmer'
  let duration = '3s'
  let delay = '0s'

  if (v.includes('reverse')) {
    // Blue/cyan shimmer for Reverse Holo
    gradient = 'linear-gradient(105deg, transparent 30%, rgba(99,179,237,0.25) 50%, rgba(147,210,255,0.15) 55%, transparent 70%)'
    duration = '2.8s'
    animationName = 'holoShimmerAlt'
  } else if (v.includes('holo') || v === 'holo') {
    // Gold/rainbow shimmer for Holo
    gradient = 'linear-gradient(105deg, transparent 25%, rgba(245,200,66,0.20) 45%, rgba(255,230,100,0.15) 52%, rgba(245,200,66,0.20) 58%, transparent 75%)'
    duration = '3.2s'
  } else if (v.includes('alt art') || v.includes('illustration rare') || v.includes('special illustration')) {
    // Purple shimmer for Alt Art / Special Illustration
    gradient = 'linear-gradient(105deg, transparent 20%, rgba(167,139,250,0.20) 42%, rgba(196,181,253,0.15) 50%, rgba(167,139,250,0.20) 58%, transparent 78%)'
    duration = '4s'
  } else if (v.includes('first edition') || v.includes('1st edition')) {
    // Green shimmer for 1st Edition
    gradient = 'linear-gradient(105deg, transparent 30%, rgba(52,211,153,0.25) 50%, rgba(110,231,183,0.15) 55%, transparent 70%)'
    duration = '3.5s'
  } else {
    // Generic shimmer for any other special variant
    gradient = 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.25) 50%, transparent 70%)'
    duration = '3s'
  }

  if (!gradient) return null

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl"
      style={{ zIndex: 2 }}
    >
      <div
        style={{
          position: 'absolute',
          top: '-20%',
          left: 0,
          width: '60%',
          height: '140%',
          background: gradient,
          animation: `${animationName} ${duration} ease-in-out ${delay} infinite`,
          mixBlendMode: 'screen',
        }}
      />
    </div>
  )
}

// ─── CollectionEditModal ────────────────────────────────────────────────────
// Opens when clicking any card in the collection. Allows editing + deleting.
function CollectionEditModal({ item, onClose }) {
  const { t, formatPrice } = useSettings()
  const queryClient = useQueryClient()
  const card = item.card

  const [quantity, setQuantity] = useState(item.quantity)
  const [condition, setCondition] = useState(item.condition || 'NM')
  const [variant, setVariant] = useState(item.variant || '')
  const [grade, setGrade] = useState(item.grade || 'raw')
  const [lang, setLang] = useState(item.lang || 'en')
  const [price, setPrice] = useState(item.purchase_price ? String(item.purchase_price) : '')

  const cardImage = card?.images_large || card?.images_small || (card?.image ? `${card.image}/high.webp` : null)

  const updateMutation = useMutation({
    mutationFn: () => updateCollectionItem(item.id, {
      quantity,
      condition,
      variant: variant || null,
      grade: grade || 'raw',
      lang,
      purchase_price: price ? parseFloat(price) : null,
    }),
    onSuccess: () => {
      toast.success(t('collection.updated'))
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      onClose()
    },
    onError: () => toast.error(t('collection.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => removeFromCollection(item.id),
    onSuccess: () => {
      toast.success(t('collection.removed'))
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      onClose()
    },
    onError: () => toast.error(t('collection.removeFailed')),
  })

  const handleDelete = () => {
    if (confirm(`${card?.name || 'Karte'} ${t('collection.removeConfirm')}`)) {
      deleteMutation.mutate()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 md:flex md:items-center md:justify-center md:bg-black/80 md:backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={[
          'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
          'bg-bg-surface border-t border-border more-sheet-enter',
          'md:static md:rounded-2xl md:border md:max-w-lg md:w-full md:max-h-[85vh] md:animate-none',
        ].join(' ')}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="p-5">
          {/* Header */}
          <div className="flex items-start gap-4 mb-5">
            {cardImage && (
              <img src={cardImage} alt={card?.name} className="w-20 rounded-xl shadow-lg flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-text-primary break-words">{card?.name}</h2>
                  {card?.set_ref?.name && (
                    <p className="text-xs text-text-secondary mt-0.5">
                      {card.set_ref.name}{card?.number ? ` · #${card.number}` : ''}
                    </p>
                  )}
                  {card?.rarity && <p className="text-xs text-text-muted mt-0.5">{card.rarity}</p>}
                  {card?.price_market && (
                    <p className="text-sm font-bold text-green mt-1">{formatPrice(card.price_market)}</p>
                  )}
                </div>
                <button onClick={onClose} className="text-text-muted hover:text-text-primary flex-shrink-0 p-1">
                  <X size={18} />
                </button>
              </div>
            </div>
          </div>

          {/* Edit Form */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                <input
                  type="number" min="1" value={quantity}
                  onChange={e => setQuantity(parseInt(e.target.value) || 1)}
                  className="input"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                <select value={condition} onChange={e => setCondition(e.target.value)} className="select">
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
              <select value={variant} onChange={e => setVariant(e.target.value)} className="select">
                <option value="">{t('variants.none')}</option>
                {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-text-muted mb-1 block">🏅 {t('card.grade')}</label>
              <select value={grade} onChange={e => setGrade(e.target.value)} className="select">
                {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g === 'raw' ? t('card.gradeRaw') : g}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-text-muted mb-1.5 block">🌐 {t('lang.selectLabel')}</label>
              <div className="flex gap-2">
                {['de', 'en'].map(l => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    className={clsx(
                      'flex-1 py-1.5 rounded-lg text-sm font-bold transition-all border',
                      lang === l
                        ? l === 'de'
                          ? 'bg-yellow/20 text-yellow border-yellow/50'
                          : 'bg-blue/20 text-blue-400 border-blue-400/50'
                        : 'bg-bg-surface text-text-muted border-border hover:border-text-muted'
                    )}
                  >
                    {l === 'de' ? `🇩🇪 ${t('lang.de_full')}` : `🇬🇧 ${t('lang.en_full')}`}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
              <input
                type="number" step="0.01" min="0"
                placeholder={t('card.purchasePricePlaceholder')}
                value={price}
                onChange={e => setPrice(e.target.value)}
                className="input"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 mt-5">
            <button
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
              className="btn-primary flex-1"
            >
              <Check size={16} /> {updateMutation.isPending ? t('common.saving') : t('common.save')}
            </button>
            <button
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="btn-ghost text-brand-red border-brand-red/30 hover:bg-brand-red/10 px-3"
              title={t('collection.remove')}
            >
              <Trash2 size={16} />
            </button>
            <button onClick={onClose} className="btn-ghost px-3">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Collection() {
  const { t, formatPrice } = useSettings()
  const [viewMode, setViewMode] = useState('grid')
  const [editingCollectionItem, setEditingCollectionItem] = useState(null) // for CollectionEditModal
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [editCard, setEditCard] = useState(null)
  const [sortBy, setSortBy] = useState('added_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const [filterRarity, setFilterRarity] = useState('')
  const [filterCondition, setFilterCondition] = useState('')
  const [filterVariant, setFilterVariant] = useState('')
  const [filterSet, setFilterSet] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterMinPrice, setFilterMinPrice] = useState('')
  const [filterMaxPrice, setFilterMaxPrice] = useState('')
  const [filterDuplicates, setFilterDuplicates] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const queryClient = useQueryClient()

  const { data: items = [], isLoading, error } = useQuery({
    queryKey: ['collection'],
    queryFn: () => getCollection({}).then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: allSets = [] } = useQuery({
    queryKey: ['sets'],
    queryFn: () => getSets().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  function getEffectivePrice(card, variant, primaryField = 'price_market') {
    if (!card) return 0
    if (HOLO_VARIANTS.has(variant)) {
      // Map primary field to its holo equivalent
      const holoField = HOLO_FIELD_MAP[primaryField] ?? 'price_market_holo'
      const holoVal = card[holoField]
      if (holoVal != null) return holoVal
    }
    // Reverse Holo: standard non-holo CM price (reverse premium is TCGPlayer/USD only)
    return card[primaryField] ?? card.price_market ?? 0
  }

  const rarities = useMemo(() => [...new Set(items.map(i => i.card?.rarity).filter(Boolean))].sort(), [items])
  const sets = useMemo(() => {
    const map = new Map()
    items.forEach(i => {
      const s = i.card?.set_ref
      if (s?.id) map.set(s.id, s.name)
    })
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [items])
  const types = useMemo(() => {
    const all = new Set()
    items.forEach(i => (i.card?.types || []).forEach(tp => all.add(tp)))
    return [...all].sort()
  }, [items])

  const hasActiveFilters = filterRarity || filterCondition || filterVariant || filterSet || filterType || filterMinPrice || filterMaxPrice || filterDuplicates || searchText

  const filtered = useMemo(() => {
    let result = items.filter(item => {
      const card = item.card
      const marketPrice = getEffectivePrice(card, item.variant)
      if (filterRarity && card?.rarity !== filterRarity) return false
      if (filterCondition && item.condition !== filterCondition) return false
      if (filterVariant && item.variant !== filterVariant) return false
      if (filterSet) {
        if (item.card?.set_ref?.id !== filterSet) return false
      }
      if (filterType && !(card?.types || []).includes(filterType)) return false
      if (filterMinPrice && marketPrice < parseFloat(filterMinPrice)) return false
      if (filterMaxPrice && marketPrice > parseFloat(filterMaxPrice)) return false
      if (filterDuplicates && item.quantity < 2) return false
      if (searchText && !card?.name.toLowerCase().includes(searchText.toLowerCase())) return false
      return true
    })

    result = [...result].sort((a, b) => {
      let valA, valB
      switch (sortBy) {
        case 'added_at': valA = a.added_at || ''; valB = b.added_at || ''; break
        case 'quantity': valA = a.quantity; valB = b.quantity; break
        case 'purchase_price': valA = a.purchase_price ?? -1; valB = b.purchase_price ?? -1; break
        case 'market_price': valA = getEffectivePrice(a.card, a.variant); valB = getEffectivePrice(b.card, b.variant); break
        case 'price_trend': valA = getEffectivePrice(a.card, a.variant, 'price_trend'); valB = getEffectivePrice(b.card, b.variant, 'price_trend'); break
        case 'set': valA = a.card?.set_ref?.name || ''; valB = b.card?.set_ref?.name || ''; break
        case 'name': valA = a.card?.name?.toLowerCase() || ''; valB = b.card?.name?.toLowerCase() || ''; break
        default: return 0
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })

    return result
  }, [items, filterRarity, filterCondition, filterVariant, filterSet, filterType, filterMinPrice, filterMaxPrice, filterDuplicates, searchText, sortBy, sortOrder])

  const totalValue = filtered.reduce((sum, item) => sum + (getEffectivePrice(item.card, item.variant) * item.quantity), 0)
  const totalCards = filtered.reduce((sum, item) => sum + item.quantity, 0)

  const resetFilters = () => {
    setFilterRarity(''); setFilterCondition(''); setFilterVariant('')
    setFilterSet(''); setFilterType(''); setFilterMinPrice('')
    setFilterMaxPrice(''); setFilterDuplicates(false); setSearchText('')
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-48 rounded" />
        {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-2">

      {/* ─── Header ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{t('collection.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">
            {totalCards.toLocaleString()} {t('collection.cards')} · {formatPrice(totalValue)} {t('collection.totalValue')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">

          {/* VIEW TOGGLE */}
          <div className="flex items-center gap-0.5 bg-bg-elevated rounded-lg p-1">
            <button
              onClick={() => setViewMode('grid')}
              title="Binder view"
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-brand-red text-white' : 'text-text-muted hover:text-text-primary'}`}
            >
              <Grid2X2 size={15} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              title="List view"
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-brand-red text-white' : 'text-text-muted hover:text-text-primary'}`}
            >
              <List size={15} />
            </button>
          </div>

          <button onClick={() => setShowCustomModal(true)}
            className="btn-ghost text-sm py-1.5 border-yellow/30 text-yellow hover:bg-yellow/10">
            <PenLine size={14} /> {t('collection.addCustomCard')}
          </button>
          <button onClick={exportCSV} className="btn-ghost text-sm py-1.5"><Download size={14} />CSV</button>
          <button onClick={exportPDF} className="btn-ghost text-sm py-1.5"><Download size={14} />PDF</button>
        </div>
      </div>

      {/* ─── Filter & Sort Bar ────────────────────────────────────── */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <SortAsc size={14} className="text-text-muted" />
            <select className="select w-40 py-1.5 text-sm" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="added_at">{t('collection.sortDateAdded')}</option>
              <option value="name">{t('common.name')}</option>
              <option value="quantity">{t('collection.sortQuantity')}</option>
              <option value="purchase_price">{t('collection.sortPurchasePrice')}</option>
              <option value="market_price">{t('collection.sortMarketPrice')}</option>
              <option value="price_trend">{t('collection.sortTrend')}</option>
              <option value="set">{t('collection.sortSet')}</option>
            </select>
            <button onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')} className="btn-ghost py-1.5 px-2">
              {sortOrder === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>

          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input type="text" placeholder={t('collection.searchCards')} value={searchText}
              onChange={(e) => setSearchText(e.target.value)} className="input pl-8 text-sm py-1.5" />
          </div>

          <button onClick={() => setShowFilters(f => !f)}
            className={`btn-ghost text-sm py-1.5 ${showFilters || hasActiveFilters ? 'border-brand-red/30 text-brand-red' : ''}`}>
            <Filter size={14} /> {t('common.filter')}
            {hasActiveFilters && <span className="ml-1 bg-brand-red text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">!</span>}
          </button>

          {hasActiveFilters && (
            <button onClick={resetFilters} className="btn-ghost text-sm py-1.5">
              <X size={14} /> {t('collection.clearFilters')}
            </button>
          )}
        </div>

        {showFilters && (
          <div className="pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
              <select className="select py-1.5 text-sm" value={filterRarity} onChange={(e) => setFilterRarity(e.target.value)}>
                <option value="">{t('common.allRarities')}</option>
                {rarities.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('common.condition')}</label>
              <select className="select py-1.5 text-sm" value={filterCondition} onChange={(e) => setFilterCondition(e.target.value)}>
                <option value="">{t('common.allConditions')}</option>
                {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">✨ {t('variants.filterVariant')}</label>
              <select className="select py-1.5 text-sm" value={filterVariant} onChange={(e) => setFilterVariant(e.target.value)}>
                <option value="">{t('variants.allVariants')}</option>
                {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('collection.filterSet')}</label>
              <select className="select py-1.5 text-sm" value={filterSet} onChange={(e) => setFilterSet(e.target.value)}>
                <option value="">{t('collection.allSets')}</option>
                {sets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('collection.filterType')}</label>
              <select className="select py-1.5 text-sm" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                <option value="">{t('collection.allTypes')}</option>
                {types.map(tp => <option key={tp} value={tp}>{tp}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('collection.filterMinPrice')}</label>
              <input type="number" min="0" step="0.01" placeholder="0" value={filterMinPrice}
                onChange={(e) => setFilterMinPrice(e.target.value)} className="input py-1.5 text-sm" />
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('collection.filterMaxPrice')}</label>
              <input type="number" min="0" step="0.01" placeholder="∞" value={filterMaxPrice}
                onChange={(e) => setFilterMaxPrice(e.target.value)} className="input py-1.5 text-sm" />
            </div>
            <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={filterDuplicates} onChange={(e) => setFilterDuplicates(e.target.checked)}
                  className="w-4 h-4 accent-brand-red" />
                <span className="text-xs text-text-secondary">{t('collection.filterDuplicates')}</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* ─── GRID BINDER VIEW ─────────────────────────────────────── */}
      {viewMode === 'grid' && (
        <>
          {items.length === 0 ? (
            <div className="card text-center py-20">
              <img src="/pokeball.svg" className="w-16 h-16 mx-auto mb-4 opacity-20" alt="" />
              <p className="text-text-muted">{t('collection.empty')}</p>
              <p className="text-xs text-text-muted mt-1">{t('collection.emptyHint')}</p>
            </div>
          ) : (
            <div className="binder-grid">
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                {filtered.map(item => {
                  const card = item.card
                  const rarityLower = (card?.rarity || '').toLowerCase()
                  let rarityClass = ''
                  if (rarityLower.includes('secret') || rarityLower.includes('rainbow')) {
                    rarityClass = 'card-secret'
                  } else if (
                    rarityLower.includes('ultra') ||
                    rarityLower.includes('vmax') ||
                    rarityLower.includes('v max') ||
                    rarityLower.includes('full art')
                  ) {
                    rarityClass = 'card-holo'
                  } else if (rarityLower.includes('holo') || rarityLower.includes('rare')) {
                    rarityClass = 'card-holo'
                  }

                  return (
                    <TiltBinderCard
                      key={item.id}
                      className={`binder-card ${rarityClass} cursor-pointer`}
                      onClick={() => setEditingCollectionItem(item)}
                    >
                      <div
                        className="aspect-[2.5/3.5] relative rounded-xl overflow-hidden flex-shrink-0"
                      >
                        {card?.images_small
                          ? <img
                              src={resolveCardImageUrl(card)}
                              alt={card?.name}
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          : <div className="w-full h-full bg-bg-elevated flex items-center justify-center">
                              <span className="text-[9px] text-text-muted text-center p-1 leading-tight">
                                {card?.name}
                              </span>
                            </div>
                        }
                        <HoloOverlay variant={item.variant} />
                      </div>
                      {(() => {
                        const abbr = card?.set_ref?.abbreviation
                        const num = card?.number
                        const setName = card?.set_ref?.name
                        if (abbr && num) {
                          return (
                            <p className="text-[10px] font-mono font-bold text-brand-red/70 leading-tight truncate mt-0.5 px-0.5">
                              {abbr} {num}
                            </p>
                          )
                        } else if (setName) {
                          return (
                            <p className="text-[10px] text-text-muted leading-tight truncate mt-0.5 px-0.5">
                              {setName}
                            </p>
                          )
                        }
                        return null
                      })()}
                      <div className="flex flex-wrap gap-0.5 mt-0.5 px-0.5">
                        {item.quantity > 1 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-black px-1.5 py-0.5 rounded-full bg-brand-red/20 text-brand-red border border-brand-red/40">
                            ×{item.quantity}
                          </span>
                        )}
                        {item.variant && item.variant !== 'Normal' && (
                          <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-yellow/15 text-yellow border border-yellow/30 truncate max-w-[80px]">
                            ✨ {item.variant}
                          </span>
                        )}
                        {item.grade && item.grade !== 'raw' && (
                          <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40">
                            🏅 {item.grade}
                          </span>
                        )}
                        {item.lang && (
                          <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${
                            item.lang === 'de'
                              ? 'bg-yellow/20 text-yellow border border-yellow/30'
                              : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                          }`}>
                            {item.lang.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </TiltBinderCard>
                  )
                })}
              </div>
            </div>
          )}
          {filtered.length > 0 && (
            <div className="flex items-center justify-between text-sm pt-1 px-1">
              <span className="text-text-muted">{filtered.length} {t('collection.filtered')}</span>
              <span className="font-bold text-gold">{formatPrice(totalValue)}</span>
            </div>
          )}
        </>
      )}

      {/* ─── LIST VIEW (table + mobile cards) ────────────────────── */}
      {viewMode === 'list' && (
        <>
          {items.length === 0 ? (
            <div className="card text-center py-20">
              <div className="w-24 h-24 pokeball-bg mx-auto mb-4 opacity-20" />
              <p className="text-text-muted">{t('collection.empty')}</p>
              <p className="text-xs text-text-muted mt-1">{t('collection.emptyHint')}</p>
            </div>
          ) : (
            <div className="card p-0 overflow-hidden">
              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-bg/50">
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('collection.card')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.set')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.rarity')}</th>
                      <th className="text-center px-4 py-3 text-text-muted font-medium">{t('collection.qty')}</th>
                      <th className="text-center px-4 py-3 text-text-muted font-medium">{t('common.condition')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">✨ {t('variants.label')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('collection.buyPrice')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('collection.marketPrice')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('collection.totalVal')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => {
                      const card = item.card
                      const marketPrice = getEffectivePrice(card, item.variant)
                      const totalVal = marketPrice * item.quantity
                      const buyTotal = (item.purchase_price || 0) * item.quantity
                      const pnl = item.purchase_price ? totalVal - buyTotal : null

                      return (
                        <tr
                          key={item.id}
                          className="border-b border-border/50 hover:bg-bg-elevated/50 transition-colors cursor-pointer"
                          onClick={() => setEditingCollectionItem(item)}
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-10 flex-shrink-0 rounded overflow-hidden">
                                {card?.images_small ? (
                                  <img src={resolveCardImageUrl(card)} alt={card?.name} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full bg-border" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1 flex-wrap">
                                  <p className="text-sm font-medium text-text-primary hover:text-brand-red transition-colors truncate max-w-[130px]">
                                    {card?.name}
                                  </p>
                                  {card?.is_custom && (
                                    <span className="text-xs bg-yellow/20 text-yellow px-1 rounded" title="Manual">✏️</span>
                                  )}
                                  {item.lang && (
                                    <span className={`text-[9px] font-black px-1 py-0.5 rounded leading-none ${
                                      item.lang === 'de'
                                        ? 'bg-yellow/20 text-yellow'
                                        : 'bg-blue/20 text-blue-400'
                                    }`}>
                                      {item.lang.toUpperCase()}
                                    </span>
                                  )}
                                  {item.grade && item.grade !== 'raw' && (
                                    <span className="text-[9px] font-black px-1 py-0.5 rounded leading-none"
                                      style={{ background: 'rgba(184,134,11,0.2)', color: '#b8860b', border: '1px solid rgba(184,134,11,0.4)' }}>
                                      {item.grade}
                                    </span>
                                  )}
                                </div>
                                {(() => {
                                  const abbr = card?.set_ref?.abbreviation
                                  const num = card?.number
                                  if (abbr && num) return <p className="text-[10px] font-mono text-brand-red/70">{abbr} {num}</p>
                                  if (num) return <p className="text-[10px] font-mono text-text-muted">#{num}</p>
                                  return null
                                })()}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-text-secondary truncate max-w-[120px]">{card?.set_ref?.name || '-'}</td>
                          <td className="px-4 py-3 text-text-secondary text-xs">{card?.rarity || '-'}</td>
                          <td className="px-4 py-3 text-center">
                            <span className="font-medium text-text-primary">
                              {item.quantity}
                              {item.quantity > 1 && <span className="ml-1 text-xs text-brand-red">×{item.quantity}</span>}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={clsx('badge text-xs', CONDITION_COLORS[item.condition] || 'badge-blue')}>{item.condition}</span>
                          </td>
                          <td className="px-4 py-3 text-left">
                            {item.variant ? (
                              <span className={clsx('badge text-xs', VARIANT_COLORS[item.variant] || 'badge-gray')}>{item.variant}</span>
                            ) : (
                              <span className="text-text-muted text-xs">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-text-secondary">
                            {item.purchase_price ? formatPrice(item.purchase_price) : '-'}
                          </td>
                          <td className="px-4 py-3 text-right text-text-primary font-medium">
                            {marketPrice > 0 ? formatPrice(marketPrice) : '-'}
                          </td>
                          <td className="px-4 py-3 text-right font-semibold text-green">
                            {marketPrice > 0 ? formatPrice(totalVal) : '-'}
                          </td>
                          <td className="px-4 py-3 text-right text-xs font-medium">
                            {pnl !== null ? (
                              <span className={pnl >= 0 ? 'text-green' : 'text-brand-red'}>
                                {pnl >= 0 ? '+' : ''}{formatPrice(pnl)}
                              </span>
                            ) : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border bg-bg/50">
                      <td colSpan={8} className="px-4 py-3 text-text-muted text-sm">{filtered.length} {t('collection.filtered')}</td>
                      <td className="px-4 py-3 text-right font-bold text-green">{formatPrice(totalValue)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Mobile Card Layout */}
              <div className="md:hidden space-y-2 p-2">
                {filtered.map((item) => {
                  const card = item.card
                  const marketPrice = getEffectivePrice(card, item.variant)
                  const totalVal = marketPrice * item.quantity
                  const buyTotal = (item.purchase_price || 0) * item.quantity
                  const pnl = item.purchase_price ? totalVal - buyTotal : null

                  const badges = []
                  if (item.lang) badges.push({ label: item.lang.toUpperCase(), variant: item.lang === 'de' ? 'yellow' : 'blue' })
                  if (item.grade && item.grade !== 'raw') badges.push({ label: item.grade, variant: 'gold' })
                  if (item.variant) badges.push({ label: item.variant, variant: 'purple' })
                  if (item.condition) badges.push({ label: item.condition, variant: item.condition === 'Mint' ? 'green' : item.condition === 'NM' ? 'blue' : 'yellow' })
                  if (item.quantity > 1) badges.push({ label: `×${item.quantity}`, variant: 'red' })
                  if (card?.is_custom) badges.push({ label: '✏️', variant: 'yellow' })

                  return (
                    <CardListItem
                      key={item.id}
                      image={card?.images_small}
                      name={card?.name}
                      subtext={[card?.set_ref?.name, card?.number ? `#${card.number}` : null].filter(Boolean).join(' · ') || '-'}
                      badges={badges}
                      value={marketPrice > 0 ? formatPrice(marketPrice) : '-'}
                      valueSecondary={pnl !== null ? `${pnl >= 0 ? '+' : ''}${formatPrice(pnl)}` : undefined}
                      onClick={() => setEditingCollectionItem(item)}
                    />
                  )
                })}
                <div className="border-t border-border pt-2 px-1 flex items-center justify-between text-sm">
                  <span className="text-text-muted">{filtered.length} {t('collection.filtered')}</span>
                  <span className="font-bold text-green">{formatPrice(totalValue)}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ─── CollectionEditModal ──────────────────────────────────── */}
      {editingCollectionItem && (
        <CollectionEditModal
          item={editingCollectionItem}
          onClose={() => {
            setEditingCollectionItem(null)
            if (editingCollectionItem.card?.is_custom) {
              // If custom card, also allow editing the card itself
            }
          }}
        />
      )}

      {editCard && (
        <CustomCardModal
          editCard={editCard}
          onClose={() => setEditCard(null)}
          onCreated={() => {
            setEditCard(null)
            queryClient.invalidateQueries({ queryKey: ['collection'] })
            queryClient.invalidateQueries({ queryKey: ['dashboard'] })
          }}
          sets={allSets}
        />
      )}

      {showCustomModal && (
        <CustomCardModal
          onClose={() => setShowCustomModal(false)}
          onCreated={() => { setShowCustomModal(false) }}
          sets={allSets}
          autoAddCollection={true}
        />
      )}
    </div>
  )
}
