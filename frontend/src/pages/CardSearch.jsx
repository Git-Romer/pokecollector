import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, SortAsc, Hash, PenLine, SlidersHorizontal, Camera } from 'lucide-react'
import { searchCards, getSets, getCustomCards } from '../api/client'
import { CardItem, CustomCardModal, CardModal } from '../components/CardItem'
import { useSettings } from '../contexts/SettingsContext'
import Sheet from '../components/ui/Sheet'
import CardScanner from '../components/CardScanner'
import { useTilt } from '../hooks/useTilt'

function TiltCardWrapper({ children, className, onClick }) {
  const { ref, onMouseMove, onMouseEnter, onMouseLeave } = useTilt(12)
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

const CODE_NUMBER_RE = /^([A-Za-z]+\d*)\s+(\d+)$/

const TYPES = ['Fire', 'Water', 'Grass', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless', 'Fairy', 'Stellar']
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Rare Ultra', 'Rare Secret', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Double Rare', 'ACE SPEC Rare', 'Promo', 'Amazing Rare']

function FilterForm({ filters, setFilter, allSeries, setsForSeries, toggleSortOrder, t }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <SortAsc size={14} className="text-text-muted flex-shrink-0" />
          <span className="text-xs text-text-muted">{t('cardSearch.sortBy')}:</span>
          <select
            className="select text-sm py-1.5 w-36"
            value={filters.sort_by}
            onChange={(e) => { setFilter('sort_by', e.target.value) }}
          >
            <option value="">—</option>
            <option value="name">{t('cardSearch.sortName')}</option>
            <option value="number">{t('cardSearch.sortNumber')}</option>
            <option value="rarity">{t('cardSearch.sortRarity')}</option>
          </select>
          {filters.sort_by && (
            <button
              onClick={toggleSortOrder}
              className="btn-ghost py-1.5 px-2 text-sm"
            >
              {filters.sort_order === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('common.type')}</label>
          <select className="select" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">{t('common.allTypes')}</option>
            {TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
          <select className="select" value={filters.rarity} onChange={(e) => setFilter('rarity', e.target.value)}>
            <option value="">{t('common.allRarities')}</option>
            {RARITIES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('cardSearch.series')}</label>
          <select className="select" value={filters.series} onChange={(e) => setFilter('series', e.target.value)}>
            <option value="">{t('cardSearch.allSeries')}</option>
            {allSeries.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('common.set')}</label>
          <select className="select" value={filters.set_id} onChange={(e) => setFilter('set_id', e.target.value)}>
            <option value="">{t('common.set_id_hint')}</option>
            {setsForSeries.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('cardSearch.artist')}</label>
          <input type="text" placeholder={t('cardSearch.artist')} value={filters.artist}
            onChange={(e) => setFilter('artist', e.target.value)} className="input text-sm" />
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('cardSearch.hpMin')}</label>
          <input type="number" min="0" max="999" placeholder="0" value={filters.hp_min}
            onChange={(e) => setFilter('hp_min', e.target.value)} className="input text-sm" />
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1 block">{t('cardSearch.hpMax')}</label>
          <input type="number" min="0" max="999" placeholder="999" value={filters.hp_max}
            onChange={(e) => setFilter('hp_max', e.target.value)} className="input text-sm" />
        </div>
      </div>
    </div>
  )
}

export default function CardSearch() {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const [filters, setFilters] = useState({
    name: '', type: '', rarity: '', set_id: '', series: '', artist: '',
    hp_min: '', hp_max: '', sort_by: '', sort_order: 'asc',
  })
  const [langFilter, setLangFilter] = useState('all') // 'de' | 'en' | 'all'
  const [page, setPage] = useState(1)
  const [showFilters, setShowFilters] = useState(false)
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const pageSize = 20

  const { data: recentCustomCards = [] } = useQuery({
    queryKey: ['custom-cards'],
    queryFn: () => getCustomCards().then(r => r.data),
  })

  const { data: allSets = [] } = useQuery({
    queryKey: ['sets'],
    queryFn: () => getSets().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const allSeries = useMemo(() => [...new Set(allSets.map(s => s.series).filter(Boolean))].sort(), [allSets])
  const setsForSeries = useMemo(() => {
    if (!filters.series) return allSets
    return allSets.filter(s => s.series === filters.series)
  }, [allSets, filters.series])

  const setMap = useMemo(() => {
    // Keyed by both tcg_set_id (e.g. "sv1") and composite id (e.g. "sv1_de") so
    // card.set_id (which stores the TCGdex set ID) resolves to the correct set object.
    const map = {}
    allSets.forEach(s => {
      if (s.tcg_set_id) map[s.tcg_set_id] = s
      if (s.id) map[s.id] = s
    })
    return map
  }, [allSets])

  const queryParams = {
    name: filters.name || undefined,
    type: filters.type || undefined,
    rarity: filters.rarity || undefined,
    set_id: filters.set_id || undefined,
    artist: filters.artist || undefined,
    hp_min: filters.hp_min ? parseInt(filters.hp_min) : undefined,
    hp_max: filters.hp_max ? parseInt(filters.hp_max) : undefined,
    sort_by: filters.sort_by || undefined,
    sort_order: filters.sort_order || 'asc',
    lang: langFilter,
    page,
    page_size: pageSize,
  }

  const hasQuery = filters.name || filters.type || filters.rarity || filters.set_id || filters.artist || filters.hp_min || filters.hp_max || filters.series

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['card-search', queryParams, langFilter],
    queryFn: () => searchCards(queryParams).then(r => r.data),
    enabled: !!hasQuery || langFilter !== 'all',
    placeholderData: (prev) => prev,
  })

  const isCodeNumberSearch = CODE_NUMBER_RE.test(searchInput.trim())

  const handleSearch = (e) => {
    e.preventDefault()
    setFilters(prev => ({ ...prev, name: searchInput }))
    setPage(1)
  }

  const setFilter = (key, value) => {
    setFilters(prev => {
      const next = { ...prev, [key]: value }
      if (key === 'series') {
        const setStillValid = !value || allSets.find(s => s.id === prev.set_id && s.series === value)
        if (!setStillValid) next.set_id = ''
      }
      return next
    })
    setPage(1)
  }

  const toggleSortOrder = () => {
    setFilters(prev => ({ ...prev, sort_order: prev.sort_order === 'asc' ? 'desc' : 'asc' }))
    setPage(1)
  }

  const clearFilters = () => {
    setFilters({ name: '', type: '', rarity: '', set_id: '', series: '', artist: '', hp_min: '', hp_max: '', sort_by: '', sort_order: 'asc' })
    setSearchInput('')
    setLangFilter('all')
    setPage(1)
  }

  const hasActiveFilters = !!(filters.type || filters.rarity || filters.set_id || filters.series || filters.artist || filters.hp_min || filters.hp_max || filters.sort_by)
  const activeFilterCount = [filters.type, filters.rarity, filters.set_id, filters.series, filters.artist, filters.hp_min, filters.hp_max, filters.sort_by].filter(Boolean).length
  const totalPages = data ? Math.ceil(data.total_count / pageSize) : 0

  const handleCustomCreated = () => {
    queryClient.invalidateQueries({ queryKey: ['custom-cards'] })
  }

  const matchedCustomCards = useMemo(() => {
    const searchTerm = filters.name.trim()
    if (!searchTerm) return []

    const lowerSearchTerm = searchTerm.toLowerCase()
    const codeMatch = CODE_NUMBER_RE.exec(searchTerm)

    return recentCustomCards.filter((card) => {
      if (card.name.toLowerCase().includes(lowerSearchTerm)) {
        return true
      }

      if (!codeMatch) {
        return false
      }

      const [, rawSetCode, rawNumber] = codeMatch
      const normalizedSetCode = rawSetCode.toLowerCase()
      const normalizedNumber = String(parseInt(rawNumber, 10))
      const matchingSet = allSets.find((set) => (
        set.tcg_set_id?.toLowerCase() === card.set_id?.toLowerCase() ||
        set.id?.toLowerCase() === card.set_id?.toLowerCase()
      ))
      const setMatches = [
        card.set_id,
        matchingSet?.abbreviation,
        matchingSet?.tcg_set_id,
        matchingSet?.id,
      ].some((value) => value?.toLowerCase() === normalizedSetCode)
      const cardNumber = card.number ?? ''
      const numberMatches = (
        cardNumber === rawNumber ||
        (cardNumber.replace(/^0+/, '') || '0') === normalizedNumber
      )

      return setMatches && numberMatches
    })
  }, [allSets, filters.name, recentCustomCards])

  const filterFormProps = { filters, setFilter, allSeries, setsForSeries, toggleSortOrder, t }

  return (
    <div className="space-y-4 pb-2">

      {/* ─── Header ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{t('cardSearch.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('cardSearch.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowScanner(true)}
            className="w-10 h-10 rounded-xl flex items-center justify-center transition-colors"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            title={t('scanner.title')}
          >
            <Camera size={18} className="text-text-muted" />
          </button>
          <button
            onClick={() => setShowCustomModal(true)}
            className="btn-ghost text-sm border-yellow/30 text-yellow hover:bg-yellow/10"
          >
            <PenLine size={14} />
            {t('cardSearch.createCustomCard')}
          </button>
        </div>
      </div>

      {/* ─── Language Filter ──────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-muted">{t('lang.filter')}:</span>
        {[
          { value: 'all', label: t('lang.all') },
          { value: 'de', label: `🇩🇪 ${t('lang.de')}` },
          { value: 'en', label: `🇬🇧 ${t('lang.en')}` },
        ].map(opt => (
          <button
            key={opt.value}
            onClick={() => { setLangFilter(opt.value); setPage(1) }}
            className={`px-3 py-1 rounded-lg text-xs font-bold transition-colors ${
              langFilter === opt.value
                ? opt.value === 'de'
                  ? 'bg-yellow/20 text-yellow border border-yellow/50'
                  : opt.value === 'en'
                    ? 'bg-blue/20 text-blue-400 border border-blue-400/50'
                    : 'bg-brand-red text-white'
                : 'bg-bg-card text-text-secondary hover:text-text-primary border border-border'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* ─── Search Bar + Filter Button ───────────────────────────── */}
      <div className="card">
        <form onSubmit={handleSearch} className="flex gap-2">
          {/* Search input */}
          <div className="flex-1 min-w-0 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="text"
              placeholder={t('cardSearch.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="input pl-9 pr-4"
            />
            {isCodeNumberSearch && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-1 text-xs text-yellow pointer-events-none">
                <Hash size={12} />
                <span>{t('cardSearch.setCodeSearch')}</span>
              </div>
            )}
          </div>

          <button type="submit" className="btn-primary px-4 sm:px-6 flex-shrink-0">
            {t('common.search')}
          </button>

          {/* Filter button — shows active count */}
          <button
            type="button"
            onClick={() => setShowFilters(true)}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl border transition-colors text-sm font-medium
              ${hasActiveFilters
                ? 'bg-brand-red/10 border-brand-red/50 text-brand-red'
                : 'border-border text-text-muted hover:text-text-primary hover:border-border'
              }`}
          >
            <SlidersHorizontal size={16} />
            <span className="hidden sm:inline">
              {hasActiveFilters ? `${activeFilterCount} Filter` : t('cardSearch.filters')}
            </span>
            {hasActiveFilters && (
              <span className="sm:hidden bg-brand-red text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">
                {activeFilterCount}
              </span>
            )}
          </button>

          {hasQuery && (
            <button type="button" onClick={clearFilters} className="btn-ghost flex-shrink-0">
              <X size={16} />
              <span className="hidden sm:inline">{t('common.clear')}</span>
            </button>
          )}
        </form>
      </div>

      {/* ─── Filter Sheet ─────────────────────────────────────────── */}
      <Sheet isOpen={showFilters} onClose={() => setShowFilters(false)} title={t('cardSearch.filters')}>
        <div className="p-4 space-y-4">
          <FilterForm {...filterFormProps} />

          {hasActiveFilters && (
            <button
              onClick={() => { clearFilters(); setShowFilters(false) }}
              className="btn-ghost w-full justify-center"
            >
              <X size={14} /> {t('common.clear')}
            </button>
          )}
          <button
            onClick={() => setShowFilters(false)}
            className="btn-primary w-full justify-center"
          >
            {t('common.search')}
          </button>
        </div>
      </Sheet>

      {/* ─── Empty / loading / error states ──────────────────────── */}
      {!hasQuery && (
        <div className="text-center py-20">
          <div className="w-24 h-24 pokeball-bg mx-auto mb-4 opacity-20" />
          <p className="text-text-muted">{t('cardSearch.trySearch')}</p>
          <p className="text-xs text-text-muted mt-1">{t('cardSearch.trySearchHint')}</p>
        </div>
      )}

      {isLoading && hasQuery && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="card p-0">
              <div className="skeleton aspect-[2.5/3.5] rounded-xl mb-3" />
              <div className="p-3 space-y-2">
                <div className="skeleton h-4 rounded w-3/4" />
                <div className="skeleton h-3 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="card text-center py-8">
          <p className="text-brand-red">{t('cardSearch.searchFailed')}</p>
        </div>
      )}

      {matchedCustomCards.length > 0 && filters.name.trim() && (
        <div>
          <p className="text-xs text-yellow font-medium mb-2 flex items-center gap-1">
            <PenLine size={12} /> {t('cardSearch.customCard')}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {matchedCustomCards.map((card) => (
              <CardItem key={card.id} card={card} />
            ))}
          </div>
        </div>
      )}

      {data && !isLoading && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-text-secondary">
              {data.total_count?.toLocaleString()} {t('cardSearch.results')}
              {isFetching && <span className="ml-2 text-text-muted">{t('common.updating')}</span>}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn-ghost py-1.5 px-2 disabled:opacity-50">
                  <ChevronLeft size={16} />
                </button>
                <span className="text-sm text-text-secondary">{page} / {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="btn-ghost py-1.5 px-2 disabled:opacity-50">
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>

          {data.data?.length === 0 ? (
            <div className="text-center py-12 space-y-4">
              <p className="text-text-muted">{t('cardSearch.noCardsFound')}</p>
              <button onClick={() => setShowCustomModal(true)} className="btn-ghost border-yellow/30 text-yellow hover:bg-yellow/10 mx-auto">
                <PenLine size={14} /> {t('cardSearch.cardNotFound')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {data.data?.map((card) => {
                const imgSrc = card.images?.small || card.images_small || (card.image ? `${card.image}/low.webp` : null)
                const setObj = setMap[card.set_id] || null
                const cardSetName = card.set?.name || setObj?.abbreviation || setObj?.name || card.set_id || ''
                const cardDisplay = cardSetName + (card.number ? ` · #${card.number}` : '')
                return (
                  <TiltCardWrapper
                    key={card.id}
                    className="card-3d group relative"
                    onClick={() => setSelectedCard(card)}
                  >
                    <div className="aspect-[2.5/3.5] rounded-xl overflow-hidden bg-bg-elevated ring-1 ring-white/5 group-hover:ring-brand-red/40">
                      {imgSrc
                        ? <img src={imgSrc} alt={card.name} className="w-full h-full object-cover" loading="lazy" />
                        : <div className="w-full h-full flex flex-col items-center justify-center gap-1 p-2">
                            <span className="text-[10px] text-text-muted text-center leading-tight">{card.name}</span>
                          </div>
                      }
                    </div>
                    {card.rarity?.toLowerCase().includes('holo') && (
                      <div className="absolute inset-0 rounded-xl pointer-events-none card-holo" />
                    )}
                    <div className="mt-1.5 px-0.5">
                      <div className="flex items-center gap-1">
                        <p className="text-[11px] font-semibold text-text-primary truncate leading-tight flex-1">{card.name}</p>
                        {card._lang && langFilter === 'all' && (
                          <span className={`flex-shrink-0 text-[9px] font-black px-1 py-0.5 rounded leading-none ${
                            card._lang === 'de'
                              ? 'bg-yellow/20 text-yellow'
                              : 'bg-blue/20 text-blue-400'
                          }`}>
                            {card._lang.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-text-muted truncate">{cardDisplay}</p>
                    </div>
                  </TiltCardWrapper>
                )
              })}
            </div>
          )}
        </>
      )}

      {showCustomModal && (
        <CustomCardModal
          onClose={() => setShowCustomModal(false)}
          onCreated={handleCustomCreated}
          sets={allSets}
          autoAddCollection={false}
        />
      )}

      {selectedCard && (
        <CardModal
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
          defaultLang={selectedCard._lang || (langFilter === 'all' ? 'en' : langFilter)}
        />
      )}

      <CardScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onCardSelected={(card) => {
          setSearchInput(card.name)
          setFilters(prev => ({ ...prev, name: card.name }))
          setPage(1)
          setShowScanner(false)
        }}
      />
    </div>
  )
}
