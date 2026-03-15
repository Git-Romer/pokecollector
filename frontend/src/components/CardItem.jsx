import { useState, useEffect, memo } from 'react'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Plus, Check, Heart, BookOpen, X, PenLine, Pencil,  Trash2 } from 'lucide-react'
import { addToCollection, addToWishlist, createCustomCard, updateCustomCard, deleteCustomCard, getSets, getPriceHistory } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import PeriodSelector, { CARD_PERIODS, PERIOD_PRICE_FIELD } from './PeriodSelector'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { useTilt } from '../hooks/useTilt'
import { resolveCardImageUrl } from '../utils/imageUrl'

const RARITY_COLORS = {
  'Common': 'text-text-secondary',
  'Uncommon': 'text-green',
  'Rare': 'text-blue',
  'Rare Holo': 'text-purple-400',
  'Rare Ultra': 'text-yellow',
  'Rare Secret': 'text-orange-400',
  'Illustration Rare': 'text-pink-400',
  'Special Illustration Rare': 'text-pink-500',
  'Hyper Rare': 'text-yellow',
}

const PRICE_FIELD_MAP = {
  avg: 'price_market',
  market: 'price_market',
  low: 'price_low',
  trend: 'price_trend',
  avg1: 'price_avg1',
  avg7: 'price_avg7',
  avg30: 'price_avg30',
}

function getPriceValue(card, priceKey) {
  const field = PRICE_FIELD_MAP[priceKey] || priceKey
  return card[field]
    ?? card.cardmarket?.prices?.[priceKey]
    ?? card.pricing?.cardmarket?.[priceKey]
    ?? null
}

const POKEMON_TYPES = ['Fire', 'Water', 'Grass', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless', 'Fairy', 'Stellar']

export function CustomCardModal({ onClose, onCreated, sets: setsProp = [], autoAddCollection = false, editCard = null }) {
  const { t } = useSettings()
  const [name, setName] = useState(editCard?.name || '')
  const [setChoice, setSetChoice] = useState('')
  const [customSetId, setCustomSetId] = useState('')
  const [number, setNumber] = useState(editCard?.number || '')
  const [rarity, setRarity] = useState(editCard?.rarity || '')
  const [selectedTypes, setSelectedTypes] = useState(editCard?.types || [])
  const [hp, setHp] = useState(editCard?.hp || '')
  const [artist, setArtist] = useState(editCard?.artist || '')
  const [imageUrl, setImageUrl] = useState(editCard?.images_small || editCard?.image_url || '')

  const [createdCard, setCreatedCard] = useState(null)
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState('')
  const [purchasePrice, setPurchasePrice] = useState('')
  const queryClient = useQueryClient()

  const { data: fetchedSets = [] } = useQuery({
    queryKey: ['sets'],
    queryFn: () => getSets().then(r => r.data),
    staleTime: 60000,
    enabled: setsProp.length === 0,
  })
  const sets = setsProp.length > 0 ? setsProp : fetchedSets

  // Resolve editCard.set_id (TCGdex ID like 'pfl') to composite dropdown key ('pfl_de')
  useEffect(() => {
    if (editCard?.set_id && sets.length > 0 && !setChoice) {
      const match = sets.find(s => s.tcg_set_id === editCard.set_id && s.lang === editCard.lang)
        || sets.find(s => s.tcg_set_id === editCard.set_id)
        || sets.find(s => s.id === editCard.set_id)
      if (match) setSetChoice(match.id)
    }
  }, [sets, editCard])

  const isEditMode = !!editCard

  const createMutation = useMutation({
    mutationFn: (data) => createCustomCard(data),
    onSuccess: (res) => {
      toast.success(t('cardSearch.customCardCreated'))
      if (autoAddCollection) {
        setCreatedCard(res.data)
      } else {
        onCreated && onCreated(res.data)
        onClose()
      }
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data) => updateCustomCard(editCard.id, data),
    onSuccess: (res) => {
      toast.success(t('settings.cardUpdated'))
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      onCreated && onCreated(res)
      onClose()
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomCard(editCard.id),
    onSuccess: (res) => {
      toast.success(res?.data?.message || t('common.success'))
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['custom-cards'] })
      onClose()
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const addMutation = useMutation({
    mutationFn: (data) => addToCollection(data),
    onSuccess: () => {
      toast.success(`${createdCard.name} ${t('card.addedToCollection')}`)
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      onCreated && onCreated(createdCard)
      onClose()
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const handleCreate = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    const effectiveSetId = setChoice === '__custom__' ? customSetId.trim() : setChoice || undefined
    const selectedSet = effectiveSetId ? sets.find(s => s.id === effectiveSetId) : null
    // Use the original TCGdex set ID (tcg_set_id) for cards.set_id, not the composite DB key
    const setIdForCard = selectedSet?.tcg_set_id || effectiveSetId || undefined
    const payload = {
      name: name.trim(),
      set_id: setIdForCard,
      number: number.trim() || undefined,
      rarity: rarity || undefined,
      types: selectedTypes.length > 0 ? selectedTypes : undefined,
      hp: hp.trim() || undefined,
      artist: artist.trim() || undefined,
      image_url: imageUrl.trim() || undefined,
      lang: selectedSet?.lang || 'en',
    }
    if (isEditMode) {
      updateMutation.mutate(payload)
    } else {
      createMutation.mutate(payload)
    }
  }

  const handleAddToCollection = () => {
    addMutation.mutate({
      card_id: createdCard.id,
      quantity,
      condition,
      variant: variant || null,
      purchase_price: purchasePrice ? parseFloat(purchasePrice) : undefined,
      lang: createdCard.lang || 'en',
    })
  }

  const toggleType = (tp) => {
    setSelectedTypes(prev => prev.includes(tp) ? prev.filter(t => t !== tp) : [...prev, tp])
  }

  const handleDelete = () => {
    if (!editCard) return
    if (!window.confirm(t('common.confirm_delete'))) return
    deleteMutation.mutate()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 md:flex md:items-center md:justify-center md:bg-black/80 md:backdrop-blur-sm"
      onClick={onClose}>
      <div className={[
        'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
        'bg-bg-surface border-t border-border more-sheet-enter',
        'md:static md:rounded-2xl md:border md:max-w-lg md:w-full md:max-h-[85vh] md:animate-none',
      ].join(' ')} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <PenLine size={18} className="text-brand-red" />
              <h2 className="text-lg font-bold text-text-primary">
                {isEditMode ? t('card.editCard') : t('cardSearch.createCustomCard')}
              </h2>
              <span className="text-xs bg-yellow/20 text-yellow px-2 py-0.5 rounded-full">✏️ {t('cardSearch.customCard')}</span>
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
              <X size={20} />
            </button>
          </div>

          {!createdCard ? (
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="text-xs text-text-secondary mb-1 block font-medium">
                  {t('common.name')} <span className="text-brand-red">*</span>
                </label>
                <input type="text" required placeholder="z.B. Glurak ex" value={name}
                  onChange={(e) => setName(e.target.value)} className="input" />
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-1 block">{t('common.set')}</label>
                <select className="select" value={setChoice} onChange={(e) => setSetChoice(e.target.value)}>
                  <option value="">{t('cardSearch.selectOrTypeSet')}</option>
                  {sets.map(s => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
                  <option value="__custom__">{t('cardSearch.customSetFreetext')}</option>
                </select>
                {setChoice === '__custom__' && (
                  <input type="text" placeholder={t('cardSearch.customSetIdPlaceholder')} value={customSetId}
                    onChange={(e) => setCustomSetId(e.target.value)} className="input mt-2" />
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('cardSearch.cardNumber')}</label>
                  <input type="text" placeholder="z.B. 025" value={number}
                    onChange={(e) => setNumber(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.rarity')}</label>
                  <input type="text" placeholder="z.B. Rare Holo" value={rarity}
                    onChange={(e) => setRarity(e.target.value)} className="input" />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-2 block">{t('common.type')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {POKEMON_TYPES.map(tp => (
                    <button key={tp} type="button" onClick={() => toggleType(tp)}
                      className={clsx(
                        'text-xs px-2 py-1 rounded-full border transition-all',
                        selectedTypes.includes(tp)
                          ? 'border-brand-red bg-brand-red/20 text-text-primary'
                          : 'border-border text-text-muted hover:border-text-muted'
                      )}>
                      {tp}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.hp')}</label>
                  <input type="text" placeholder="z.B. 200" value={hp}
                    onChange={(e) => setHp(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.artist')}</label>
                  <input type="text" placeholder="z.B. Mitsuhiro Arita" value={artist}
                    onChange={(e) => setArtist(e.target.value)} className="input" />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-1 block">{t('cardSearch.imageUrl')}</label>
                <input type="url" placeholder="https://..." value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)} className="input" />
                {imageUrl && (
                  <div className="mt-2 w-20 h-28 rounded overflow-hidden border border-border">
                    <img src={imageUrl} alt="preview" className="w-full h-full object-cover" onError={(e) => e.target.style.display = 'none'} />
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                {isEditMode && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                    className="btn-ghost text-brand-red border-brand-red/30 hover:bg-brand-red/10 px-3"
                  >
                    <Trash2 size={16} /> {deleteMutation.isPending ? t('common.deleting') : t('common.delete')}
                  </button>
                )}
                <button type="submit" disabled={(isEditMode ? updateMutation.isPending : createMutation.isPending) || !name.trim()} className="btn-primary flex-1">
                  {isEditMode
                    ? (updateMutation.isPending ? t('common.saving') : t('common.save'))
                    : (createMutation.isPending ? t('common.saving') : (autoAddCollection ? t('cardSearch.createAndAdd') : t('cardSearch.createCustomCard')))
                  }
                </button>
                <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-3 bg-bg-card rounded-xl border border-border">
                {resolveCardImageUrl(createdCard) ? (
                  <img src={resolveCardImageUrl(createdCard)} alt={createdCard.name} className="w-16 h-20 object-cover rounded" />
                ) : (
                  <div className="w-16 h-20 bg-bg-surface rounded flex items-center justify-center text-text-muted text-xl">🃏</div>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-text-primary">{createdCard.name}</p>
                    <span className="text-xs bg-yellow/20 text-yellow px-1.5 py-0.5 rounded">✏️</span>
                  </div>
                  {createdCard.set_id && <p className="text-xs text-text-muted">{createdCard.set_id}</p>}
                  {createdCard.rarity && <p className="text-xs text-text-muted">{createdCard.rarity}</p>}
                  <p className="text-xs text-green mt-1">{t('cardSearch.customCardCreated')}</p>
                </div>
              </div>

              <p className="text-sm text-text-secondary">{t('cardSearch.addToCollectionAfter')}:</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                  <input type="number" min="1" value={quantity}
                    onChange={(e) => setQuantity(parseInt(e.target.value) || 1)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                  <select value={condition} onChange={(e) => setCondition(e.target.value)} className="select">
                    {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
                <select value={variant} onChange={(e) => setVariant(e.target.value)} className="select">
                  <option value="">{t('variants.none')}</option>
                  {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <input type="number" step="0.01" min="0" placeholder={t('card.purchasePricePlaceholder')}
                  value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} className="input" />
              </div>
              <div className="flex gap-3">
                <button onClick={handleAddToCollection} disabled={addMutation.isPending} className="btn-primary flex-1">
                  <Plus size={16} /> {addMutation.isPending ? t('card.adding') : t('card.addToCollection')}
                </button>
                <button onClick={onClose} className="btn-ghost">{t('common.close')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const CardItem = memo(function CardItem({ card, showActions = true, onAddToBinder = null, compact = false, lang = null }) {
  const [showModal, setShowModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const { t, pricePrimary, formatPrice } = useSettings()
  const queryClient = useQueryClient()

  const addMutation = useMutation({
    mutationFn: (data) => addToCollection(data),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToCollection')}`)
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const wishlistMutation = useMutation({
    mutationFn: (data) => addToWishlist(data),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToWishlist')}`)
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
    },
    onError: () => toast.error(t('card.wishlistFailed')),
  })

  const cardImage = card.images?.small || resolveCardImageUrl(card) || (card.image ? `${card.image}/low.webp` : null)
  const cardName = card.name
  const cardRarity = card.rarity
  const setName = card.set?.name || card.set_ref?.name || ''
  const price = getPriceValue(card, pricePrimary)
    ?? card.cardmarket?.prices?.trendPrice
    ?? card.price_market
    ?? card.price_trend

  const rarityColor = RARITY_COLORS[cardRarity] || 'text-text-secondary'
  const { ref: tiltRef, onMouseMove: tiltMove, onMouseLeave: tiltLeave } = useTilt(10)

  if (compact) {
    return (
      <div ref={tiltRef} className="card cursor-pointer group p-2 hover:border-brand-red/20 transition-all" onClick={() => setShowModal(true)} onMouseMove={tiltMove} onMouseLeave={tiltLeave}>
        <div className="aspect-[2.5/3.5] w-full rounded-xl overflow-hidden ring-1 ring-white/5 group-hover:ring-2 group-hover:ring-brand-red/30 transition-all duration-200">
          {cardImage ? (
            <img src={cardImage} alt={cardName} className="w-full h-full object-cover shadow-lg group-hover:scale-[1.02] transition-transform duration-300" loading="lazy" />
          ) : (
            <div className="w-full h-full bg-bg-surface rounded flex items-center justify-center text-text-muted text-xs">
              {t('common.noImage')}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div ref={tiltRef} className="card cursor-pointer group hover:border-brand-red/20 transition-all" onClick={() => setShowModal(true)} onMouseMove={tiltMove} onMouseLeave={tiltLeave}>
        <div className="aspect-[2.5/3.5] w-full mb-3 rounded-xl overflow-hidden ring-1 ring-white/5 group-hover:ring-2 group-hover:ring-brand-red/30 transition-all duration-200">
          {cardImage ? (
            <img src={cardImage} alt={cardName} className="w-full h-full object-cover shadow-lg group-hover:scale-[1.02] transition-transform duration-300" loading="lazy" />
          ) : (
            <div className="w-full h-full bg-bg-surface rounded flex items-center justify-center text-text-muted text-sm">
              {t('common.noImage')}
            </div>
          )}
        </div>

        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-1">
            <h3 className="text-sm font-medium text-text-primary truncate">{cardName}</h3>
            {card.is_custom && (
              <span className="flex-shrink-0 text-xs bg-yellow/20 text-yellow px-1 py-0.5 rounded" title="Manual">✏️</span>
            )}
            {lang && (
              <span className={clsx(
                'flex-shrink-0 text-[10px] font-black px-1 py-0.5 rounded leading-none',
                lang === 'de'
                  ? 'bg-yellow/20 text-yellow border border-yellow/30'
                  : 'bg-blue/20 text-blue-400 border border-blue-400/30'
              )} title={lang === 'de' ? 'Deutsche Karte' : 'English card'}>
                {lang.toUpperCase()}
              </span>
            )}
          </div>
          {setName && <p className="text-xs text-text-muted truncate">{setName}</p>}

          {/* Card ID: "OBF 125" format */}
          {(() => {
            const setCode = card.set?.id?.toUpperCase() || ''
            const localNum = card.localId || card.number || ''
            const cardIdLabel = `${setCode} ${localNum}`.trim()
            return cardIdLabel ? (
              <p className="text-[10px] font-mono text-brand-red/70 font-semibold">{cardIdLabel}</p>
            ) : null
          })()}

          <div className="flex items-center justify-between">
            {cardRarity && (
              <span className={clsx('text-xs truncate', rarityColor)}>{cardRarity}</span>
            )}
            {price && (
              <span className="text-xs font-bold text-green">{formatPrice(price)}</span>
            )}
          </div>
        </div>

        {showActions && (
          <div className="mt-3 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              className="flex-1 bg-brand-red/20 hover:bg-brand-red/40 text-brand-red text-xs py-1.5 rounded-lg font-medium transition-all flex items-center justify-center gap-1"
              onClick={(e) => {
                e.stopPropagation()
                addMutation.mutate({ card_id: card.id, quantity: 1, condition: 'NM', lang: card.lang || 'en' })
              }}>
              <Plus size={12} /> {t('common.add')}
            </button>
            <button
              className="bg-bg-surface hover:bg-bg-elevated text-text-secondary hover:text-pink-400 text-xs px-2 py-1.5 rounded-lg transition-all"
              onClick={(e) => { e.stopPropagation(); wishlistMutation.mutate({ card_id: card.id }) }}>
              <Heart size={12} />
            </button>
            {onAddToBinder && (
              <button
                className="bg-bg-surface hover:bg-bg-elevated text-text-secondary hover:text-blue text-xs px-2 py-1.5 rounded-lg transition-all"
                onClick={(e) => { e.stopPropagation(); onAddToBinder(card.id) }}>
                <BookOpen size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <CardModal
          card={card}
          onClose={() => setShowModal(false)}
          onEdit={card.is_custom ? () => { setShowModal(false); setShowEditModal(true) } : undefined}
        />
      )}
      {showEditModal && (
        <CustomCardModal
          editCard={card}
          onClose={() => setShowEditModal(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ['collection'] })
          }}
          sets={[]}
        />
      )}
    </>
  )
})

const CARD_VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']


export function CardModal({ card, onClose, onEdit, defaultLang = 'en' }) {
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState(() => {
    const hasNormal = card.variants_normal
    const hasReverse = card.variants_reverse
    const hasHolo = card.variants_holo
    const hasFirst = card.variants_first_edition

    const available = [hasNormal && 'Normal', hasReverse && 'Reverse Holo', hasHolo && 'Holo', hasFirst && 'First Edition'].filter(Boolean)

    if (available.length === 1) return available[0]
    if (hasHolo && !hasNormal && !hasReverse) return 'Holo'
    return ''
  })
  const [purchasePrice, setPurchasePrice] = useState('')
  const [modalPeriod, setModalPeriod] = useState('total')
  const [resolvedCardId, setResolvedCardId] = useState(card.id)
  const { t, formatPrice } = useSettings()
  const queryClient = useQueryClient()

  // Price history chart
  const cardIdForHistory = card?.card_id || (typeof card?.id === 'string' ? card.id : null)
  const { data: priceHistory = [] } = useQuery({
    queryKey: ['price-history', cardIdForHistory],
    queryFn: () => getPriceHistory(cardIdForHistory).then(r => r.data),
    enabled: !!cardIdForHistory,
    staleTime: 5 * 60 * 1000,
  })


  const cardImage = card.images?.large || resolveCardImageUrl(card, 'large') || (card.image ? `${card.image}/high.webp` : null) || card.images?.small || resolveCardImageUrl(card)
  const setName = card.set?.name || card.set_ref?.name

  const addMutation = useMutation({
    mutationFn: (data) => addToCollection(data),
    onSuccess: () => {
      toast.success(`${t('common.add')} ${quantity}x ${card.name}!`)
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      onClose()
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const wishlistMutation = useMutation({
    mutationFn: (data) => addToWishlist(data),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToWishlist')}`)
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
      onClose()
    },
    onError: () => toast.error(t('card.wishlistFailed')),
  })

  const ALL_PRICE_KEYS = ['trend', 'avg1', 'avg7', 'avg30', 'low']
  const ALL_HOLO_PRICE_KEYS = ['trend-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo', 'low-holo']

  const HOLO_PRICE_FIELD_MAP = {
    'trend-holo': 'price_trend_holo',
    'avg1-holo': 'price_avg1_holo',
    'avg7-holo': 'price_avg7_holo',
    'avg30-holo': 'price_avg30_holo',
    'low-holo': 'price_low_holo',
  }

  const displayedPrices = ALL_PRICE_KEYS
    .map(key => {
      const val = getPriceValue(card, key)
      return val != null ? { key, val } : null
    })
    .filter(Boolean)

  const displayedHoloPrices = ALL_HOLO_PRICE_KEYS
    .map(key => {
      const field = HOLO_PRICE_FIELD_MAP[key]
      const val = card[field]
      return val != null ? { key, val } : null
    })
    .filter(Boolean)

  const tcgPrices = [
    card.price_tcg_normal_market != null ? { key: 'tcg-normal', val: card.price_tcg_normal_market, label: 'Normal' } : null,
    card.price_tcg_reverse_market != null ? { key: 'tcg-reverse', val: card.price_tcg_reverse_market, label: 'Reverse' } : null,
    card.price_tcg_holo_market != null ? { key: 'tcg-holo', val: card.price_tcg_holo_market, label: 'Holo' } : null,
  ].filter(Boolean)

  const periodPriceKey = PERIOD_PRICE_FIELD[modalPeriod]?.replace('price_', '') || 'trend'
  const selectedPeriodPrice = getPriceValue(card, periodPriceKey)

  return (
    <div className="fixed inset-0 z-50 bg-black/60 md:flex md:items-center md:justify-center md:bg-black/80 md:backdrop-blur-sm"
      onClick={onClose}>
      <div className={[
        'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
        'bg-bg-surface border-t border-border more-sheet-enter',
        'md:static md:rounded-2xl md:border md:max-w-2xl md:w-full md:max-h-[85vh] md:animate-none',
      ].join(' ')} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 p-4 sm:p-6">
          <div className="flex-shrink-0">
            <div className="flex sm:block items-start gap-4">
              <div className="w-28 sm:w-48 flex-shrink-0">
                {cardImage ? (
                  <img src={cardImage} alt={card.name} className="w-full rounded-xl shadow-2xl" />
                ) : (
                  <div className="w-full aspect-[2.5/3.5] bg-bg-card rounded-xl flex items-center justify-center text-text-muted text-sm">
                    {t('common.noImage')}
                  </div>
                )}
              </div>

              <div className="sm:hidden flex-1 min-w-0 pt-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-text-primary break-words">{card.name}</h2>
                    {setName && <p className="text-xs text-text-secondary mt-0.5">
                      {setName}{card.number ? ` · #${card.number}` : ''}
                    </p>}
                    {card.rarity && (
                      <p className={`text-xs mt-0.5 ${(RARITY_COLORS[card.rarity] || 'text-text-secondary')}`}>
                        {card.rarity}
                      </p>
                    )}
                  </div>
                  <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0 p-1">
                    <X size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0 space-y-4">
            <div className="hidden sm:flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-xl font-bold text-text-primary break-words">{card.name}</h2>
                {setName && <p className="text-sm text-text-secondary">
                  {setName}{card.number ? ` · #${card.number}` : ''}
                </p>}
              </div>
              <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0">
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              {card.rarity && (
                <div className="hidden sm:block">
                  <span className="text-text-muted">{t('card.rarity')}</span>
                  <p className="text-text-primary font-medium">{card.rarity}</p>
                </div>
              )}
              {(card.supertype || card.types) && (
                <div>
                  <span className="text-text-muted text-xs">{t('card.type')}</span>
                  <p className="text-text-primary font-medium text-sm">
                    {card.supertype}{card.types ? ` (${card.types.join(', ')})` : ''}
                  </p>
                </div>
              )}
              {card.hp && (
                <div>
                  <span className="text-text-muted text-xs">{t('card.hp')}</span>
                  <p className="text-text-primary font-medium text-sm">{card.hp}</p>
                </div>
              )}
              {card.artist && (
                <div>
                  <span className="text-text-muted text-xs">{t('card.artist')}</span>
                  <p className="text-text-primary font-medium text-sm truncate">{card.artist}</p>
                </div>
              )}
            </div>

            {displayedPrices.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                    {t('prices.cardmarketTitle')}
                  </p>
                  <PeriodSelector value={modalPeriod} onChange={setModalPeriod} periods={CARD_PERIODS} size="sm" />
                </div>
                {selectedPeriodPrice != null && (
                  <p className="text-2xl font-bold text-green">{formatPrice(selectedPeriodPrice)}</p>
                )}
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs border-t border-border pt-2">
                  {displayedPrices.map(({ key, val }) => (
                    <div key={key}>
                      <span className="text-text-muted">{t(`prices.${key}`)}</span>
                      <p className={key === 'trend' ? 'text-green font-bold' : 'text-text-primary font-bold'}>
                        {formatPrice(val)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {displayedHoloPrices.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  Cardmarket Holo (€)
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs">
                  {displayedHoloPrices.map(({ key, val }) => (
                    <div key={key}>
                      <span className="text-text-muted block">{key}</span>
                      <span className="font-bold text-green">{formatPrice(val)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tcgPrices.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  TCGPlayer (USD)
                </p>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {tcgPrices.map(({ key, val, label }) => (
                    <div key={key}>
                      <span className="text-text-muted block">{label}</span>
                      <span className="font-bold text-blue-400">${val.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}


            {/* Price History Chart */}
            {priceHistory.length > 1 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  {t('prices.history')}
                </p>
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={priceHistory} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#606078' }}
                        tickFormatter={(d) => new Date(d).toLocaleDateString('de-DE', { day: '2d', month: '2d' })}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={30}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#606078' }}
                        tickFormatter={(v) => `${v.toFixed(0)}€`}
                        axisLine={false}
                        tickLine={false}
                        width={40}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(20,20,34,0.95)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '0.75rem',
                          fontSize: '0.75rem',
                        }}
                        labelFormatter={(d) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}
                        formatter={(val) => [`${val?.toFixed(2)}€`, t('prices.trend')]}
                      />
                      <Area
                        type="monotone"
                        dataKey="price_trend"
                        stroke="#22c55e"
                        fill="url(#priceGrad)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 3, fill: '#22c55e', stroke: 'none' }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                {(() => {
                  const first = priceHistory[0]?.price_trend
                  const last = priceHistory[priceHistory.length - 1]?.price_trend
                  if (first && last && first > 0) {
                    const change = ((last - first) / first) * 100
                    return (
                      <p className={`text-xs font-semibold ${change >= 0 ? 'text-green' : 'text-brand-red'}`}>
                        {change >= 0 ? '↑' : '↓'} {Math.abs(change).toFixed(1)}% {t('prices.sinceTracking')}
                      </p>
                    )
                  }
                  return null
                })()}
              </div>
            )}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                  <input type="number" min="1" value={quantity}
                    onChange={(e) => setQuantity(parseInt(e.target.value) || 1)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                  <select value={condition} onChange={(e) => setCondition(e.target.value)} className="select">
                    {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block font-medium">✨ {t('card.variant')}</label>
                <select value={variant} onChange={(e) => setVariant(e.target.value)} className="select">
                  <option value="">{t('variants.none')}</option>
                  {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                {(() => {
                  const available = [
                    card.variants_normal && 'Normal',
                    card.variants_reverse && 'Reverse Holo',
                    card.variants_holo && 'Holo',
                    card.variants_first_edition && 'First Edition',
                  ].filter(Boolean)
                  return available.length > 0 ? (
                    <p className="text-[10px] text-text-muted mt-1">
                      📋 {t('card.availableVariants')}: {available.join(', ')}
                    </p>
                  ) : null
                })()}
              </div>
              {card.rarity && (
                <div>
                  <label className="text-xs text-text-muted mb-1 block font-medium">💎 {t('card.rarity')}</label>
                  <p className="text-sm text-text-primary font-medium px-3 py-1.5 rounded-lg bg-bg-card border border-border">
                    {card.rarity}
                  </p>
                </div>
              )}
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <input type="number" step="0.01" min="0" placeholder={t('card.purchasePricePlaceholder')}
                  value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} className="input" />
              </div>

              <div className="flex gap-2 pb-safe">
                <button className="btn-primary flex-1" onClick={() => addMutation.mutate({
                  card_id: resolvedCardId, quantity, condition,
                  variant: variant || null,
                  purchase_price: purchasePrice ? parseFloat(purchasePrice) : undefined,
                  lang: card.lang || 'en',
                })} disabled={addMutation.isPending}>
                  <Plus size={16} /> {addMutation.isPending ? t('card.adding') : t('card.addToCollection')}
                </button>
                <button className="btn-ghost" onClick={() => wishlistMutation.mutate({ card_id: card.id })}
                  disabled={wishlistMutation.isPending}>
                  <Heart size={16} />
                </button>
                {card.is_custom && onEdit && (
                  <button
                    className="btn-ghost text-yellow border-yellow/30 hover:bg-yellow/10 flex items-center gap-1.5"
                    onClick={onEdit}
                  >
                    <Pencil size={14} /> {t('common.edit')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CardItem
