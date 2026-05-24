import { useState, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, Package, Star, Download, Upload, X, Heart, Minus } from 'lucide-react'
import { getBinderCards, removeCardFromBinder, removeBinderEntry, addCardToBinder, addCollectionItemToBinder, searchCards, getCollection, updateBinderEntry, addBinderEntryToWishlist, importBinderCsv, exportBinderCsv } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { useTilt } from '../hooks/useTilt'
import { resolveCardImageUrl } from '../utils/imageUrl'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'
const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']

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
  const { t } = useSettings()
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
  const fileInputRef = useRef(null)

  const { data, isLoading } = useQuery({
    queryKey: ['binder-cards', binderId],
    queryFn: () => getBinderCards(parseInt(binderId)).then(r => r.data),
  })

  const binder = data?.binder
  const binderType = binder?.binder_type || 'collection'
  const isWishlist = binderType === 'wishlist'

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
      const numberMatch = card.number?.toString() === q
      const codeMatch = /^([A-Za-z]+\d*)\s+(\d+)$/.exec(q)
      let shortcodeMatch = false
      if (codeMatch) {
        const [, setCode, num] = codeMatch
        const normalizedNum = String(parseInt(num, 10))
        const cardNum = (card.number || '').toString().replace(/^0+/, '') || '0'
        shortcodeMatch = [card.set_ref?.abbreviation, card.set_id, card.set_ref?.tcg_set_id]
          .some(value => value?.toLowerCase() === setCode) && cardNum === normalizedNum
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || 'Update failed'),
  })

  const wishlistMutation = useMutation({
    mutationFn: (binderCardId) => addBinderEntryToWishlist(parseInt(binderId), binderCardId),
    onSuccess: () => {
      toast.success(t('binderTypes.addToWishlist') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const importMutation = useMutation({
    mutationFn: (file) => importBinderCsv(parseInt(binderId), file),
    onSuccess: (result) => {
      toast.success(`CSV: ${result.added} added, ${result.updated} updated${result.failed ? `, ${result.failed} failed` : ''}`)
      if (result.errors?.length) console.warn('Binder CSV import errors', result.errors)
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || 'CSV import failed'),
  })

  const exportMutation = useMutation({
    mutationFn: () => exportBinderCsv(parseInt(binderId)),
    onError: () => toast.error('CSV export failed'),
  })

  if (isLoading) return <div className="skeleton h-64 rounded-xl" />

  const cards = data?.cards || []
  const ownedCount = data?.owned_count ?? cards.reduce((sum, c) => sum + Math.min(c.owned_quantity || 0, c.required_quantity || 1), 0)
  const totalCount = data?.total_required_count ?? data?.total_count ?? cards.length
  const missingCount = data?.missing_count ?? cards.reduce((sum, c) => sum + (c.missing_quantity || 0), 0)
  const binderValue = data?.binder_value ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (isWishlist ? (c.required_quantity || 1) : (c.quantity || 0))), 0)
  const costToComplete = data?.cost_to_complete ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (c.missing_quantity || 0)), 0)
  const progressPct = totalCount > 0 ? Math.round((ownedCount / totalCount) * 100) : 0
  const binderSets = [...new Set(cards.map(c => c.set_name || c.set_id).filter(Boolean))].sort()
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
    setSelectedCard({ ...card, required_quantity: next, missing_quantity: Math.max(next - (card.owned_quantity || 0), 0) })
  }

  const handleImportFile = (event) => {
    const file = event.target.files?.[0]
    if (file) importMutation.mutate(file)
    event.target.value = ''
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
          <p className="text-xs text-text-muted mt-1">{cards.length} {t('binderTypes.cards')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setShowSearch(!showSearch)} className="btn-primary flex-shrink-0">
            <Plus size={16} /> {t('common.add')} {t('nav.cards')}
          </button>
          {isWishlist && (
            <button onClick={() => fileInputRef.current?.click()} className="btn-ghost flex-shrink-0" disabled={importMutation.isPending}>
              <Upload size={16} /> CSV
            </button>
          )}
          <button onClick={() => exportMutation.mutate()} className="btn-ghost flex-shrink-0" disabled={exportMutation.isPending || cards.length === 0}>
            <Download size={16} /> CSV
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="card p-3"><p className="text-xs text-text-muted">{t('binderTypes.required')}</p><p className="text-lg font-bold text-text-primary">{totalCount}</p></div>
        <div className="card p-3"><p className="text-xs text-text-muted">{t('binderTypes.owned')}</p><p className="text-lg font-bold text-green">{ownedCount}</p></div>
        <div className="card p-3"><p className="text-xs text-text-muted">{t('binderTypes.missing')}</p><p className="text-lg font-bold text-brand-red">{missingCount}</p></div>
        <div className="card p-3"><p className="text-xs text-text-muted">{isWishlist ? t('binderTypes.costToComplete') : t('binderTypes.binderValue')}</p><p className="text-lg font-bold text-yellow">€{(isWishlist ? costToComplete : binderValue).toFixed(2)}</p></div>
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
                    return (
                      <div key={`${card.id}-${item.id}`}
                        className={`relative rounded-lg overflow-hidden cursor-pointer group ${alreadyAdded ? 'opacity-40' : ''}`}
                        onClick={() => !alreadyAdded && addCollectionItemMutation.mutate(item.id)}
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
                  {card.price_market && <p className="text-xs text-green">€{card.price_market.toFixed(2)}</p>}
                </div>

                <button onClick={(e) => { e.stopPropagation(); removeMutation.mutate({ cardId: card.id, binderCardId: card.binder_card_id }) }}
                  className="absolute top-1 right-1 bg-bg/80 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-brand-red hover:text-brand-red-light">
                  <Trash2 size={10} />
                </button>

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

      {selectedCard && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setSelectedCard(null)}>
          <div className="bg-bg-surface border border-border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-bold text-text-primary truncate">{selectedCard.name}</h2>
                  <p className="text-xs text-text-muted">{selectedCard.set_name || selectedCard.set_id} #{selectedCard.number}</p>
                </div>
                <button onClick={() => setSelectedCard(null)} className="text-text-muted hover:text-text-primary p-1"><X size={18} /></button>
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
                  <div>
                    <p className="text-xs text-text-muted mb-1">{t('binderTypes.requiredInBinder')}</p>
                    <div className="flex items-center gap-2">
                      <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, -1)} disabled={updateEntryMutation.isPending || (selectedCard.required_quantity || 1) <= 1}><Minus size={14} /></button>
                      <span className="text-lg font-bold text-text-primary min-w-8 text-center">{selectedCard.required_quantity || 1}</span>
                      <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, 1)} disabled={updateEntryMutation.isPending}><Plus size={14} /></button>
                    </div>
                  </div>
                  {selectedCard.price_market && <p className="text-xs text-text-muted">{t('binderTypes.marketPrice')}: <span className="text-green font-semibold">€{selectedCard.price_market.toFixed(2)}</span></p>}
                  {(selectedCard.variant || selectedCard.condition) && <p className="text-xs text-text-muted">{[selectedCard.variant, selectedCard.condition].filter(Boolean).join(' · ')}</p>}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button className="btn-ghost justify-center" onClick={() => wishlistMutation.mutate(selectedCard.binder_card_id)}>
                  <Heart size={16} /> {t('binderTypes.addToWishlist')}
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
