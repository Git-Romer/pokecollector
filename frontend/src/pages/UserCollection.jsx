import { useState, useMemo, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Search, SlidersHorizontal, X } from 'lucide-react'
import { getUserCollection } from '../api/client'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { CardModal } from '../components/CardItem'
import { getEffectiveCardPrice } from '../utils/prices'
import { TCGDEX_LANGUAGES, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { textIncludes } from '../utils/textSearch'
import { CardDisplay, CardLegend, withCollectionItemState } from '../components/card-system'
import { useDynamicFilterUrlState } from '../hooks/useDynamicFilterUrlState'
import PrintingDetailBadges from '../components/PrintingDetailBadges'

const USER_COLLECTION_FILTER_DEFINITIONS = {
  filterRarity: { param: 'rarity', default: '' },
  filterVariant: { param: 'variant', default: '' },
  filterLang: { param: 'lang', default: '' },
}

export default function UserCollection() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const { t, formatPrice, pricePrimaryField } = useSettings()
  const [selectedCard, setSelectedCard] = useState(null)
  const [searchText, setSearchText] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [sortBy, setSortBy] = useState('name')
  const [sortOrder, setSortOrder] = useState('asc')
  const {
    filters,
    updateFilter,
    replaceFilters,
    clearFilters,
  } = useDynamicFilterUrlState(USER_COLLECTION_FILTER_DEFINITIONS)
  const { filterRarity, filterVariant, filterLang } = filters

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['user-collection', userId, pricePrimaryField],
    queryFn: () => getUserCollection(userId, { price_field: pricePrimaryField }),
  })

  const rarities = useMemo(() => {
    const all = new Set()
    items.forEach(item => { if (item.card?.rarity) all.add(item.card.rarity) })
    return [...all].sort()
  }, [items])

  const visibleLanguages = useMemo(() => {
    const codes = new Set(items.map(item => item.lang || item.card?.lang).filter(Boolean))
    return TCGDEX_LANGUAGES.filter(language => codes.has(language.code))
  }, [items])

  const visibleLanguageCodes = useMemo(() => visibleLanguages.map(language => language.code), [visibleLanguages])
  const hasMixedLanguages = visibleLanguageCodes.length > 1

  useEffect(() => {
    if (!isLoading && filterLang && !visibleLanguageCodes.includes(filterLang)) {
      replaceFilters({
        ...filters,
        filterLang: '',
      })
    }
  }, [filterLang, filters, isLoading, replaceFilters, visibleLanguageCodes])

  const variants = useMemo(() => {
    const all = new Set()
    items.forEach(item => { if (item.variant) all.add(item.variant) })
    return [...all].sort()
  }, [items])

  const hasActiveFilters = filterRarity || filterVariant || filterLang

  const filtered = useMemo(() => {
    let result = items.filter(item => {
      const card = item.card
      if (!card) return false
      if (searchText && !textIncludes(card.name, searchText)) return false
      if (filterRarity && card.rarity !== filterRarity) return false
      if (filterVariant && item.variant !== filterVariant) return false
      if (filterLang && item.lang !== filterLang) return false
      return true
    })

    result.sort((a, b) => {
      let valA, valB
      switch (sortBy) {
        case 'name': valA = a.card?.name || ''; valB = b.card?.name || ''; break
        case 'price': valA = getEffectiveCardPrice(a.card, a.variant, pricePrimaryField); valB = getEffectiveCardPrice(b.card, b.variant, pricePrimaryField); break
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
  }, [items, searchText, filterRarity, filterVariant, filterLang, sortBy, sortOrder, pricePrimaryField])

  const totalValue = filtered.reduce((sum, item) => sum + getEffectiveCardPrice(item.card, item.variant, pricePrimaryField) * item.quantity, 0)
  const totalCards = filtered.reduce((sum, item) => sum + item.quantity, 0)

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
            onClick={() => setShowFilters(current => !current)}
            aria-label={t('common.filter')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
              hasActiveFilters
                ? 'bg-brand-red/10 border-brand-red/50 text-brand-red'
                : 'border-border text-text-muted hover:text-text-primary'
            }`}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>

        {/* Filters + Sort */}
        {showFilters && (
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label htmlFor="public-collection-filter-rarity" className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
              <select id="public-collection-filter-rarity" className="select py-1.5 text-sm" value={filterRarity} onChange={e => updateFilter('filterRarity', e.target.value)}>
                <option value="">{t('common.allRarities')}</option>
                {rarities.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="public-collection-filter-variant" className="text-xs text-text-muted mb-1 block">{t('card.variant')}</label>
              <select id="public-collection-filter-variant" className="select py-1.5 text-sm" value={filterVariant} onChange={e => updateFilter('filterVariant', e.target.value)}>
                <option value="">{t('variants.allVariants')}</option>
                {variants.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="public-collection-filter-language" className="text-xs text-text-muted mb-1 block">{t('lang.filter')}</label>
              <TcgdexLanguageSelect
                id="public-collection-filter-language"
                value={filterLang || 'all'}
                includeAll
                allLabel={t('lang.all')}
                compact
                languages={visibleLanguages}
                onChange={(value) => updateFilter('filterLang', value === 'all' ? '' : value)}
                className="select py-1.5 text-sm"
              />
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
                  aria-label={sortOrder === 'asc' ? t('common.sortDescending') : t('common.sortAscending')}
                  className="btn-ghost px-2 py-1.5 text-xs"
                >
                  {sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>
            <div className="col-span-2 sm:col-span-4 flex justify-start border-t border-border pt-3">
              <button type="button" className="btn-ghost" onClick={clearFilters}>
                <X size={14} /> {t('common.clear')}
              </button>
            </div>
          </div>
        )}
      </div>

      {items.length > 0 && (
        <CardLegend
          legendProps={{
            showWishlist: false,
          }}
        />
      )}

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
            const imgSrc = resolveCardImageUrl(card)
            const price = getEffectiveCardPrice(card, item.variant, pricePrimaryField)
            return (
              <CardDisplay
                key={item.id}
                card={card}
                image={imgSrc}
                price={price > 0 ? formatPrice(price) : null}
                languageLabel={hasMixedLanguages && (item.lang || card.lang)
                  ? tcgdexLanguageLabel(item.lang || card.lang)
                  : null}
                captionAccessory={<PrintingDetailBadges details={item.printing_details} limit={1} />}
                variantEffectSource={item.variant}
                stateIndicatorProps={{
                  card: withCollectionItemState(card, item),
                  alwaysShowQuantity: true,
                  showWishlist: false,
                }}
                onClick={() => setSelectedCard(card)}
              />
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
