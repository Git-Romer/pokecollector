import { useState, useMemo, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, Package, Star, Download, Upload, X, Heart, Minus, HelpCircle, Check } from 'lucide-react'
import { getBinderCards, removeCardFromBinder, removeBinderEntry, addCardToBinder, addCollectionItemToBinder, searchCards, getCollection, updateBinderEntry, getBinderEntryEquivalentPrints, getBinderPrintOptimization, applyBinderPrintOptimization, switchBinderEntryCard, addBinderEntryToWishlist, addBinderCardsToWishlist, importBinderCsv, exportBinderCsv, getApiErrorMessage } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { cardNumberMatches } from '../utils/cardNumbers'
import { normalizeSearchText, textIncludes } from '../utils/textSearch'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { BINDER_SORT_OPTIONS, sortBinderCards } from '../utils/binderCards'
import { partitionSettledResults } from '../utils/settledResults'
import { formatBinderCountSummary } from '../utils/binderCounts'
import { binderQuantityPromptKey } from '../utils/binderQuantity'
import { CardDialog, CardDisplay, CardLegend, withCollectionItemState } from '../components/card-system'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'
const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']
const BINDER_CSV_IMPORT_HEADER = 'set_code,number,required_quantity,lang,variant,condition,collection_item_id'
const BINDER_CSV_IMPORT_TEMPLATE = `${BINDER_CSV_IMPORT_HEADER}\nBLK,057,4,de,Holo,NM,\n`

function askQuantity(t, defaultQuantity = 1, promptKey = 'wishlist.quantityPrompt') {
  const initialQuantity = Math.max(1, Math.min(99, parseInt(defaultQuantity, 10) || 1))
  const input = window.prompt(t(promptKey), String(initialQuantity))
  if (input === null) return null
  const quantity = parseInt(input, 10)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    toast.error(t('wishlist.quantityInvalid'))
    return null
  }
  return quantity
}

const downloadBinderCsvTemplate = () => {
  const blob = new Blob([BINDER_CSV_IMPORT_TEMPLATE], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'binder-import-template.csv'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function BinderCsvImportModal({ t, isWishlist, onClose, onChooseFile, onDownloadTemplate, isImporting }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm md:flex md:items-center md:justify-center md:bg-black/80" onClick={onClose}>
      <div
        className="fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto bg-bg-surface border-t border-border md:static md:rounded-2xl md:border md:max-w-lg md:w-full md:max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-text-primary">{t('binderTypes.csvImportTitle')}</h2>
              <p className="text-xs text-text-secondary mt-1">
                {isWishlist ? t('binderTypes.csvImportWishlistDescription') : t('binderTypes.csvImportCollectionDescription')}
              </p>
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary flex-shrink-0 p-1">
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={onChooseFile} disabled={isImporting} className="btn-primary justify-center">
              <Upload size={16} /> {isImporting ? t('binderTypes.importingCsv') : t('binderTypes.importCsv')}
            </button>
            <button type="button" onClick={onDownloadTemplate} className="btn-ghost justify-center">
              <Download size={16} /> {t('binderTypes.downloadCsvTemplate')}
            </button>
          </div>

          <div className="rounded-xl bg-bg-elevated/35 p-3 text-xs text-text-secondary space-y-3">
            <div className="space-y-1">
              <p className="font-semibold text-text-primary">{t('binderTypes.csvImportSectionCardCode')}</p>
              <p>{t('binderTypes.csvImportValueHelp')}</p>
              <p className="font-mono text-[11px] text-text-primary">
                <span className="text-brand-red">BLK</span> → set_code · <span className="text-brand-red">057</span> → number
              </p>
            </div>

            <div className="border-t border-white/5 pt-3 space-y-2">
              <p className="font-semibold text-text-primary">{t('binderTypes.csvImportSectionColumns')}</p>
              <code className="block overflow-x-auto rounded-lg bg-bg/70 px-3 py-2 text-[11px] text-text-primary font-mono">
                {BINDER_CSV_IMPORT_HEADER}
              </code>
              <p className="rounded-lg bg-brand-red/10 px-3 py-2 text-[11px] text-text-secondary">
                {t('binderTypes.csvImportRequiredOptionalHint')}
              </p>
            </div>

            <div className="border-t border-white/5 pt-3 space-y-2">
              <p className="font-semibold text-text-primary">{t('binderTypes.csvImportSectionValues')}</p>
              <div className="rounded-lg bg-bg/60 px-3 py-2">
                <p className="text-[11px] font-semibold text-text-primary mb-1">{t('binderTypes.csvImportDefaultsTitle')}</p>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div><span className="font-mono text-text-primary">required_quantity</span><br /><span className="text-text-muted">1</span></div>
                  <div><span className="font-mono text-text-primary">lang</span><br /><span className="text-text-muted">en</span></div>
                </div>
              </div>
              <p>{isWishlist ? t('binderTypes.csvImportWishlistBehavior') : t('binderTypes.csvImportCollectionBehavior')}</p>
            </div>
          </div>

          <p className="text-[11px] text-yellow/90 bg-yellow/10 rounded-lg px-3 py-2">
            {t('binderTypes.csvImportErrorBehavior')}
          </p>
        </div>
      </div>
    </div>
  )
}

export default function BinderDetail() {
  const { binderId } = useParams()
  const navigate = useNavigate()
  const { t, formatPrice, pricePrimaryField } = useSettings()
  const queryClient = useQueryClient()
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterSet, setFilterSet] = useState('')
  const [filterVariant, setFilterVariant] = useState('')
  const [filterCondition, setFilterCondition] = useState('')
  const [binderFilterSet, setBinderFilterSet] = useState('')
  const [binderFilterStatus, setBinderFilterStatus] = useState('')
  const [binderFilterQuery, setBinderFilterQuery] = useState('')
  const [binderSortBy, setBinderSortBy] = useState('recent')
  const [badgeLegendOpen, setBadgeLegendOpen] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedCardTab, setSelectedCardTab] = useState('binder')
  const [showCsvImportModal, setShowCsvImportModal] = useState(false)
  const [showPrintOptimizer, setShowPrintOptimizer] = useState(false)
  const [selectedPrintOptimizationIds, setSelectedPrintOptimizationIds] = useState([])
  const [selectedPickerIds, setSelectedPickerIds] = useState([])
  const fileInputRef = useRef(null)
  const selectedCardCloseRef = useRef(null)

  const { data, isLoading } = useQuery({
    queryKey: ['binder-cards', binderId, pricePrimaryField],
    queryFn: () => getBinderCards(parseInt(binderId), { price_field: pricePrimaryField }).then(r => r.data),
  })

  const binder = data?.binder
  const binderType = binder?.binder_type || 'collection'
  const isWishlist = binderType === 'wishlist'
  const isCollection = binderType === 'collection'

  const { data: collectionData } = useQuery({
    queryKey: ['collection'],
    queryFn: () => getCollection({}).then(r => r.data),
    enabled: isWishlist === false,
  })

  const { data: searchResults, isLoading: searching } = useQuery({
    queryKey: ['card-search-binder', searchQuery],
    queryFn: () => searchCards({ name: searchQuery, page_size: 12 }).then(r => r.data),
    enabled: isWishlist && searchQuery.length > 2,
  })

  const collectionSearchResults = useMemo(() => {
    if (!collectionData || isWishlist) return []
    const q = normalizeSearchText(searchQuery)
    return collectionData.filter(item => {
      const card = item.card
      if (!card) return false
      if (filterSet && card.set_ref?.id !== filterSet) return false
      if (filterVariant && (item.variant || '') !== filterVariant) return false
      if (filterCondition && item.condition !== filterCondition) return false
      if (!q) return true
      const nameMatch = textIncludes(card.name, q)
      const setMatch = textIncludes(card.set_ref?.name, q)
      const numberMatch = cardNumberMatches(card.number, q)
      const codeMatch = /^([A-Za-z]+\d*)\s+(\d+)$/.exec(q)
      let shortcodeMatch = false
      if (codeMatch) {
        const [, setCode, num] = codeMatch
        const normalizedNum = String(parseInt(num, 10))
        shortcodeMatch = [card.set_ref?.abbreviation, card.set_id, card.set_ref?.tcg_set_id]
          .some(value => normalizeSearchText(value) === setCode) && cardNumberMatches(card.number, normalizedNum)
      }
      return nameMatch || setMatch || numberMatch || shortcodeMatch
    }).slice(0, 24)
  }, [collectionData, searchQuery, isWishlist, filterSet, filterVariant, filterCondition])

  const collectionSets = useMemo(() => {
    const map = new Map()
    ;(collectionData || []).forEach(item => {
      const s = item.card?.set_ref
      if (s?.id) map.set(s.id, s.name)
    })
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [collectionData])

  const collectionVariants = useMemo(() => {
    const variants = new Set()
    ;(collectionData || []).forEach(item => { if (item.variant) variants.add(item.variant) })
    return [...variants].sort()
  }, [collectionData])

  const pickerSelectionMutation = useMutation({
    mutationFn: async ({ pickerIds, quantity }) => {
      const requests = pickerIds.map(id => (
        isWishlist
          ? addCardToBinder(parseInt(binderId), id, quantity)
          : addCollectionItemToBinder(parseInt(binderId), id, quantity)
      ))
      const results = await Promise.allSettled(requests)
      return partitionSettledResults(pickerIds, results)
    },
    onSuccess: ({ succeededIds, failed }) => {
      setSelectedPickerIds(current => current.filter(id => !succeededIds.includes(id)))
      if (failed.length === 0) {
        toast.success(`${t('common.add')} ${succeededIds.length} ✓`)
      } else if (succeededIds.length > 0) {
        toast.error(`${succeededIds.length} ✓ · ${failed.length} ${t('card.addFailed')}`)
      } else {
        const detail = failed[0]?.reason?.response?.data?.detail
        toast.error(detail || t('card.addFailed'))
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      invalidateTcgdexFilterLanguages(queryClient)
    },
  })

  const togglePickerSelection = (id) => {
    setSelectedPickerIds(current => current.includes(id)
      ? current.filter(value => value !== id)
      : [...current, id])
  }

  const submitPickerSelection = () => {
    const quantity = askQuantity(t, 1, binderQuantityPromptKey(isWishlist))
    if (!quantity) return
    pickerSelectionMutation.mutate({ pickerIds: [...selectedPickerIds], quantity })
  }

  const removeMutation = useMutation({
    mutationFn: ({ cardId, binderCardId }) => binderCardId
      ? removeBinderEntry(parseInt(binderId), binderCardId)
      : removeCardFromBinder(parseInt(binderId), cardId),
    onSuccess: () => {
      toast.success(t('common.remove') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
  })

  const updateEntryMutation = useMutation({
    mutationFn: ({ binderCardId, requiredQuantity }) => updateBinderEntry(parseInt(binderId), binderCardId, { required_quantity: requiredQuantity }),
    onSuccess: (_data, variables) => {
      setSelectedCard(prev => {
        if (!prev || prev.binder_card_id !== variables.binderCardId) return prev
        const priorQuantity = prev.required_quantity || 1
        return {
          ...prev,
          required_quantity: variables.requiredQuantity,
          owned_quantity: isCollection ? variables.requiredQuantity : prev.owned_quantity,
          quantity: isCollection ? variables.requiredQuantity : prev.quantity,
          available_quantity: isCollection
            ? Math.max((prev.available_quantity || 0) + priorQuantity - variables.requiredQuantity, 0)
            : prev.available_quantity,
          missing_quantity: isCollection ? 0 : Math.max(variables.requiredQuantity - (prev.owned_quantity || 0), 0),
        }
      })
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || 'Update failed'),
  })

  useEffect(() => {
    if (!selectedCard) return undefined
    setSelectedCardTab('binder')
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setSelectedCard(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    selectedCardCloseRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedCard])

  const wishlistMutation = useMutation({
    mutationFn: ({ binderCardId, quantity = null }) => addBinderEntryToWishlist(parseInt(binderId), binderCardId, quantity),
    onSuccess: (result) => {
      if (result?.added > 0) {
        const copies = result?.added_copies ? ` (${result.added_copies} ${t('binderTypes.addedCopies')})` : ''
        toast.success((isWishlist ? t('binderTypes.addMissingToWishlist') : t('binderTypes.addToWishlist')) + ` ✓${copies}`)
      } else if (result?.skipped_complete > 0) {
        toast(t('binderTypes.alreadyCompleteInCollection'))
      } else {
        toast(t('binderTypes.alreadyInWishlist'))
      }
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const bulkWishlistMutation = useMutation({
    mutationFn: () => addBinderCardsToWishlist(parseInt(binderId)),
    onSuccess: (result) => {
      const addedCopies = result.added_copies ?? result.added
      const summary = `${result.added} ${t('binderTypes.added')}, ${addedCopies} ${t('binderTypes.addedCopies')}, ${result.missing_copies || 0} ${t('binderTypes.missingCopies')}, ${result.skipped} ${t('binderTypes.skipped')}`
      if (result.added > 0) {
        toast.success(`${t('binderTypes.addMissingToWishlist')} ✓ (${summary})`)
      } else if (result.skipped_complete > 0 && result.skipped_existing === 0) {
        toast(`${t('binderTypes.alreadyCompleteInCollection')} (${summary})`)
      } else {
        toast(`${t('binderTypes.alreadyInWishlist')} (${summary})`)
      }
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const importMutation = useMutation({
    mutationFn: (file) => importBinderCsv(parseInt(binderId), file),
    onSuccess: (result) => {
      const message = `CSV: ${result.added} added, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ''}${result.failed ? `, ${result.failed} failed` : ''}`
      if (result.failed > 0 && result.errors?.length) {
        toast.error(`${message}: ${result.errors.slice(0, 2).join('; ')}`)
      } else {
        toast.success(message)
      }
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setShowCsvImportModal(false)
    },
    onError: (e) => toast.error(getApiErrorMessage(e, 'CSV import failed')),
  })

  const exportMutation = useMutation({
    mutationFn: () => exportBinderCsv(parseInt(binderId)),
    onError: () => toast.error('CSV export failed'),
  })

  const { data: equivalentPrintsData, isLoading: equivalentPrintsLoading } = useQuery({
    queryKey: ['binder-entry-equivalents', binderId, binderType, selectedCard?.binder_card_id, pricePrimaryField],
    queryFn: () => getBinderEntryEquivalentPrints(parseInt(binderId), selectedCard.binder_card_id, { price_field: pricePrimaryField }),
    enabled: (isWishlist || isCollection) && !!selectedCard?.binder_card_id,
  })

  const switchPrintMutation = useMutation({
    mutationFn: ({ binderCardId, cardId, collectionItemId }) => switchBinderEntryCard(parseInt(binderId), binderCardId, cardId, collectionItemId),
    onSuccess: () => {
      toast.success(t('binderTypes.printSwitched') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setSelectedCard(null)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('binderTypes.printSwitchFailed')),
  })

  const { data: printOptimizationData, isLoading: printOptimizationLoading, isError: printOptimizationError, error: printOptimizationErrorData } = useQuery({
    queryKey: ['binder-print-optimization', binderId, pricePrimaryField],
    queryFn: () => getBinderPrintOptimization(parseInt(binderId), { price_field: pricePrimaryField }),
    enabled: (isWishlist || isCollection) && showPrintOptimizer,
    retry: false,
  })

  useEffect(() => {
    if (!showPrintOptimizer || !printOptimizationData) return
    setSelectedPrintOptimizationIds((printOptimizationData.recommendations || []).map(item => item.binder_card_id))
  }, [showPrintOptimizer, printOptimizationData])

  const applyPrintOptimizationMutation = useMutation({
    mutationFn: (selectedIds) => applyBinderPrintOptimization(parseInt(binderId), selectedIds, { price_field: pricePrimaryField }),
    onSuccess: (result) => {
      toast.success(`${t('binderTypes.optimizePrintsApplied')} ✓ (${result.applied} ${t('binderTypes.updated')}, ${result.skipped} ${t('binderTypes.skipped')}, ${formatPrice(result.total_savings || 0)})`)
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      queryClient.invalidateQueries({ queryKey: ['binder-print-optimization', binderId] })
      setShowPrintOptimizer(false)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('binderTypes.optimizePrintsFailed')),
  })

  if (isLoading) return <div className="skeleton h-64 rounded-xl" />

  const cards = data?.cards || []
  const unavailableCollectionItemIds = new Set(data?.unavailable_collection_item_ids || [])
  const ownedCount = data?.owned_count ?? cards.reduce((sum, c) => sum + Math.min(c.owned_quantity || 0, c.required_quantity || 1), 0)
  const totalCount = data?.total_required_count ?? data?.total_count ?? cards.length
  const uniqueCount = data?.unique_count ?? new Set(cards.map(card => card.id)).size
  const missingCount = data?.missing_count ?? cards.reduce((sum, c) => sum + (c.missing_quantity || 0), 0)
  const binderValue = data?.binder_value ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (isWishlist ? (c.required_quantity || 1) : (c.quantity || 0))), 0)
  const currentValue = data?.current_value ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (isWishlist ? Math.min(c.owned_quantity || 0, c.required_quantity || 1) : (c.quantity || 0))), 0)
  const costToComplete = data?.cost_to_complete ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (c.missing_quantity || 0)), 0)
  const displayedValue = isWishlist ? costToComplete : binderValue
  const hasMissingPriceData = cards.length > 0 && displayedValue === 0 && (!isWishlist || missingCount > 0) && cards.some(c => !c.price_market || c.price_market <= 0)
  const hasMissingCurrentValueData = isWishlist && ownedCount > 0 && currentValue === 0 && cards.some(c => (c.owned_quantity || 0) > 0 && (!c.price_market || c.price_market <= 0))
  const progressPct = totalCount > 0 ? Math.round((ownedCount / totalCount) * 100) : 0
  const binderSets = [...new Set(cards.map(c => c.set_name || c.set_id).filter(Boolean))].sort()
  const printOptimizationRecommendations = printOptimizationData?.recommendations || []
  const selectedPrintOptimizationIdSet = new Set(selectedPrintOptimizationIds)
  const selectedPrintOptimizationCount = printOptimizationRecommendations.filter(item => selectedPrintOptimizationIdSet.has(item.binder_card_id)).length
  const selectedPrintOptimizationSavings = printOptimizationRecommendations.reduce(
    (sum, item) => selectedPrintOptimizationIdSet.has(item.binder_card_id) ? sum + (item.total_savings || 0) : sum,
    0
  )
  const allPrintOptimizationsSelected = printOptimizationRecommendations.length > 0 && selectedPrintOptimizationCount === printOptimizationRecommendations.length
  const visibleCards = sortBinderCards(cards.filter(card => {
    const query = normalizeSearchText(binderFilterQuery)
    if (query && ![card.name, card.set_name, card.set_id, card.number].some(value => textIncludes(value, query))) return false
    if (binderFilterSet && (card.set_name || card.set_id) !== binderFilterSet) return false
    if (binderFilterStatus === 'owned' && (card.missing_quantity || 0) > 0) return false
    if (binderFilterStatus === 'missing' && (card.missing_quantity || 0) === 0) return false
    return true
  }), binderSortBy, { isWishlist })

  const changeRequiredQuantity = (card, delta) => {
    const maximum = isCollection ? (card.max_assignable_quantity || 1) : 99
    const next = Math.max(1, Math.min(maximum, (card.required_quantity || 1) + delta))
    updateEntryMutation.mutate({ binderCardId: card.binder_card_id, requiredQuantity: next })
  }

  const handleImportFile = (event) => {
    const file = event.target.files?.[0]
    if (file) importMutation.mutate(file)
    event.target.value = ''
  }

  const togglePrintOptimizationSelection = (binderCardId) => {
    setSelectedPrintOptimizationIds(prev => prev.includes(binderCardId)
      ? prev.filter(id => id !== binderCardId)
      : [...prev, binderCardId]
    )
  }

  const toggleAllPrintOptimizations = () => {
    setSelectedPrintOptimizationIds(allPrintOptimizationsSelected ? [] : printOptimizationRecommendations.map(item => item.binder_card_id))
  }

  return (
    <div className="space-y-4 pb-2">
      <button onClick={() => navigate('/binders')} className="btn-ghost text-sm py-1.5">
        <ArrowLeft size={14} /> {t('nav.binders')}
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: binder?.color }} />
            {binder?.icon_pokemon_id ? (
              <img src={`${SPRITE_BASE_URL}/${binder.icon_pokemon_id}.gif`} alt="" className="h-8 w-8 pixelated flex-shrink-0" loading="lazy" />
            ) : isWishlist ? (
              <Star size={20} className="flex-shrink-0" style={{ color: binder?.color }} />
            ) : (
              <Package size={20} className="flex-shrink-0" style={{ color: binder?.color }} />
            )}
            <h1 className="text-xl font-bold text-text-primary truncate">{binder?.name}</h1>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
              isWishlist ? 'bg-yellow/20 text-yellow' : 'bg-blue/20 text-blue'
            }`}>
              {isWishlist ? `⭐ ${t('binderTypes.wishlist')}` : `📦 ${t('binderTypes.collection')}`}
            </span>
          </div>
          {binder?.description && <p className="text-sm text-text-secondary mt-1">{binder.description}</p>}
          <p className="text-xs text-text-muted mt-1">{formatBinderCountSummary(totalCount, uniqueCount, t)}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => {
              if (showSearch) setSelectedPickerIds([])
              setShowSearch(!showSearch)
            }}
            className="btn-primary flex-shrink-0"
          >
            <Plus size={16} /> {t('common.add')} {t('nav.cards')}
          </button>
          <button
            onClick={() => setShowPrintOptimizer(true)}
            className="btn-ghost flex-shrink-0 px-2"
            disabled={cards.length === 0}
            title={t('binderTypes.optimizePrints')}
            aria-label={t('binderTypes.optimizePrints')}
          >
            <Star size={16} /> {t('binderTypes.optimizeShort')}
          </button>
          {isWishlist && (
            <button
              onClick={() => bulkWishlistMutation.mutate()}
              className="btn-ghost flex-shrink-0 px-2"
              disabled={bulkWishlistMutation.isPending || cards.length === 0}
              title={t('binderTypes.addMissingToWishlist')}
              aria-label={t('binderTypes.addMissingToWishlist')}
            >
              <Heart size={16} /> {t('binderTypes.addMissingShort')}
            </button>
          )}
          <button
            onClick={() => setShowCsvImportModal(true)}
            className="btn-ghost flex-shrink-0 px-2"
            disabled={importMutation.isPending}
            title={t('binderTypes.importCsv')}
            aria-label={t('binderTypes.importCsv')}
          >
            <Upload size={16} /> CSV
          </button>
          <button
            onClick={() => exportMutation.mutate()}
            className="btn-ghost flex-shrink-0 px-2"
            disabled={exportMutation.isPending || cards.length === 0}
            title={t('binderTypes.exportCsv')}
            aria-label={t('binderTypes.exportCsv')}
          >
            <Download size={16} /> CSV
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />
        </div>
      </div>

      <div className={isWishlist ? "grid grid-cols-2 md:grid-cols-5 gap-2" : "grid grid-cols-2 md:grid-cols-4 gap-2"}>
        <div className="card p-3"><p className="text-xs text-text-muted">{t('binderTypes.required')}</p><p className="text-lg font-bold text-text-primary">{totalCount}</p></div>
        <div className="card p-3"><p className="text-xs text-text-muted">{t('binderTypes.owned')}</p><p className="text-lg font-bold text-green">{ownedCount}</p></div>
        <div className="card p-3"><p className="text-xs text-text-muted">{t('binderTypes.missing')}</p><p className="text-lg font-bold text-brand-red">{missingCount}</p></div>
        {isWishlist && (
          <div className="card p-3">
            <p className="text-xs text-text-muted">{t('binderTypes.currentValue')}</p>
            <p className={`text-lg font-bold ${hasMissingCurrentValueData ? 'text-text-muted' : 'text-yellow'}`}>
              {hasMissingCurrentValueData ? t('binderTypes.noPriceData') : formatPrice(currentValue)}
            </p>
          </div>
        )}
        <div className="card p-3">
          <p className="text-xs text-text-muted">{isWishlist ? t('binderTypes.costToComplete') : t('binderTypes.binderValue')}</p>
          <p className={`text-lg font-bold ${hasMissingPriceData ? 'text-text-muted' : 'text-yellow'}`}>
            {hasMissingPriceData ? t('binderTypes.noPriceData') : formatPrice(displayedValue)}
          </p>
        </div>
      </div>

      {(binder?.format || isWishlist) && (
        <div className="card p-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-medium text-text-primary">{t('binderTypes.deckStyleBinder')}</p>
            <p className="text-xs text-text-muted">{t('binderTypes.formatMetadataHelp')}</p>
          </div>
          {binder?.format && <span className="text-xs px-2 py-1 rounded-full bg-yellow/15 text-yellow font-semibold">{binder.format}</span>}
        </div>
      )}

      {isWishlist && cards.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-text-primary">{t('binderTypes.progress')}</span>
            <span className="text-sm text-text-secondary">
              {ownedCount} {t('binderTypes.ownedOf')} {totalCount} {t('binderTypes.cards')} ({progressPct}%)
            </span>
          </div>
          <div className="w-full bg-border rounded-full h-3">
            <div className="bg-green h-3 rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="flex justify-between text-xs text-text-muted mt-1">
            <span className="text-green">{ownedCount} {t('binderTypes.owned')}</span>
            <span className="text-brand-red">{missingCount} {t('binderTypes.missing')}</span>
          </div>
        </div>
      )}

      {showSearch && (
        <div className="card border-brand-red/20">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-text-primary">
              {isWishlist ? t('binderTypes.addAnyCard') : t('binderTypes.addFromCollection')}
            </h3>
            <button
              type="button"
              className="btn-primary-sm hidden sm:inline-flex"
              disabled={selectedPickerIds.length === 0 || pickerSelectionMutation.isPending}
              onClick={submitPickerSelection}
            >
              {t('common.add')} {selectedPickerIds.length > 0 ? `(${selectedPickerIds.length})` : ''}
            </button>
          </div>
          <input type="text"
            placeholder={isWishlist ? t('binderTypes.searchAll') : t('binderTypes.searchCollection')}
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            className="input mb-4" autoFocus />

          {!isWishlist && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
              <select className="select text-sm py-1.5" value={filterSet} onChange={(e) => setFilterSet(e.target.value)}>
                <option value="">{t('common.all')} {t('common.set')}</option>
                {collectionSets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select className="select text-sm py-1.5" value={filterVariant} onChange={(e) => setFilterVariant(e.target.value)}>
                <option value="">{t('variants.allVariants')}</option>
                {collectionVariants.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
              <select className="select text-sm py-1.5" value={filterCondition} onChange={(e) => setFilterCondition(e.target.value)}>
                <option value="">{t('common.allConditions')}</option>
                {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}

          {isWishlist && (
            <>
              {searching && <p className="text-text-muted text-sm text-center py-4">{t('common.loading')}</p>}
              {searchResults?.data && (
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 max-h-64 overflow-y-auto">
                  {searchResults.data.map((card) => {
                    const alreadyAdded = cards.some(c => c.id === card.id)
                    const selected = selectedPickerIds.includes(card.id)
                    return (
                      <CardDisplay
                        key={card.id}
                        card={card}
                        image={resolveCardImageUrl(card)}
                        compact
                        selected={selected}
                        unavailableReason={alreadyAdded ? t('binderTypes.alreadyUsed') : ''}
                        onClick={() => !alreadyAdded && togglePickerSelection(card.id)}
                        onSelect={() => !alreadyAdded && togglePickerSelection(card.id)}
                      />
                    )
                  })}
                </div>
              )}
            </>
          )}

          {!isWishlist && (
            <>
              {searchQuery.length > 0 && searchQuery.length < 2 && (
                <p className="text-text-muted text-xs text-center">{t('common.search')}...</p>
              )}
              {collectionSearchResults.length > 0 && (
                <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 max-h-64 overflow-y-auto">
                  {collectionSearchResults.map((item) => {
                    const card = item.card
                    if (!card) return null
                    const unavailable = unavailableCollectionItemIds.has(item.id)
                    const selected = selectedPickerIds.includes(item.id)
                    return (
                      <CardDisplay
                        key={`${card.id}-${item.id}`}
                        card={card}
                        image={resolveCardImageUrl(card)}
                        compact
                        selected={selected}
                        variantEffectSource={item.variant}
                        stateIndicatorProps={{
                          card: withCollectionItemState(card, item),
                          alwaysShowQuantity: true,
                          showWishlist: false,
                        }}
                        onClick={() => !unavailable && togglePickerSelection(item.id)}
                        onSelect={() => !unavailable && togglePickerSelection(item.id)}
                        unavailableReason={unavailable ? t('binderTypes.alreadyUsed') : ''}
                        overlay={(
                          <div className="absolute bottom-2 left-2 right-2 z-20 truncate rounded-full bg-black/80 px-2 py-1 text-center text-[9px] text-white">
                            {[item.variant || 'Normal', item.condition].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      />
                    )
                  })}
                </div>
              )}
              {searchQuery.length >= 2 && collectionSearchResults.length === 0 && (
                <p className="text-text-muted text-sm text-center py-4">{t('common.noResults')}</p>
              )}
            </>
          )}
          <div className="sticky bottom-2 z-30 mt-4 flex items-center gap-3 rounded-xl border border-white/15 bg-bg-surface/95 p-3 shadow-2xl backdrop-blur sm:hidden">
            <span className="min-w-0 flex-1 text-sm font-semibold text-text-primary">
              {selectedPickerIds.length} {t('cardSearch.selected')}
            </span>
            <button
              type="button"
              className="btn-primary-sm justify-center"
              disabled={selectedPickerIds.length === 0 || pickerSelectionMutation.isPending}
              onClick={submitPickerSelection}
            >
              {t('common.add')} {selectedPickerIds.length > 0 ? `(${selectedPickerIds.length})` : ''}
            </button>
          </div>
        </div>
      )}

      {cards.length > 0 && (
        <>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setBadgeLegendOpen(open => !open)}
              className={`btn-ghost px-3 py-2 text-sm ${
                badgeLegendOpen ? 'border-brand-red/30 bg-brand-red/10 text-brand-red' : ''
              }`}
              aria-expanded={badgeLegendOpen}
              aria-controls="private-binder-card-badge-legend"
            >
              <HelpCircle size={15} />
              <span>{t('setDetail.badgeLegend')}</span>
            </button>
          </div>
          {badgeLegendOpen && (
            <div id="private-binder-card-badge-legend" className="card p-3">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {t('setDetail.badgeLegend')}
              </p>
              <CardLegend
                collapsible={false}
                showWishlist={false}
                showQuantity={!isCollection}
                showSelection={showSearch}
                showBinderProgress={isWishlist}
              />
              {isCollection && <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                <span className="inline-flex flex-shrink-0 items-center rounded-full bg-green/80 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow-sm">
                  2x
                </span>
                <span className="text-xs leading-tight text-text-secondary">
                  {t('binderTypes.amountInBinder')}
                </span>
              </div>}
            </div>
          )}
        </>
      )}

      {cards.length > 0 && (
        <div className="card p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <input
            type="text"
            value={binderFilterQuery}
            onChange={(e) => setBinderFilterQuery(e.target.value)}
            placeholder={t('binderTypes.filterBinderCards')}
            className="input text-sm py-2"
          />
          <select className="select text-sm py-2" value={binderFilterSet} onChange={(e) => setBinderFilterSet(e.target.value)}>
            <option value="">{t('binderTypes.allSets')}</option>
            {binderSets.map(setName => <option key={setName} value={setName}>{setName}</option>)}
          </select>
          <select className="select text-sm py-2" value={binderFilterStatus} onChange={(e) => setBinderFilterStatus(e.target.value)}>
            <option value="">{t('binderTypes.allStatuses')}</option>
            <option value="owned">{t('binderTypes.ownedComplete')}</option>
            <option value="missing">{t('binderTypes.missingCards')}</option>
          </select>
          <select
            className="select text-sm py-2"
            value={binderSortBy}
            onChange={(e) => setBinderSortBy(e.target.value)}
            aria-label={t('binderTypes.sortBy')}
          >
            {BINDER_SORT_OPTIONS
              .filter(option => isCollection || option !== 'variant_asc')
              .map(option => (
                <option key={option} value={option}>{t(`binderTypes.sort.${option}`)}</option>
              ))}
          </select>
        </div>
      )}

      {cards.length === 0 ? (
        <div className="card text-center py-20">
          <p className="text-text-muted">
            {isWishlist ? '⭐ No cards in this wishlist binder yet' : '📦 No cards in this binder yet'}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {isWishlist ? t('binderTypes.addAnyCard') : t('binderTypes.addFromCollection')}
          </p>
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="card text-center py-12 text-text-muted">{t('common.noResults')}</div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 sm:gap-3">
          {visibleCards.map((card) => {
            const ownedQuantity = Math.max(0, Number(card.owned_quantity) || 0)
            const requiredQuantity = Math.max(1, Number(card.required_quantity) || 1)
            const isComplete = ownedQuantity >= requiredQuantity
            const progressLabel = `${t('binderTypes.progress')}: ${ownedQuantity}/${requiredQuantity}`

            return (
              <CardDisplay
                key={card.binder_card_id || card.id}
                card={card}
                image={resolveCardImageUrl(card)}
                price={card.price_market > 0 ? formatPrice(card.price_market) : null}
                variantEffectSource={card.variant}
                showStateIndicators={!isWishlist}
                dimWhenUnowned={isWishlist}
                stateIndicatorProps={isCollection ? {
                  card: withCollectionItemState(card, card),
                  alwaysShowQuantity: true,
                  showWishlist: false,
                } : undefined}
                captionAccessory={isWishlist ? (
                  <span
                    title={progressLabel}
                    aria-label={progressLabel}
                    className={isComplete
                      ? 'inline-flex items-center justify-center rounded-full border border-green/40 bg-green/90 p-1 text-white shadow-sm'
                      : 'inline-flex items-center rounded-full border border-white/15 bg-bg-elevated px-1.5 py-0.5 text-[10px] font-bold leading-none text-text-secondary shadow-sm'}
                  >
                    {isComplete ? <Check size={10} strokeWidth={3} aria-hidden /> : `${ownedQuantity}/${requiredQuantity}`}
                  </span>
                ) : undefined}
                onClick={() => setSelectedCard(card)}
              />
            )
          })}
        </div>
      )}

      {showCsvImportModal && (
        <BinderCsvImportModal
          t={t}
          isWishlist={isWishlist}
          onClose={() => setShowCsvImportModal(false)}
          onChooseFile={() => fileInputRef.current?.click()}
          onDownloadTemplate={downloadBinderCsvTemplate}
          isImporting={importMutation.isPending}
        />
      )}

      {showPrintOptimizer && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm md:flex md:items-center md:justify-center md:bg-black/80" onClick={() => setShowPrintOptimizer(false)}>
          <div
            className="fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto bg-bg-surface border-t border-border md:static md:rounded-2xl md:border md:max-w-3xl md:w-full md:max-h-[85vh]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-center pt-3 pb-1 md:hidden"><div className="w-10 h-1 bg-border rounded-full" /></div>
            <div className="p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-text-primary">{t('binderTypes.optimizePrints')}</h2>
                  <p className="text-xs text-text-secondary mt-1">{t('binderTypes.optimizePrintsHelp')}</p>
                </div>
                <button onClick={() => setShowPrintOptimizer(false)} className="text-text-muted hover:text-text-primary flex-shrink-0 p-1" aria-label={t('common.close')}>
                  <X size={18} />
                </button>
              </div>

              {printOptimizationLoading && <p className="text-sm text-text-muted text-center py-6">{t('binderTypes.optimizingPrints')}</p>}

              {printOptimizationError && (
                <p className="rounded-xl bg-brand-red/10 p-4 text-sm text-brand-red text-center">
                  {printOptimizationErrorData?.response?.data?.detail || t('binderTypes.optimizePrintsFailed')}
                </p>
              )}

              {!printOptimizationLoading && !printOptimizationError && (printOptimizationData?.recommendations || []).length === 0 && (
                <p className="rounded-xl bg-bg-card/60 p-4 text-sm text-text-muted text-center">{t('binderTypes.noPrintOptimizations')}</p>
              )}

              {!printOptimizationError && (printOptimizationData?.recommendations || []).length > 0 && (
                <>
                  <div className="rounded-xl bg-yellow/10 px-3 py-2 text-xs text-yellow space-y-1">
                    <p>{t('binderTypes.optimizePrintsSummary')}: {printOptimizationData.change_count} · {formatPrice(printOptimizationData.total_savings || 0)}</p>
                    <p>{t('binderTypes.selectedOptimizationSummary')}: {selectedPrintOptimizationCount} · {formatPrice(selectedPrintOptimizationSavings)}</p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
                    <input
                      type="checkbox"
                      className="accent-brand-red"
                      checked={allPrintOptimizationsSelected}
                      onChange={toggleAllPrintOptimizations}
                    />
                    {t('binderTypes.selectAllOptimizations')}
                  </label>
                  <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                    {printOptimizationData.recommendations.map((item) => {
                      const isSelected = selectedPrintOptimizationIdSet.has(item.binder_card_id)
                      return (
                        <div key={item.binder_card_id} className={`rounded-xl border p-3 ${isSelected ? 'border-yellow/40 bg-yellow/5' : 'border-border bg-bg-card/60'}`}>
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              className="mt-2 accent-brand-red"
                              checked={isSelected}
                              onChange={() => togglePrintOptimizationSelection(item.binder_card_id)}
                              aria-label={t('cardSearch.select')}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_32px_minmax(0,1fr)_auto] md:items-center">
                                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-bg-elevated/50 p-2">
                                  <CardDisplay variant="compact-artwork" card={item.current} image={resolveCardImageUrl(item.current)} alt={item.current.name} variantEffectSource={item.current.variant} />
                                  <div className="min-w-0">
                                    <p className="text-[9px] font-bold uppercase tracking-wide text-text-muted">{t('binderTypes.currentPrint')}</p>
                                    <p className="truncate text-xs font-semibold text-text-primary">{item.current.set_name || item.current.set_id} #{item.current.number}</p>
                                    <p className="text-[11px] text-text-muted">{item.current_price ? formatPrice(item.current_price) : t('binderTypes.noPriceDataShort')}</p>
                                    {(item.current.variant || item.current.condition) && <p className="truncate text-[10px] text-text-muted">{[item.current.variant, item.current.condition].filter(Boolean).join(' · ')}</p>}
                                  </div>
                                </div>
                                <span className="mx-auto text-sm font-bold text-green">
                                  <span className="md:hidden">↓</span>
                                  <span className="hidden md:inline">→</span>
                                </span>
                                <div className="flex min-w-0 items-center gap-2 rounded-lg border border-green/30 bg-green/5 p-2">
                                  <CardDisplay variant="compact-artwork" card={item.suggested} image={resolveCardImageUrl(item.suggested)} alt={item.suggested.name} variantEffectSource={item.suggested.variant} />
                                  <div className="min-w-0">
                                    <p className="text-[9px] font-bold uppercase tracking-wide text-green">{t('binderTypes.suggestedPrint')}</p>
                                    <p className="truncate text-xs font-semibold text-text-primary">{item.suggested.set_name || item.suggested.set_id} #{item.suggested.number}</p>
                                    <p className="text-[11px] text-green">{formatPrice(item.suggested_price)}</p>
                                    {(item.suggested.variant || item.suggested.condition) && <p className="truncate text-[10px] text-text-muted">{[item.suggested.variant, item.suggested.condition].filter(Boolean).join(' · ')}</p>}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="btn-ghost justify-center border-green/30 text-green"
                                  disabled={applyPrintOptimizationMutation.isPending}
                                  onClick={() => applyPrintOptimizationMutation.mutate([item.binder_card_id])}
                                >
                                  {t('binderTypes.switchPrint')}
                                </button>
                              </div>
                              <p className="mt-2 text-[11px] text-text-muted">
                                {item.required_quantity}x · {t('binderTypes.estimatedSavings')}: {formatPrice(item.total_savings)}
                              </p>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" className="btn-ghost justify-center" onClick={() => setShowPrintOptimizer(false)}>{t('common.cancel')}</button>
                    <button
                      type="button"
                      className="btn-primary justify-center"
                      disabled={applyPrintOptimizationMutation.isPending || selectedPrintOptimizationCount === 0}
                      onClick={() => applyPrintOptimizationMutation.mutate(selectedPrintOptimizationIds)}
                    >
                      {applyPrintOptimizationMutation.isPending ? t('binderTypes.optimizingPrints') : t('binderTypes.applyOptimization')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedCard && (
        <CardDialog
          card={selectedCard}
          image={resolveCardImageUrl(selectedCard)}
          variantEffectSource={selectedCard.variant}
          price={selectedCard.price_market > 0 ? formatPrice(selectedCard.price_market) : null}
          tabs={[
            { id: 'binder', label: t('cardTabs.binder') },
            ...((isWishlist || isCollection) ? [{ id: 'equivalents', label: t('cardTabs.equivalents') }] : []),
          ]}
          activeTab={selectedCardTab}
          onTabChange={setSelectedCardTab}
          onClose={() => setSelectedCard(null)}
          closeButtonRef={selectedCardCloseRef}
        >
          {selectedCardTab === 'binder' && (
            <div className="space-y-4">
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-bg-card p-2"><p className="text-xs text-text-muted">{t('binderTypes.owned')}</p><p className="font-bold text-green">{isCollection ? (selectedCard.collection_quantity || 0) : (selectedCard.owned_quantity || 0)}</p></div>
                    <div className="rounded-lg bg-bg-card p-2"><p className="text-xs text-text-muted">{t('binderTypes.missing')}</p><p className="font-bold text-brand-red">{selectedCard.missing_quantity || 0}</p></div>
                  </div>
                  {(isWishlist || (isCollection && selectedCard.collection_item_id)) ? (
                    <div>
                      <p className="text-xs text-text-muted mb-1">{isCollection ? t('binderTypes.amountInBinder') : t('binderTypes.requiredInBinder')}</p>
                      <div className="flex items-center gap-2">
                        <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, -1)} disabled={updateEntryMutation.isPending || (selectedCard.required_quantity || 1) <= 1}><Minus size={14} /></button>
                        <span className="text-lg font-bold text-text-primary min-w-8 text-center">{selectedCard.required_quantity || 1}</span>
                        <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, 1)} disabled={updateEntryMutation.isPending || (selectedCard.required_quantity || 1) >= (isCollection ? (selectedCard.max_assignable_quantity || 1) : 99)}><Plus size={14} /></button>
                      </div>
                      {isCollection && <p className="mt-1 text-xs text-text-muted">{selectedCard.available_quantity || 0} {t('products.available')}</p>}
                    </div>
                  ) : null}
                  <p className="text-xs text-text-muted">
                    {t('binderTypes.marketPrice')}: {selectedCard.price_market > 0 ? (
                      <span className="text-green font-semibold">{formatPrice(selectedCard.price_market)}</span>
                    ) : (
                      <span>{t('binderTypes.noPriceData')}</span>
                    )}
                  </p>
                  {(selectedCard.variant || selectedCard.condition) && <p className="text-xs text-text-muted">{[selectedCard.variant, selectedCard.condition].filter(Boolean).join(' · ')}</p>}
                </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button className="btn-ghost justify-center" onClick={() => {
                  if (isWishlist) {
                    wishlistMutation.mutate({ binderCardId: selectedCard.binder_card_id })
                    return
                  }
                  const wishlistQuantity = askQuantity(t, 1)
                  if (wishlistQuantity) wishlistMutation.mutate({ binderCardId: selectedCard.binder_card_id, quantity: wishlistQuantity })
                }}>
                  <Heart size={16} /> {isWishlist ? t('binderTypes.addMissingToWishlist') : t('binderTypes.addToWishlist')}
                </button>
                <button className="btn-ghost justify-center text-brand-red" onClick={() => { removeMutation.mutate({ cardId: selectedCard.id, binderCardId: selectedCard.binder_card_id }); setSelectedCard(null) }}>
                  <Trash2 size={16} /> {t('common.remove')}
                </button>
                <button className="btn-primary justify-center" onClick={() => setSelectedCard(null)}>{t('binderTypes.done')}</button>
              </div>
            </div>
          )}

          {selectedCardTab === 'equivalents' && (isWishlist || isCollection) && (
                <div className="rounded-xl bg-bg-card/60 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{t('binderTypes.equivalentPrints')}</p>
                      <p className="text-xs text-text-muted">{isCollection ? t('binderTypes.equivalentPrintsCollectionHelp') : t('binderTypes.equivalentPrintsHelp')}</p>
                    </div>
                    {equivalentPrintsLoading && <span className="text-xs text-text-muted">{t('common.loading')}</span>}
                  </div>

                  {!equivalentPrintsLoading && (equivalentPrintsData?.equivalents || []).length === 0 && (
                    <p className="text-xs text-text-muted">{t('binderTypes.noEquivalentPrints')}</p>
                  )}

                  {(equivalentPrintsData?.equivalents || []).length > 0 && (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {equivalentPrintsData.equivalents.map((print) => {
                        const imageUrl = resolveCardImageUrl(print)
                        return (
                          <div key={print.collection_item_id || print.id} className={`flex items-center gap-3 rounded-lg border p-2 ${print.is_current ? 'border-yellow/40 bg-yellow/5' : 'border-border bg-bg/40'}`}>
                            <CardDisplay
                              variant="compact-artwork"
                              card={print}
                              image={imageUrl}
                              alt={print.name}
                              variantEffectSource={print.variant}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-text-primary truncate">{print.set_name || print.set_id} #{print.number}</p>
                              <div className="flex items-center gap-2 flex-wrap text-[11px] text-text-muted">
                                {print.lang && <span>{tcgdexLanguageLabel(print.lang)}</span>}
                                {print.rarity && <span>{print.rarity}</span>}
                                <span>{print.price_market > 0 ? formatPrice(print.price_market) : t('binderTypes.noPriceDataShort')}</span>
                                {print.variant && <span>{print.variant}</span>}
                                {print.condition && <span>{print.condition}</span>}
                                {print.owned && <span className="text-green font-semibold">{t('binderTypes.owned')} {print.owned_quantity}x</span>}
                                {isCollection && !print.is_current && print.available_quantity < (selectedCard.required_quantity || 1) && <span className="text-yellow font-semibold">{t('binderTypes.alreadyUsed')}</span>}
                                {print.is_current && <span className="text-yellow font-semibold">{t('binderTypes.currentPrint')}</span>}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn-ghost px-2 py-1 text-xs flex-shrink-0"
                              disabled={print.is_current || switchPrintMutation.isPending || (isCollection && print.available_quantity < (selectedCard.required_quantity || 1))}
                              onClick={() => switchPrintMutation.mutate({ binderCardId: selectedCard.binder_card_id, cardId: print.id, collectionItemId: print.collection_item_id })}
                            >
                              {print.is_current ? t('binderTypes.currentPrint') : t('binderTypes.switchPrint')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
          )}
        </CardDialog>
      )}
    </div>
  )
}
