import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, Search, Package, Star } from 'lucide-react'
import { getBinderCards, removeCardFromBinder, addCardToBinder, searchCards, getCollection } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { useTilt } from '../hooks/useTilt'

function TiltBinderCard({ className, onClick, children }) {
  const { ref, onMouseMove, onMouseLeave } = useTilt(10)
  return (
    <div
      ref={ref}
      className={className}
      onClick={onClick}
      onMouseMove={onMouseMove}
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
    if (!searchQuery || searchQuery.length < 2) return []
    return collectionData.filter(item =>
      item.card?.name?.toLowerCase().includes(searchQuery.toLowerCase())
    ).slice(0, 24)
  }, [collectionData, searchQuery, isWishlist])

  const addMutation = useMutation({
    mutationFn: (cardId) => addCardToBinder(parseInt(binderId), cardId),
    onSuccess: () => {
      toast.success(t('common.add') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const removeMutation = useMutation({
    mutationFn: (cardId) => removeCardFromBinder(parseInt(binderId), cardId),
    onSuccess: () => {
      toast.success(t('common.remove') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
  })

  if (isLoading) return <div className="skeleton h-64 rounded-xl" />

  const cards = data?.cards || []
  const ownedCount = data?.owned_count ?? cards.filter(c => c.owned).length
  const totalCount = data?.total_count ?? cards.length
  const progressPct = totalCount > 0 ? Math.round((ownedCount / totalCount) * 100) : 0

  return (
    <div className="space-y-4 pb-2">
      <button onClick={() => navigate('/binders')} className="btn-ghost text-sm py-1.5">
        <ArrowLeft size={14} /> {t('nav.binders')}
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: binder?.color }} />
            {isWishlist ? (
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
        <button onClick={() => setShowSearch(!showSearch)} className="btn-primary flex-shrink-0">
          <Plus size={16} /> {t('common.add')} {t('nav.cards')}
        </button>
      </div>

      {/* Wishlist progress bar */}
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
            <span className="text-brand-red">{totalCount - ownedCount} {t('binderTypes.missing')}</span>
          </div>
        </div>
      )}

      {/* Card Search to Add */}
      {showSearch && (
        <div className="card border-brand-red/20">
          <h3 className="text-base font-semibold text-text-primary mb-3">
            {isWishlist ? t('binderTypes.addAnyCard') : t('binderTypes.addFromCollection')}
          </h3>
          <input type="text"
            placeholder={isWishlist ? t('binderTypes.searchAll') : t('binderTypes.searchCollection')}
            value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            className="input mb-4" autoFocus />

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
                        {(card.images?.small || card.images_small || card.image) ? (
                          <img src={card.images?.small || card.images_small || `${card.image}/low.webp`}
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
                    const alreadyAdded = cards.some(c => c.id === card.id)
                    return (
                      <div key={`${card.id}-${item.id}`}
                        className={`relative rounded-lg overflow-hidden cursor-pointer group ${alreadyAdded ? 'opacity-40' : ''}`}
                        onClick={() => !alreadyAdded && addMutation.mutate(card.id)}
                        title={`${card.name}${item.variant ? ` (${item.variant})` : ''} · ${item.quantity}x`}>
                        {card.images_small ? (
                          <img src={card.images_small} alt={card.name} className="w-full aspect-[2.5/3.5] object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full aspect-[2.5/3.5] bg-bg-card flex items-center justify-center text-xs text-text-muted p-1 text-center">
                            {card.name}
                          </div>
                        )}
                        <div className="absolute top-0.5 left-0.5 bg-bg/80 text-text-primary text-xs rounded px-1">{item.quantity}x</div>
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

      {/* Cards Grid */}
      {cards.length === 0 ? (
        <div className="card text-center py-20">
          <p className="text-text-muted">
            {isWishlist ? '⭐ No cards in this wishlist binder yet' : '📦 No cards in this binder yet'}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {isWishlist ? t('binderTypes.addAnyCard') : t('binderTypes.addFromCollection')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 sm:gap-3">
          {cards.map((card) => {
            const isOwned = card.owned || card.in_collection
            const isMissing = isWishlist && !isOwned

            return (
              <TiltBinderCard key={card.id} className="relative group rounded-xl overflow-hidden card p-0">
                {card.images_small ? (
                  <img src={card.images_small} alt={card.name}
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

                <button onClick={() => removeMutation.mutate(card.id)}
                  className="absolute top-1 right-1 bg-bg/80 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-brand-red hover:text-brand-red-light">
                  <Trash2 size={10} />
                </button>

                {isWishlist && (
                  <div className={`absolute top-1 left-1 rounded-full text-white text-xs px-1.5 py-0.5 font-medium ${
                    isOwned ? 'bg-green/90' : 'bg-bg-elevated/90 text-text-secondary'
                  }`}>
                    {isOwned ? `✓ ${t('binderTypes.owned')}` : `✗ ${t('binderTypes.missing')}`}
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
    </div>
  )
}
