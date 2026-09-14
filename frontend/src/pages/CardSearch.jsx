import { useState, useMemo, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Search, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, SortAsc, Hash, PenLine, SlidersHorizontal, Camera, CheckSquare, Plus, ScanLine, Tags } from 'lucide-react'
import toast from 'react-hot-toast'
import { searchCards, getSets, getCustomCards, bulkAddToCollection, getScanJobs } from '../api/client'
import { CardItem, CustomCardModal, CardModal } from '../components/CardItem'
import { useSettings } from '../contexts/SettingsContext'
import Sheet from '../components/ui/Sheet'
import CardScanner from '../components/UnifiedCardScanner'
import { getDefaultVariantOrNull } from '../utils/cardVariants'
import { cardNumberMatches } from '../utils/cardNumbers'
import { normalizeSearchText, textIncludes } from '../utils/textSearch'
import { useVisibleTcgdexLanguages } from '../hooks/useVisibleTcgdexLanguages'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'
import { normalizeTcgdexLanguage, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { CardDisplay, CardLegend } from '../components/card-system'
import {
  getLastCardSearchPage,
  isValidCardSearchPage,
  parseCardSearchPage,
  updateCardSearchParams,
} from '../utils/cardSearchUrlState'
import {
  SCAN_JOBS_QUERY_KEY,
  hasActiveScanJobs,
  scanAttentionCount,
} from '../utils/scanJobs'
import { useDynamicFilterUrlState } from '../hooks/useDynamicFilterUrlState'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import PrintingDetailSelector from '../components/PrintingDetailSelector'

export const CARD_CODE_NUMBER_RE = /^([A-Za-z][A-Za-z0-9]*)\s+(\d+)$/

const TYPES = ['Fire', 'Water', 'Grass', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless', 'Fairy', 'Stellar']
const CATEGORIES = ['Pokemon', 'Trainer', 'Energy']
const SUBTYPES = ['Basic', 'Stage1', 'Stage2', 'Supporter', 'Item', 'Stadium', 'Tool', 'Technical Machine', 'Special']
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Rare Ultra', 'Rare Secret', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Double Rare', 'ACE SPEC Rare', 'Promo', 'Amazing Rare']
const CARD_SEARCH_FILTER_DEFINITIONS = {
  category: { param: 'category', default: '' },
  type: { param: 'type', default: '' },
  subtype: { param: 'subtype', default: '' },
  rarity: { param: 'rarity', default: '' },
  series: { param: 'series', default: '' },
  set_id: { param: 'set_id', default: '' },
  artist: { param: 'artist', default: '' },
  rule_text: { param: 'rule_text', default: '' },
  hp_min: { param: 'hp_min', default: '' },
  hp_max: { param: 'hp_max', default: '' },
}
const CARD_SEARCH_TEXT_DEBOUNCE_MS = 300

function FilterForm({ filters, setFilter, allSeries, setsForSeries, showAdvanced, setShowAdvanced, t }) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-text-primary">{t('common.normalFilters')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label htmlFor="card-search-category" className="text-xs text-text-muted mb-1 block">{t('cardSearch.cardCategory')}</label>
          <select id="card-search-category" className="select" value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
            <option value="">{t('cardSearch.allCategories')}</option>
            {CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-energy-type" className="text-xs text-text-muted mb-1 block">{t('cardSearch.energyType')}</label>
          <select id="card-search-energy-type" className="select" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">{t('cardSearch.allEnergyTypes')}</option>
            {TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-rarity" className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
          <select id="card-search-rarity" className="select" value={filters.rarity} onChange={(e) => setFilter('rarity', e.target.value)}>
            <option value="">{t('common.allRarities')}</option>
            {RARITIES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-series" className="text-xs text-text-muted mb-1 block">{t('cardSearch.series')}</label>
          <select id="card-search-series" className="select" value={filters.series} onChange={(e) => setFilter('series', e.target.value)}>
            <option value="">{t('cardSearch.allSeries')}</option>
            {allSeries.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-set" className="text-xs text-text-muted mb-1 block">{t('common.set')}</label>
          <select id="card-search-set" className="select" value={filters.set_id} onChange={(e) => setFilter('set_id', e.target.value)}>
            <option value="">{t('common.set_id_hint')}</option>
            {setsForSeries.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <button
        type="button"
        className="btn-ghost w-full justify-between"
        aria-expanded={showAdvanced}
        aria-controls="card-search-advanced-filters"
        onClick={() => setShowAdvanced(value => !value)}
      >
        <span>{t('common.advancedFilters')}</span>
        <ChevronDown size={16} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
      </button>

      {showAdvanced && (
        <div id="card-search-advanced-filters" className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-border p-3">
          <div>
            <label htmlFor="card-search-subtype" className="text-xs text-text-muted mb-1 block">{t('cardSearch.subtype')}</label>
            <select id="card-search-subtype" className="select" value={filters.subtype} onChange={(e) => setFilter('subtype', e.target.value)}>
              <option value="">{t('cardSearch.allSubtypes')}</option>
              {SUBTYPES.map(subtype => <option key={subtype} value={subtype}>{subtype}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="card-search-artist" className="text-xs text-text-muted mb-1 block">{t('cardSearch.artist')}</label>
            <input id="card-search-artist" type="text" value={filters.artist}
              onChange={(e) => setFilter('artist', e.target.value)} className="input text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="card-search-rule-text" className="text-xs text-text-muted mb-1 block">{t('cardSearch.ruleText')}</label>
            <input id="card-search-rule-text" type="text" value={filters.rule_text}
              onChange={(e) => setFilter('rule_text', e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label htmlFor="card-search-hp-min" className="text-xs text-text-muted mb-1 block">{t('cardSearch.hpMin')}</label>
            <input id="card-search-hp-min" type="number" min="0" max="999" placeholder="0" value={filters.hp_min}
              onChange={(e) => setFilter('hp_min', e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label htmlFor="card-search-hp-max" className="text-xs text-text-muted mb-1 block">{t('cardSearch.hpMax')}</label>
            <input id="card-search-hp-max" type="number" min="0" max="999" placeholder="999" value={filters.hp_max}
              onChange={(e) => setFilter('hp_max', e.target.value)} className="input text-sm" />
          </div>
        </div>
      )}
    </div>
  )
}

export function buildCardSearchParams(filters, langFilter, page, pageSize) {
  return {
    q: filters.name || undefined,
    category: filters.category || undefined,
    type: filters.type || undefined,
    subtype: filters.subtype || undefined,
    rarity: filters.rarity || undefined,
    set_id: filters.set_id || undefined,
    artist: filters.artist || undefined,
    rule_text: filters.rule_text.trim() || undefined,
    hp_min: filters.hp_min ? parseInt(filters.hp_min, 10) : undefined,
    hp_max: filters.hp_max ? parseInt(filters.hp_max, 10) : undefined,
    sort_by: filters.sort_by || undefined,
    sort_order: filters.sort_order,
    lang: langFilter,
    page,
    page_size: pageSize,
  }
}

export default function CardSearch() {
  const { t, settings, formatPrice } = useSettings()
  const visibleLanguages = useVisibleTcgdexLanguages()
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search])
  const [searchInput, setSearchInput] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedCardTab, setSelectedCardTab] = useState('add')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedItems, setSelectedItems] = useState(new Map()) // card.id -> { card_id, lang }
  const [bulkPrintingDetails, setBulkPrintingDetails] = useState([])
  const [showBulkPrintingDetails, setShowBulkPrintingDetails] = useState(false)
  const pageSize = 20

  const { data: recentCustomCards = [] } = useQuery({
    queryKey: ['custom-cards'],
    queryFn: () => getCustomCards().then(r => r.data),
  })

  const { data: scanData } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })
  const scanJobs = scanData?.jobs || []
  const scanAttention = scanAttentionCount(scanJobs)
  const scansActive = hasActiveScanJobs(scanJobs)

  const { data: allSets = [] } = useQuery({
    queryKey: ['sets', settings.language || 'en'],
    queryFn: () => getSets().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const allSeries = useMemo(() => [...new Set(allSets.map(s => s.series).filter(Boolean))].sort(), [allSets])
  const visibleLanguageCodes = useMemo(() => visibleLanguages.map(language => language.code), [visibleLanguages])
  const preferredCatalogueLanguage = normalizeTcgdexLanguage(settings.language || 'en', 'en')
  const defaultLangFilter = visibleLanguageCodes.includes(preferredCatalogueLanguage)
    ? preferredCatalogueLanguage
    : 'all'

  // Search state is deliberately derived from the URL. This makes direct links,
  // refreshes, and browser history reproduce precisely the same search.
  const { filters, langFilter, page } = useMemo(() => {
    const read = (key) => {
      const value = searchParams.get(key)
      return key === 'rule_text' ? value || '' : value?.trim() || ''
    }
    const enumValue = (key, values) => {
      const value = read(key)
      return values.includes(value) ? value : ''
    }
    const hpValue = (key) => {
      const value = read(key)
      return /^\d+$/.test(value) && Number(value) <= 999 ? value : ''
    }
    const selectedSeries = read('series')
    const selectedSet = read('set_id')
    const setIsValid = !selectedSet || !selectedSeries || !allSets.length || allSets.some((set) => set.id === selectedSet && set.series === selectedSeries)
    const requestedLanguage = read('lang')
    const language = requestedLanguage === 'all'
      ? 'all'
      : requestedLanguage && visibleLanguageCodes.includes(normalizeTcgdexLanguage(requestedLanguage, ''))
        ? normalizeTcgdexLanguage(requestedLanguage, '')
        : defaultLangFilter
    return {
      filters: {
        name: read('q'),
        category: enumValue('category', CATEGORIES),
        type: enumValue('type', TYPES),
        subtype: enumValue('subtype', SUBTYPES),
        rarity: enumValue('rarity', RARITIES),
        series: selectedSeries,
        set_id: setIsValid ? selectedSet : '',
        artist: read('artist'),
        rule_text: read('rule_text'),
        hp_min: hpValue('hp_min'),
        hp_max: hpValue('hp_max'),
        sort_by: enumValue('sort_by', ['name', 'number', 'rarity']),
        sort_order: read('sort_order') === 'desc' ? 'desc' : 'asc',
      },
      langFilter: language,
      page: parseCardSearchPage(read('page')),
    }
  }, [allSets, defaultLangFilter, searchParams, visibleLanguageCodes])

  const normalizePanelFilters = useCallback((state) => {
    const hpValue = (value) => /^\d+$/.test(value) && Number(value) <= 999 ? value : ''
    const setIsValid = !state.set_id || !state.series || !allSets.length || allSets.some(
      set => set.id === state.set_id && set.series === state.series,
    )
    return {
      ...state,
      category: CATEGORIES.includes(state.category) ? state.category : '',
      type: TYPES.includes(state.type) ? state.type : '',
      subtype: SUBTYPES.includes(state.subtype) ? state.subtype : '',
      rarity: RARITIES.includes(state.rarity) ? state.rarity : '',
      set_id: setIsValid ? state.set_id : '',
      hp_min: state.hp_min ? hpValue(state.hp_min) : '',
      hp_max: state.hp_max ? hpValue(state.hp_max) : '',
    }
  }, [allSets])
  const {
    filters: dynamicFilters,
    updateFilter: updateDynamicFilter,
    replaceFilters: replaceDynamicFilters,
    clearFilters: clearDynamicFilters,
  } = useDynamicFilterUrlState(CARD_SEARCH_FILTER_DEFINITIONS, {
    normalizeState: normalizePanelFilters,
    resetParams: ['page'],
  })
  const setsForSeries = useMemo(() => {
    if (!dynamicFilters.series) return allSets
    return allSets.filter(set => set.series === dynamicFilters.series)
  }, [allSets, dynamicFilters.series])

  const updateSearchParams = useCallback((updates, { replace = false, resetPage = true } = {}) => {
    const next = updateCardSearchParams(location.search, updates, { resetPage })
    const search = next.toString()
    if (search === searchParams.toString()) return
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : '' },
      { replace },
    )
  }, [location.pathname, location.search, navigate, searchParams])

  const debouncedArtist = useDebouncedValue(dynamicFilters.artist, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const debouncedRuleText = useDebouncedValue(dynamicFilters.rule_text, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const debouncedHpMin = useDebouncedValue(dynamicFilters.hp_min, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const debouncedHpMax = useDebouncedValue(dynamicFilters.hp_max, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const queryFilters = {
    ...filters,
    ...dynamicFilters,
    artist: debouncedArtist,
    rule_text: debouncedRuleText,
    hp_min: debouncedHpMin,
    hp_max: debouncedHpMax,
  }
  const queryParams = buildCardSearchParams(queryFilters, langFilter, page, pageSize)

  const hasQuery = filters.name || queryFilters.category || queryFilters.type || queryFilters.subtype || queryFilters.rarity || queryFilters.set_id || queryFilters.artist || queryFilters.rule_text.trim() || queryFilters.hp_min || queryFilters.hp_max || queryFilters.series

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['card-search', queryParams],
    queryFn: () => searchCards(queryParams).then(r => r.data),
    enabled: !!hasQuery,
    placeholderData: (prev) => prev,
  })

  const totalPages = data ? getLastCardSearchPage(data.total_count, pageSize) : 0
  const hasUrlSearchState = Array.from(searchParams.keys()).length > 0
  const hasActiveFilters = Boolean(
    dynamicFilters.category || dynamicFilters.type || dynamicFilters.subtype || dynamicFilters.rarity ||
    dynamicFilters.set_id || dynamicFilters.series || dynamicFilters.artist || dynamicFilters.rule_text.trim() || dynamicFilters.hp_min ||
    dynamicFilters.hp_max
  )
  const activeFilterCount = [
    dynamicFilters.category, dynamicFilters.type, dynamicFilters.subtype, dynamicFilters.rarity,
    dynamicFilters.set_id, dynamicFilters.series, dynamicFilters.artist, dynamicFilters.rule_text.trim(), dynamicFilters.hp_min,
    dynamicFilters.hp_max,
  ].filter(Boolean).length
  const isCodeNumberSearch = CARD_CODE_NUMBER_RE.test(searchInput.trim())

  const handleSearch = (e) => {
    e.preventDefault()
    updateSearchParams({ q: searchInput })
  }

  const setDynamicFilter = (key, value) => {
    if (key === 'series') {
      replaceDynamicFilters(current => {
        const next = { ...current, [key]: value }
        const setStillValid = !value || allSets.some(set => set.id === current.set_id && set.series === value)
        if (!setStillValid) next.set_id = ''
        return next
      })
      return
    }
    updateDynamicFilter(key, value)
  }

  const openFilters = () => {
    setShowAdvancedFilters(Boolean(dynamicFilters.subtype || dynamicFilters.artist || dynamicFilters.rule_text.trim() || dynamicFilters.hp_min || dynamicFilters.hp_max))
    setShowFilters(true)
  }

  const clearFilters = () => {
    clearDynamicFilters()
    setShowAdvancedFilters(false)
  }

  const clearSearch = () => navigate({ pathname: location.pathname, search: '' })

  const hasOpenOverlay = Boolean(selectedCard || showFilters || showCustomModal || showScanner)

  useEffect(() => {
    setSearchInput(filters.name)
  }, [filters.name])

  useEffect(() => {
    // Browser history can move away and back before React commits the
    // intermediate location. Read the URL at the popstate boundary so the
    // editable draft never remains attached to a different search entry.
    const syncSearchInputFromHistory = () => {
      setSearchInput(new URLSearchParams(window.location.search).get('q')?.trim() || '')
    }
    window.addEventListener('popstate', syncSearchInputFromHistory)
    return () => window.removeEventListener('popstate', syncSearchInputFromHistory)
  }, [])

  useEffect(() => {
    const rawPage = searchParams.get('page')
    if (!rawPage || isValidCardSearchPage(rawPage)) return
    updateSearchParams({ page: '' }, { replace: true, resetPage: false })
  }, [searchParams, updateSearchParams])

  useEffect(() => {
    if (!data || isFetching || page <= totalPages) return
    updateSearchParams(
      { page: totalPages > 1 ? totalPages : '' },
      { replace: true, resetPage: false },
    )
  }, [data, isFetching, page, totalPages, updateSearchParams])

  useEffect(() => {
    // Once set data is available, remove a set that does not belong to its URL series.
    if (!allSets.length || !filters.series || !searchParams.get('set_id') || filters.set_id) return
    updateSearchParams({ set_id: '' }, { replace: true, resetPage: false })
  }, [allSets.length, filters.series, filters.set_id, searchParams, updateSearchParams])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.defaultPrevented || hasOpenOverlay || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

      const target = event.target
      const tagName = target?.tagName?.toLowerCase?.()
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable) {
        return
      }

      if (event.key === 'ArrowLeft' && page > 1) {
        updateSearchParams({ page: Math.max(1, page - 1) }, { resetPage: false })
        event.preventDefault()
      }
      if (event.key === 'ArrowRight' && totalPages > 0 && page < totalPages) {
        updateSearchParams({ page: Math.min(totalPages, page + 1) }, { resetPage: false })
        event.preventDefault()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [hasOpenOverlay, page, totalPages, updateSearchParams])

  const handleCustomCreated = () => {
    queryClient.invalidateQueries({ queryKey: ['custom-cards'] })
  }

  const matchedCustomCards = useMemo(() => {
    const searchTerm = filters.name.trim()
    if (!searchTerm) return []

    const normalizedSearchTerm = normalizeSearchText(searchTerm)
    const codeMatch = CARD_CODE_NUMBER_RE.exec(searchTerm)

    return recentCustomCards.filter((card) => {
      if (textIncludes(card.name, normalizedSearchTerm)) {
        return true
      }

      if (!codeMatch) {
        return false
      }

      const [, rawSetCode, rawNumber] = codeMatch
      const normalizedSetCode = normalizeSearchText(rawSetCode)
      const normalizedNumber = String(parseInt(rawNumber, 10))
      const matchingSet = allSets.find((set) => (
        normalizeSearchText(set.tcg_set_id) === normalizeSearchText(card.set_id) ||
        normalizeSearchText(set.id) === normalizeSearchText(card.set_id)
      ))
      const setMatches = [
        card.set_id,
        matchingSet?.abbreviation,
        matchingSet?.tcg_set_id,
        matchingSet?.id,
      ].some((value) => normalizeSearchText(value) === normalizedSetCode)
      return setMatches && cardNumberMatches(card.number, normalizedNumber)
    })
  }, [allSets, filters.name, recentCustomCards])

  const filterFormProps = {
    filters: dynamicFilters,
    setFilter: setDynamicFilter,
    allSeries,
    setsForSeries,
    showAdvanced: showAdvancedFilters,
    setShowAdvanced: setShowAdvancedFilters,
    t,
  }

  const cardLang = (card) => card._lang || card.lang || (langFilter === 'all' ? 'en' : langFilter)

  const toggleSelected = (card) => {
    setSelectedItems(prev => {
      const next = new Map(prev)
      if (next.has(card.id)) next.delete(card.id)
      else next.set(card.id, { card_id: card.id, lang: cardLang(card), variant: getDefaultVariantOrNull(card) })
      return next
    })
  }

  const selectAllOnPage = () => {
    setSelectedItems(prev => {
      const next = new Map(prev)
      for (const card of (data?.data || [])) {
        next.set(card.id, { card_id: card.id, lang: cardLang(card), variant: getDefaultVariantOrNull(card) })
      }
      return next
    })
  }

  const clearSelection = () => setSelectedItems(new Map())

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedItems(new Map())
    setBulkPrintingDetails([])
    setShowBulkPrintingDetails(false)
  }

  const selectAllMatchingMutation = useMutation({
    mutationFn: async () => {
      const total = data?.total_count || 0
      if (total === 0) return []
      const r = await searchCards({ ...queryParams, page: 1, page_size: total })
      return r.data?.data || []
    },
    onSuccess: (cards) => {
      setSelectedItems(prev => {
        const next = new Map(prev)
        for (const card of cards) {
          next.set(card.id, { card_id: card.id, lang: cardLang(card), variant: getDefaultVariantOrNull(card) })
        }
        return next
      })
    },
    onError: () => toast.error(t('cardSearch.searchFailed')),
  })

  const bulkAddMutation = useMutation({
    mutationFn: () => {
      const items = Array.from(selectedItems.values()).map(({ card_id, lang, variant }) => ({
        card_id,
        quantity: 1,
        condition: 'NM',
        variant,
        purchase_price: null,
        lang,
        printing_details: bulkPrintingDetails,
      }))
      return bulkAddToCollection(items)
    },
    onSuccess: (result) => {
      const parts = [
        `${result.added} ${t('cardSearch.bulkAddedNew')}`,
        `${result.updated} ${t('cardSearch.bulkAddedExisting')}`,
      ]
      if (result.failed > 0) parts.push(`${result.failed} ${t('cardSearch.bulkAddFailedCount')}`)
      toast.success(parts.join(' · '))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      exitSelectMode()
    },
    onError: () => toast.error(t('cardSearch.bulkAddFailed')),
  })

  return (
    <div className="space-y-4 pb-2">

      {/* ─── Header ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{t('cardSearch.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('cardSearch.subtitle')}</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
          <button
            onClick={() => setShowScanner(true)}
            className="w-10 h-10 rounded-xl flex items-center justify-center transition-colors"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            title={t('scanner.title')}
          >
            <Camera size={18} className="text-text-muted" />
          </button>
          <button
            onClick={() => navigate('/scans')}
            className="relative flex h-10 items-center gap-2 rounded-xl px-3 text-sm text-text-muted transition-colors hover:text-text-primary"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            title={t('scanner.queueTitle')}
            aria-label={t('scanner.queueTitle')}
          >
            <span className="relative">
              <ScanLine size={18} />
              {scanAttention > 0 && (
                <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-yellow px-1 text-[9px] font-bold leading-none text-black">
                  {scanAttention > 99 ? '99+' : scanAttention}
                </span>
              )}
              {scanAttention === 0 && scansActive && (
                <span className="absolute -right-1.5 -top-1.5 h-2.5 w-2.5 animate-pulse rounded-full bg-brand-red" />
              )}
            </span>
            <span className="hidden sm:inline">{t('scanner.queueTitle')}</span>
          </button>
          <button
            onClick={() => setShowCustomModal(true)}
            className="btn-ghost text-sm border-yellow/30 text-yellow hover:bg-yellow/10"
          >
            <PenLine size={14} />
            {t('cardSearch.createCustomCard')}
          </button>
          {hasQuery && (
            <button
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              className={`btn-ghost text-sm ${selectMode ? 'border-brand-red/50 text-brand-red bg-brand-red/10' : ''}`}
            >
              <CheckSquare size={14} />
              {selectMode ? t('cardSearch.exitSelect') : t('cardSearch.select')}
            </button>
          )}
        </div>
      </div>

      {/* ─── Language Filter ──────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-muted">{t('lang.filter')}:</span>
        <TcgdexLanguageSelect
          value={langFilter}
          includeAll
          allLabel={t('lang.all')}
          compact
          languages={visibleLanguages}
          onChange={(value) => updateSearchParams({ lang: value === defaultLangFilter ? '' : value })}
          className="select w-full sm:w-52 text-xs py-1.5"
        />
        <div className="flex items-center gap-2 sm:ml-auto">
          <SortAsc size={14} className="text-text-muted flex-shrink-0" />
          <select
            id="card-search-sort-by"
            aria-label={t('cardSearch.sortBy')}
            className="select text-sm py-1.5 w-36"
            value={filters.sort_by}
            onChange={(event) => updateSearchParams({
              sort_by: event.target.value,
              sort_order: event.target.value ? filters.sort_order : '',
            })}
          >
            <option value="">—</option>
            <option value="name">{t('cardSearch.sortName')}</option>
            <option value="number">{t('cardSearch.sortNumber')}</option>
            <option value="rarity">{t('cardSearch.sortRarity')}</option>
          </select>
          {filters.sort_by && (
            <button
              type="button"
              onClick={() => updateSearchParams({ sort_order: filters.sort_order === 'asc' ? 'desc' : 'asc' })}
              className="btn-ghost py-1.5 px-2 text-sm"
              aria-label={filters.sort_order === 'asc' ? t('common.sortDescending') : t('common.sortAscending')}
            >
              {filters.sort_order === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          )}
        </div>
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
            onClick={openFilters}
            aria-label={t('cardSearch.filters')}
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

          {hasUrlSearchState && (
            <button type="button" onClick={clearSearch} className="btn-ghost flex-shrink-0">
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

          <div className="flex justify-start border-t border-border pt-3">
            <button
              type="button"
              onClick={clearFilters}
              className="btn-ghost justify-center"
            >
              <X size={14} /> {t('common.clear')}
            </button>
          </div>
        </div>
      </Sheet>

      {(matchedCustomCards.length > 0 || (data?.data || []).length > 0) && (
        <CardLegend
          legendProps={{ showSelection: true }}
        />
      )}

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

      {error && hasQuery && (
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

      {data && !isLoading && hasQuery && (
        <>
          {selectMode && (
            <div className="card sticky top-2 z-20 hidden flex-wrap items-center gap-2 bg-bg-elevated/95 backdrop-blur sm:flex">
              <span className="text-sm font-semibold text-brand-red">
                {selectedItems.size} {t('cardSearch.selected')}
              </span>
              <div className="flex-1" />
              <button
                onClick={selectAllOnPage}
                disabled={!data.data?.length}
                className="btn-ghost text-sm disabled:opacity-50"
              >
                {t('cardSearch.selectPage')}
              </button>
              <button
                onClick={() => selectAllMatchingMutation.mutate()}
                disabled={!data.total_count || selectAllMatchingMutation.isPending}
                className="btn-ghost text-sm disabled:opacity-50"
              >
                {selectAllMatchingMutation.isPending
                  ? t('cardSearch.bulkAddLoading')
                  : `${t('cardSearch.selectAllMatching')} (${data.total_count?.toLocaleString()})`}
              </button>
              <button
                onClick={clearSelection}
                disabled={selectedItems.size === 0}
                className="btn-ghost text-sm disabled:opacity-50"
              >
                <X size={14} /> {t('cardSearch.clearSelection')}
              </button>
              <button
                type="button"
                onClick={() => setShowBulkPrintingDetails(true)}
                className="btn-ghost px-3 text-sm"
                title={t('printingDetails.label')}
              >
                <Tags size={14} /> {bulkPrintingDetails.length || ''}
              </button>
              <button
                onClick={() => bulkAddMutation.mutate()}
                disabled={selectedItems.size === 0 || bulkAddMutation.isPending}
                className="btn-primary text-sm disabled:opacity-50"
              >
                <Plus size={14} />
                {bulkAddMutation.isPending ? t('card.adding') : t('cardSearch.addSelected')}
              </button>
            </div>
          )}
          {selectMode && (
            <div className="fixed bottom-20 left-3 right-3 z-40 flex items-center gap-2 rounded-2xl border border-white/15 bg-bg-surface/95 p-3 shadow-2xl backdrop-blur sm:hidden">
              <span className="min-w-0 flex-1 text-sm font-semibold text-brand-red">
                {selectedItems.size} {t('cardSearch.selected')}
              </span>
              <button
                type="button"
                onClick={() => setShowBulkPrintingDetails(true)}
                className="btn-ghost px-3"
                aria-label={t('printingDetails.label')}
              >
                <Tags size={15} />{bulkPrintingDetails.length > 0 && <span>{bulkPrintingDetails.length}</span>}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={selectedItems.size === 0}
                className="btn-ghost px-3 disabled:opacity-50"
                aria-label={t('cardSearch.clearSelection')}
              >
                <X size={15} />
              </button>
              <button
                type="button"
                onClick={() => bulkAddMutation.mutate()}
                disabled={selectedItems.size === 0 || bulkAddMutation.isPending}
                className="btn-primary justify-center px-3 text-sm disabled:opacity-50"
              >
                <Plus size={14} />
                {bulkAddMutation.isPending ? t('card.adding') : t('cardSearch.addSelected')}
              </button>
            </div>
          )}

          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-text-secondary">
              {data.total_count?.toLocaleString()} {t('cardSearch.results')}
              {isFetching && <span className="ml-2 text-text-muted">{t('common.updating')}</span>}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button onClick={() => updateSearchParams({ page: Math.max(1, page - 1) }, { resetPage: false })} disabled={page <= 1} className="btn-ghost py-1.5 px-2 disabled:opacity-50">
                  <ChevronLeft size={16} />
                </button>
                <span className="text-sm text-text-secondary">{page} / {totalPages}</span>
                <button onClick={() => updateSearchParams({ page: Math.min(totalPages, page + 1) }, { resetPage: false })} disabled={page >= totalPages} className="btn-ghost py-1.5 px-2 disabled:opacity-50">
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
                const isSelected = selectedItems.has(card.id)
                const cardPrice = card.price_market ?? card.price_trend ?? null
                return (
                  <CardDisplay
                    key={card.id}
                    card={card}
                    image={imgSrc}
                    price={cardPrice > 0 ? formatPrice(cardPrice) : null}
                    languageLabel={card._lang && langFilter === 'all' ? tcgdexLanguageLabel(card._lang) : null}
                    selected={selectMode && isSelected}
                    onSelect={selectMode ? () => toggleSelected(card) : undefined}
                    onClick={() => {
                      if (selectMode) toggleSelected(card)
                      else {
                        setSelectedCardTab('add')
                        setSelectedCard(card)
                      }
                    }}
                    onAdd={!selectMode ? () => {
                      setSelectedCardTab('add')
                      setSelectedCard(card)
                    } : undefined}
                  />
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
          ownedItems={selectedCard.owned_items || []}
          initialTab={selectedCardTab}
        />
      )}

      <Sheet isOpen={showBulkPrintingDetails} onClose={() => setShowBulkPrintingDetails(false)} title={t('printingDetails.label')}>
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-secondary">{t('printingDetails.bulkHelp')}</p>
          <PrintingDetailSelector value={bulkPrintingDetails} onChange={setBulkPrintingDetails} />
          <button type="button" className="btn-primary w-full justify-center" onClick={() => setShowBulkPrintingDetails(false)}>{t('common.close')}</button>
        </div>
      </Sheet>

      <CardScanner
        isOpen={showScanner}
        onClose={() => setShowScanner(false)}
        onCardSelected={(card) => {
          updateSearchParams({ q: card.name })
          setShowScanner(false)
        }}
      />
    </div>
  )
}
