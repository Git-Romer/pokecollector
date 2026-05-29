import { useState, useMemo, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, Package, Star, Download, Upload, X, Heart, Minus } from 'lucide-react'
import { getBinderCards, removeCardFromBinder, removeBinderEntry, addCardToBinder, addCollectionItemToBinder, searchCards, getCollection, updateBinderEntry, getBinderEntryEquivalentPrints, getBinderPrintOptimization, applyBinderPrintOptimization, switchBinderEntryCard, addBinderEntryToWishlist, addBinderCardsToWishlist, importBinderCsv, exportBinderCsv, getApiErrorMessage } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { useTilt } from '../hooks/useTilt'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { cardNumberMatches } from '../utils/cardNumbers'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'
const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']
const BINDER_CSV_IMPORT_HEADER = 'set_code,number,required_quantity,lang'
const BINDER_CSV_IMPORT_TEMPLATE = `${BINDER_CSV_IMPORT_HEADER}\nBLK,057,4,de\n`

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
  const [selectedCard, setSelectedCard] = useState(null)
  const [showCsvImportModal, setShowCsvImportModal] = useState(false)
  const [showPrintOptimizer, setShowPrintOptimizer] = useState(false)
  const [selectedPrintOptimizationIds, setSelectedPrintOptimizationIds] = useState([])
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
    const q = searchQuery.toLowerCase().trim()
    return collectionData.filter(item => {
      const card = item.card
      if (!card) return false
      if (filterSet && card.set_ref?.id !== filterSet) return false
      if (filterVariant && (item.variant || '') !== filterVariant) return false
      if (filterCondition && item.condition !== filterCondition) return false
      if (!q) return true
      const nameMatch = card.name?.toLowerCase().includes(q)
      const setMatch = card.set_ref?.name?.toLowerCase().includes(q)
      const numberMatch = cardNumberMatches(card.number, q)
      const codeMatch = /^([A-Za-z]+\d*)\s+(\d+)$/.exec(q)
      let shortcodeMatch = false
      if (codeMatch) {
        const [, setCode, num] = codeMatch
        const normalizedNum = String(parseInt(num, 10))
        shortcodeMatch = [card.set_ref?.abbreviation, card.set_id, card.set_ref?.tcg_set_id]
          .some(value => value?.toLowerCase() === setCode) && cardNumberMatches(card.number, normalizedNum)
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

  const addMutation = useMutation({
    mutationFn: (cardId) => addCardToBinder(parseInt(binderId), cardId),
    onSuccess: () => {
      toast.success(t('common.add') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const addCollectionItemMutation = useMutation({
    mutationFn: (collectionItemId) => addCollectionItemToBinder(parseInt(binderId), collectionItemId),
    onSuccess: () => {
      toast.success(t('common.add') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const removeMutation = useMutation({
    mutationFn: ({ cardId, binderCardId }) => binderCardId
      ? removeBinderEntry(parseInt(binderId), binderCardId)
      : removeCardFromBinder(parseInt(binderId), cardId),
    onSuccess: () => {
      toast.success(t('common.remove') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
  })

  const updateEntryMutation = useMutation({
    mutationFn: ({ binderCardId, requiredQuantity }) => updateBinderEntry(parseInt(binderId), binderCardId, { required_quantity: requiredQuantity }),
    onSuccess: (_data, variables) => {
      setSelectedCard(prev => {
        if (!prev || prev.binder_card_id !== variables.binderCardId) return prev
        return {
          ...prev,
          required_quantity: variables.requiredQuantity,
          missing_quantity: Math.max(variables.requiredQuantity - (prev.owned_quantity || 0), 0),
        }
      })
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || 'Update failed'),
  })

  useEffect(() => {
    if (!selectedCard) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setSelectedCard(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    selectedCardCloseRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedCard])

  const wishlistMutation = useMutation({
    mutationFn: (binderCardId) => addBinderEntryToWishlist(parseInt(binderId), binderCardId),
    onSuccess: (result) => {
      if (result?.added > 0) {
        toast.success((isWishlist ? t('binderTypes.addMissingToWishlist') : t('binderTypes.addToWishlist')) + ' ✓')
      } else if (result?.skipped_complete > 0) {
        toast(t('binderTypes.alreadyCompleteInCollection'))
      } else {
        toast(t('binderTypes.alreadyInWishlist'))
      }
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const bulkWishlistMutation = useMutation({
    mutationFn: () => addBinderCardsToWishlist(parseInt(binderId)),
    onSuccess: (result) => {
      const summary = `${result.added} ${t('binderTypes.added')}, ${result.missing_copies || 0} ${t('binderTypes.missingCopies')}, ${result.skipped} ${t('binderTypes.skipped')}`
      if (result.added > 0) {
        toast.success(`${t('binderTypes.addMissingToWishlist')} ✓ (${summary})`)
      } else if (result.skipped_complete > 0 && result.skipped_existing === 0) {
        toast(`${t('binderTypes.alreadyCompleteInCollection')} (${summary})`)
      } else {
        toast(`${t('binderTypes.alreadyInWishlist')} (${summary})`)
      }
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
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
  const visibleCards = cards.filter(card => {
    const query = binderFilterQuery.trim().toLowerCase()
    if (query && ![card.name, card.set_name, card.set_id, card.number].some(value => String(value || '').toLowerCase().includes(query))) return false
    if (binderFilterSet && (card.set_name || card.set_id) !== binderFilterSet) return false
    if (binderFilterStatus === 'owned' && (card.missing_quantity || 0) > 0) return false
    if (binderFilterStatus === 'missing' && (card.missing_quantity || 0) === 0) return false
    return true
  })

  const changeRequiredQuantity = (card, delta) => {
    const next = Math.max(1, Math.min(99, (card.required_quantity || 1) + delta))
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
          <p className="text-xs text-text-muted mt-1">{totalCount} {t('binderTypes.cards')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setShowSearch(!showSearch)} className="btn-primary flex-shrink-0">
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
          <h3 className="text-base font-semibold text-text-primary mb-3">
            {isWishlist ? t('binderTypes.addAnyCard') : t('binderTypes.addFromCollection')}
          </h3>
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
                    return (
                      <div key={card.id}
                        className={`relative rounded-lg overflow-hidden cursor-pointer group ${alreadyAdded ? 'opacity-40' : ''}`}
                        onClick={() => !alreadyAdded && addMutation.mutate(card.id)}>
                        {(card.images?.small || resolveCardImageUrl(card) || card.image) ? (
                          <img src={resolveCardImageUrl(card)}
                            alt={card.name} className="w-full aspect-[2.5/3.5] object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full aspect-[2.5/3.5] bg-bg-card flex items-center justify-center text-xs text-text-muted p-1 text-center">
                            {card.name}
                          </div>
                        )}
                        {!alreadyAdded && (
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                            <Plus size={20} className="text-white" />
                          </div>
                        )}
                      </div>
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
                    const alreadyAdded = cards.some(c => c.collection_item_id === item.id)
                    const unavailable = unavailableCollectionItemIds.has(item.id)
                    return (
                      <div key={`${card.id}-${item.id}`}
                        className={`relative rounded-lg overflow-hidden cursor-pointer group ${alreadyAdded || unavailable ? 'opacity-40' : ''}`}
                        onClick={() => !alreadyAdded && !unavailable && addCollectionItemMutation.mutate(item.id)}
                        title={`${card.name}${item.variant ? ` (${item.variant})` : ''} · ${item.quantity}x`}>
                        {resolveCardImageUrl(card) ? (
                          <img src={resolveCardImageUrl(card)} alt={card.name} className="w-full aspect-[2.5/3.5] object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full aspect-[2.5/3.5] bg-bg-card flex items-center justify-center text-xs text-text-muted p-1 text-center">
                            {card.name}
                          </div>
                        )}
                        <div className="absolute top-0.5 left-0.5 bg-bg/80 text-text-primary text-xs rounded px-1">{item.quantity}x</div>
                        {(item.variant || item.condition) && (
                          <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-white text-[9px] text-center truncate px-1">
                            {[item.variant || 'Normal', item.condition].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        {unavailable && !alreadyAdded && (
                          <div className="absolute inset-0 bg-black/65 flex items-center justify-center text-white text-[10px] text-center px-1">
                            {t('binderTypes.alreadyUsed')}
                          </div>
                        )}
                        {!alreadyAdded && !unavailable && (
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100">
                            <Plus size={20} className="text-white" />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {searchQuery.length >= 2 && collectionSearchResults.length === 0 && (
                <p className="text-text-muted text-sm text-center py-4">{t('common.noResults')}</p>
              )}
            </>
          )}
        </div>
      )}

      {cards.length > 0 && (
        <div className="card p-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
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
            const isComplete = (card.missing_quantity || 0) === 0
            const isMissing = isWishlist && (card.missing_quantity || 0) > 0

            return (
              <TiltBinderCard key={card.binder_card_id || card.id} className="relative group rounded-xl overflow-hidden card p-0 cursor-pointer" onClick={() => setSelectedCard(card)}>
                {resolveCardImageUrl(card) ? (
                  <img src={resolveCardImageUrl(card)} alt={card.name}
                    className={`w-full aspect-[2.5/3.5] object-cover transition-all ${isMissing ? 'grayscale opacity-60' : ''}`}
                    loading="lazy" />
                ) : (
                  <div className={`w-full aspect-[2.5/3.5] bg-bg-card flex items-center justify-center text-xs text-text-muted p-1 text-center ${isMissing ? 'grayscale opacity-60' : ''}`}>
                    {card.name}
                  </div>
                )}
                <div className="p-1.5">
                  <p className="text-xs text-text-primary font-medium truncate">{card.name}</p>
                  {card.price_market > 0 ? (
                    <p className="text-xs text-green">{formatPrice(card.price_market)}</p>
                  ) : (
                    <p className="text-xs text-text-muted">{t('binderTypes.noPriceDataShort')}</p>
                  )}
                </div>

                {isWishlist && (
                  <div className={`absolute top-1 left-1 rounded-full text-white text-xs px-1.5 py-0.5 font-medium ${
                    isComplete ? 'bg-green/90' : 'bg-bg-elevated/90 text-text-secondary'
                  }`}>
                    {(card.owned_quantity || 0) >= (card.required_quantity || 1) ? `✓ ${card.owned_quantity || 0}/${card.required_quantity || 1}` : `${card.owned_quantity || 0}/${card.required_quantity || 1}`}
                  </div>
                )}

                {!isWishlist && card.in_collection && (
                  <div className="absolute top-1 left-1 bg-green/80 rounded-full text-white text-xs px-1">
                    {card.quantity}x
                  </div>
                )}
              </TiltBinderCard>
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
                        <div key={item.binder_card_id} className={`rounded-xl border p-3 space-y-2 ${isSelected ? 'border-yellow/40 bg-yellow/5' : 'border-border bg-bg-card/60'}`}>
                          <label className="flex items-start gap-3 cursor-pointer">
                            <input
                              type="checkbox"
                              className="mt-1 accent-brand-red"
                              checked={isSelected}
                              onChange={() => togglePrintOptimizationSelection(item.binder_card_id)}
                            />
                            <div className="min-w-0 flex-1 space-y-2">
                              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
                                <div className="min-w-0 flex items-center gap-2">
                                  {resolveCardImageUrl(item.current) && <img src={resolveCardImageUrl(item.current)} alt={item.current.name} className="w-9 aspect-[2.5/3.5] object-cover rounded" loading="lazy" />}
                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold text-text-primary truncate">{item.current.set_name || item.current.set_id} #{item.current.number}</p>
                                    <p className="text-[11px] text-text-muted">{item.current_price ? formatPrice(item.current_price) : t('binderTypes.noPriceDataShort')}</p>
                                    {(item.current.variant || item.current.condition) && <p className="text-[10px] text-text-muted truncate">{[item.current.variant, item.current.condition].filter(Boolean).join(' · ')}</p>}
                                  </div>
                                </div>
                                <span className="text-text-muted text-xs">→</span>
                                <div className="min-w-0 flex items-center gap-2 justify-end text-right">
                                  <div className="min-w-0">
                                    <p className="text-xs font-semibold text-text-primary truncate">{item.suggested.set_name || item.suggested.set_id} #{item.suggested.number}</p>
                                    <p className="text-[11px] text-green">{formatPrice(item.suggested_price)}</p>
                                    {(item.suggested.variant || item.suggested.condition) && <p className="text-[10px] text-text-muted truncate">{[item.suggested.variant, item.suggested.condition].filter(Boolean).join(' · ')}</p>}
                                  </div>
                                  {resolveCardImageUrl(item.suggested) && <img src={resolveCardImageUrl(item.suggested)} alt={item.suggested.name} className="w-9 aspect-[2.5/3.5] object-cover rounded" loading="lazy" />}
                                </div>
                              </div>
                              <p className="text-[11px] text-text-muted">
                                {item.required_quantity}x · {t('binderTypes.estimatedSavings')}: {formatPrice(item.total_savings)}
                              </p>
                            </div>
                          </label>
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
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setSelectedCard(null)}>
          <div
            className="bg-bg-surface border border-border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="binder-card-dialog-title"
          >
            <div className="p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="binder-card-dialog-title" className="text-lg font-bold text-text-primary truncate">{selectedCard.name}</h2>
                  <p className="text-xs text-text-muted">{selectedCard.set_name || selectedCard.set_id} #{selectedCard.number}</p>
                </div>
                <button ref={selectedCardCloseRef} onClick={() => setSelectedCard(null)} className="text-text-muted hover:text-text-primary p-1" aria-label={t('common.close')}><X size={18} /></button>
              </div>

              <div className="grid grid-cols-[120px_1fr] gap-4">
                {resolveCardImageUrl(selectedCard) ? (
                  <img src={resolveCardImageUrl(selectedCard)} alt={selectedCard.name} className="w-full rounded-xl" />
                ) : (
                  <div className="aspect-[2.5/3.5] rounded-xl bg-bg-card flex items-center justify-center text-xs text-text-muted text-center p-2">{selectedCard.name}</div>
                )}
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-bg-card p-2"><p className="text-xs text-text-muted">{t('binderTypes.owned')}</p><p className="font-bold text-green">{selectedCard.owned_quantity || 0}</p></div>
                    <div className="rounded-lg bg-bg-card p-2"><p className="text-xs text-text-muted">{t('binderTypes.missing')}</p><p className="font-bold text-brand-red">{selectedCard.missing_quantity || 0}</p></div>
                  </div>
                  {isWishlist ? (
                    <div>
                      <p className="text-xs text-text-muted mb-1">{t('binderTypes.requiredInBinder')}</p>
                      <div className="flex items-center gap-2">
                        <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, -1)} disabled={updateEntryMutation.isPending || (selectedCard.required_quantity || 1) <= 1}><Minus size={14} /></button>
                        <span className="text-lg font-bold text-text-primary min-w-8 text-center">{selectedCard.required_quantity || 1}</span>
                        <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, 1)} disabled={updateEntryMutation.isPending}><Plus size={14} /></button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted">{t('binderTypes.collectionQuantityLocked')}</p>
                  )}
                  <p className="text-xs text-text-muted">
                    {t('binderTypes.marketPrice')}: {selectedCard.price_market > 0 ? (
                      <span className="text-green font-semibold">{formatPrice(selectedCard.price_market)}</span>
                    ) : (
                      <span>{t('binderTypes.noPriceData')}</span>
                    )}
                  </p>
                  {(selectedCard.variant || selectedCard.condition) && <p className="text-xs text-text-muted">{[selectedCard.variant, selectedCard.condition].filter(Boolean).join(' · ')}</p>}
                </div>
              </div>

              {(isWishlist || isCollection) && (
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
                            {imageUrl ? (
                              <img src={imageUrl} alt={print.name} className="w-10 aspect-[2.5/3.5] object-cover rounded" loading="lazy" />
                            ) : (
                              <div className="w-10 aspect-[2.5/3.5] rounded bg-bg-elevated flex items-center justify-center text-[9px] text-text-muted text-center px-1">{print.name}</div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-text-primary truncate">{print.set_name || print.set_id} #{print.number}</p>
                              <div className="flex items-center gap-2 flex-wrap text-[11px] text-text-muted">
                                {print.lang && <span>{print.lang.toUpperCase()}</span>}
                                {print.rarity && <span>{print.rarity}</span>}
                                <span>{print.price_market > 0 ? formatPrice(print.price_market) : t('binderTypes.noPriceDataShort')}</span>
                                {print.variant && <span>{print.variant}</span>}
                                {print.condition && <span>{print.condition}</span>}
                                {print.owned && <span className="text-green font-semibold">{t('binderTypes.owned')} {print.owned_quantity}x</span>}
                                {isCollection && !print.is_current && print.available_quantity === 0 && <span className="text-yellow font-semibold">{t('binderTypes.alreadyUsed')}</span>}
                                {print.is_current && <span className="text-yellow font-semibold">{t('binderTypes.currentPrint')}</span>}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn-ghost px-2 py-1 text-xs flex-shrink-0"
                              disabled={print.is_current || switchPrintMutation.isPending || (isCollection && print.available_quantity === 0)}
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

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button className="btn-ghost justify-center" onClick={() => wishlistMutation.mutate(selectedCard.binder_card_id)}>
                  <Heart size={16} /> {isWishlist ? t('binderTypes.addMissingToWishlist') : t('binderTypes.addToWishlist')}
                </button>
                <button className="btn-ghost justify-center text-brand-red" onClick={() => { removeMutation.mutate({ cardId: selectedCard.id, binderCardId: selectedCard.binder_card_id }); setSelectedCard(null) }}>
                  <Trash2 size={16} /> {t('common.remove')}
                </button>
                <button className="btn-primary justify-center" onClick={() => setSelectedCard(null)}>{t('binderTypes.done')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
