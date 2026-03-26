import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Search, SlidersHorizontal, X } from 'lucide-react'
import { getUserCollection } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { CardModal } from '../components/CardItem'

const HOLO_VARIANTS = new Set(['Holo', 'Holo Rare', 'Holo V', 'Holo VMAX', 'Holo VSTAR', 'Holo ex', 'Reverse Holo'])

function getPrice(card, variant) {
  if (HOLO_VARIANTS.has(variant) && card?.price_market_holo != null) {
    return card.price_market_holo
  }
  return card?.price_market || 0
}

export default function UserCollection() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const { t, formatPrice } = useSettings()
  const [selectedCard, setSelectedCard] = useState(null)
  const [searchText, setSearchText] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterRarity, setFilterRarity] = useState('')
  const [filterVariant, setFilterVariant] = useState('')
  const [filterLang, setFilterLang] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [sortOrder, setSortOrder] = useState('asc')

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['user-collection', userId],
    queryFn: () => getUserCollection(userId),
  })

  const rarities = useMemo(() => {
    const all = new Set()
    items.forEach(item => { if (item.card?.rarity) all.add(item.card.rarity) })
    return [...all].sort()
  }, [items])

  const variants = useMemo(() => {
    const all = new Set()
    items.forEach(item => { if (item.variant) all.add(item.variant) })
    return [...all].sort()
  }, [items])

  const hasActiveFilters = searchText || filterRarity || filterVariant || filterLang

  const filtered = useMemo(() => {
    let result = items.filter(item => {
      const card = item.card
      if (!card) return false
      if (searchText && !card.name?.toLowerCase().includes(searchText.toLowerCase())) return false
      if (filterRarity && card.rarity !== filterRarity) return false
      if (filterVariant && item.variant !== filterVariant) return false
      if (filterLang && item.lang !== filterLang) return false
      return true
    })

    result.sort((a, b) => {
      let valA, valB
      switch (sortBy) {
        case 'name': valA = a.card?.name || ''; valB = b.card?.name || ''; break
        case 'price': valA = getPrice(a.card, a.variant); valB = getPrice(b.card, b.variant); break
        case 'quantity': valA = a.quantity; valB = b.quantity; break
        case 'rarity': valA = a.card?.rarity || ''; valB = b.card?.rarity || ''; break
        default: valA = a.card?.name || ''; valB = b.card?.name || ''
      }
      if (typeof valA === 'string') {
        return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA)
      }
      return sortOrder === 'asc' ? valA - valB : valB - valA
    })

    return result
  }, [items, searchText, filterRarity, filterVariant, filterLang, sortBy, sortOrder])

  const totalValue = filtered.reduce((sum, item) => sum + getPrice(item.card, item.variant) * item.quantity, 0)
  const totalCards = filtered.reduce((sum, item) => sum + item.quantity, 0)

  const resetFilters = () => {
    setSearchText(''); setFilterRarity(''); setFilterVariant(''); setFilterLang('')
  }

  return (
    <div className="page-container">
      <div className="card">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-text-muted hover:text-text-primary">
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-text-primary">{t('collection.userCollection')}</h1>
            <p className="text-sm text-text-secondary">
              {totalCards} {t('collection.cards')} · {formatPrice(totalValue)}
            </p>
          </div>
        </div>

        {/* Search + Filter toggle */}
        <div className="flex gap-2 mt-3">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder={t('collection.searchCards')}
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="input pl-9 w-full text-sm"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
              hasActiveFilters
                ? 'bg-brand-red/10 border-brand-red/50 text-brand-red'
                : 'border-border text-text-muted hover:text-text-primary'
            }`}
          >
            <SlidersHorizontal size={14} />
          </button>
          {hasActiveFilters && (
            <button onClick={resetFilters} className="btn-ghost text-xs">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Filters + Sort */}
        {showFilters && (
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
              <select className="select py-1.5 text-sm" value={filterRarity} onChange={e => setFilterRarity(e.target.value)}>
                <option value="">{t('common.allRarities')}</option>
                {rarities.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('card.variant')}</label>
              <select className="select py-1.5 text-sm" value={filterVariant} onChange={e => setFilterVariant(e.target.value)}>
                <option value="">{t('variants.allVariants')}</option>
                {variants.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('lang.filter')}</label>
              <select className="select py-1.5 text-sm" value={filterLang} onChange={e => setFilterLang(e.target.value)}>
                <option value="">{t('lang.all')}</option>
                <option value="de">DE</option>
                <option value="en">EN</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('cardSearch.sortBy')}</label>
              <div className="flex gap-1">
                <select className="select py-1.5 text-sm flex-1" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  <option value="name">{t('cardSearch.sortName')}</option>
                  <option value="price">{t('collection.totalValue')}</option>
                  <option value="quantity">{t('collection.quantity')}</option>
                  <option value="rarity">{t('common.rarity')}</option>
                </select>
                <button
                  onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')}
                  className="btn-ghost px-2 py-1.5 text-xs"
                >
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {[...Array(12)].map((_, i) => <div key={i} className="skeleton aspect-[2.5/3.5] rounded-xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-12 text-text-muted">{t('collection.empty')}</div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {filtered.map((item) => {
            const card = item.card
            if (!card) return null
            const imgSrc = card.images_small || resolveCardImageUrl(card) || (card.image ? `${card.image}/low.webp` : null)
            const price = getPrice(card, item.variant)
            return (
              <div
                key={item.id}
                className="cursor-pointer group"
                onClick={() => setSelectedCard(card)}
              >
                <div className="aspect-[2.5/3.5] rounded-xl overflow-hidden ring-1 ring-white/5 group-hover:ring-brand-red/30 transition-all">
                  {imgSrc ? (
                    <img src={imgSrc} alt={card.name} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full bg-bg-surface flex items-center justify-center text-[9px] text-text-muted p-1 text-center">
                      {card.name}
                    </div>
                  )}
                </div>
                <div className="mt-1 px-0.5">
                  <p className="text-[10px] font-semibold text-text-primary truncate">{card.name}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-text-muted">{item.quantity}x · {item.variant || 'Normal'}</span>
                    {price > 0 && (
                      <span className="text-[9px] font-bold text-green">{formatPrice(price)}</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedCard && (
        <CardModal
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
        />
      )}
    </div>
  )
}
