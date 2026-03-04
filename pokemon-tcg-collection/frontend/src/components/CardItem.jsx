import { useState } from 'react'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { Plus, Check, Heart, BookOpen, X, PenLine, Pencil, TrendingUp } from 'lucide-react'
import { addToCollection, addToWishlist, createCustomCard, updateCustomCard, getEbayGradedPrice, getSetting } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import PeriodSelector, { CARD_PERIODS, PERIOD_PRICE_FIELD } from './PeriodSelector'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { useTilt } from '../hooks/useTilt'

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

export function CustomCardModal({ onClose, onCreated, sets = [], autoAddCollection = false, editCard = null }) {
  const { t } = useSettings()
  const [name, setName] = useState(editCard?.name || '')
  const [setChoice, setSetChoice] = useState(editCard?.set_id || '')
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
      queryClient.invalidateQueries({ queryKey: ['card-search'] })
      onCreated && onCreated(res)
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
    const payload = {
      name: name.trim(),
      set_id: effectiveSetId || undefined,
      number: number.trim() || undefined,
      rarity: rarity || undefined,
      types: selectedTypes.length > 0 ? selectedTypes : undefined,
      hp: hp.trim() || undefined,
      artist: artist.trim() || undefined,
      image_url: imageUrl.trim() || undefined,
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
    })
  }

  const toggleType = (tp) => {
    setSelectedTypes(prev => prev.includes(tp) ? prev.filter(t => t !== tp) : [...prev, tp])
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
                {createdCard.images_small ? (
                  <img src={createdCard.images_small} alt={createdCard.name} className="w-16 h-20 object-cover rounded" />
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

export function CardItem({ card, showActions = true, onAddToBinder = null, compact = false, lang = null }) {
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

  const cardImage = card.images?.small || card.images_small || (card.image ? `${card.image}/low.webp` : null)
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
      <div ref={tiltRef} className="card cursor-pointer group p-2 hover:shadow-glow" onClick={() => setShowModal(true)} onMouseMove={tiltMove} onMouseLeave={tiltLeave}>
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
      <div ref={tiltRef} className="card cursor-pointer group hover:shadow-glow" onClick={() => setShowModal(true)} onMouseMove={tiltMove} onMouseLeave={tiltLeave}>
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
                addMutation.mutate({ card_id: card.id, quantity: 1, condition: 'NM' })
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
}

const CARD_VARIANTS = [
  'Normal', 'Holo', 'Reverse Holo', 'Full Art', 'Alt Art', 'Gold', 'Rainbow',
  'Illustration Rare', 'Special Illustration Rare', 'Crown Rare', 'Promo',
  'Art Rare', 'Ultra Rare', 'Secret Rare', 'Shiny',
]

const GRADE_OPTIONS = ['raw', 'PSA 9', 'PSA 10', 'BGS 9', 'BGS 9.5', 'CGC 9', 'CGC 10']

export function CardModal({ card, onClose, onEdit, defaultLang = 'en' }) {
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState('')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [modalPeriod, setModalPeriod] = useState('total')
  const [cardLang, setCardLang] = useState(defaultLang)
  const [grade, setGrade] = useState('raw')
  const [ebayPrice, setEbayPrice] = useState(null)
  const [ebayLoading, setEbayLoading] = useState(false)
  const { t, formatPrice } = useSettings()
  const queryClient = useQueryClient()

  // Check if eBay API is configured
  const { data: ebayKeyData } = useQuery({
    queryKey: ['setting', 'ebay_app_id'],
    queryFn: () => getSetting('ebay_app_id').catch(() => ({ value: '' })),
  })
  const ebayConfigured = !!(ebayKeyData?.value && ebayKeyData.value.trim())

  const fetchEbayPrice = async () => {
    if (!card.name || grade === 'raw') return
    setEbayLoading(true)
    setEbayPrice(null)
    try {
      const result = await getEbayGradedPrice(card.name, grade, cardLang)
      setEbayPrice(result)
    } catch {
      setEbayPrice({ error: 'fetch_failed' })
    } finally {
      setEbayLoading(false)
    }
  }

  const cardImage = card.images?.large || card.images_large || (card.image ? `${card.image}/high.webp` : null) || card.images?.small || card.images_small
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
  const displayedPrices = ALL_PRICE_KEYS
    .map(key => {
      const val = getPriceValue(card, key)
      return val != null ? { key, val } : null
    })
    .filter(Boolean)

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

            <div className="space-y-3">
              {/* Language selector — fixed per card item */}
              <div>
                <label className="text-xs text-text-muted mb-1.5 block font-medium">
                  🌐 {t('lang.selectLabel')}
                </label>
                <div className="flex gap-2">
                  {['de', 'en'].map(l => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setCardLang(l)}
                      className={clsx(
                        'flex-1 py-1.5 rounded-lg text-sm font-bold transition-all border',
                        cardLang === l
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

              {/* Grade selector */}
              <div>
                <label className="text-xs text-text-muted mb-1.5 block font-medium">
                  🏅 {t('card.grade')}
                </label>
                <select
                  value={grade}
                  onChange={(e) => { setGrade(e.target.value); setEbayPrice(null) }}
                  className="select"
                >
                  {GRADE_OPTIONS.map(g => (
                    <option key={g} value={g}>
                      {g === 'raw' ? t('card.gradeRaw') : g}
                    </option>
                  ))}
                </select>
              </div>

              {/* eBay price lookup */}
              {grade !== 'raw' && (
                <div className="rounded-xl p-3 space-y-2"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-text-muted uppercase tracking-wide">
                      eBay {t('ebay.gradedPrice')}
                    </p>
                    {ebayConfigured ? (
                      <button
                        onClick={fetchEbayPrice}
                        disabled={ebayLoading}
                        className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg transition-opacity disabled:opacity-50"
                        style={{ background: 'rgba(227,0,11,0.15)', color: '#e3000b', border: '1px solid rgba(227,0,11,0.3)' }}
                      >
                        <TrendingUp size={11} className={ebayLoading ? 'animate-pulse' : ''} />
                        {ebayLoading ? t('ebay.loading') : t('ebay.fetchPrice')}
                      </button>
                    ) : (
                      <span className="text-xs text-text-muted">⚠️ {t('ebay.notConfigured')}</span>
                    )}
                  </div>
                  {ebayPrice && !ebayPrice.error && ebayPrice.average_price != null && (
                    <div className="grid grid-cols-3 gap-2 text-xs pt-1 border-t border-border">
                      <div>
                        <span className="text-text-muted">{t('ebay.avgPrice')}</span>
                        <p className="font-bold text-green">${ebayPrice.average_price}</p>
                      </div>
                      <div>
                        <span className="text-text-muted">{t('ebay.minPrice')}</span>
                        <p className="font-bold text-text-primary">${ebayPrice.min_price}</p>
                      </div>
                      <div>
                        <span className="text-text-muted">{t('ebay.maxPrice')}</span>
                        <p className="font-bold text-text-primary">${ebayPrice.max_price}</p>
                      </div>
                      <div className="col-span-3 text-text-muted">{ebayPrice.sales_count} {t('ebay.sales')}</div>
                    </div>
                  )}
                  {ebayPrice && ebayPrice.average_price === null && !ebayPrice.error && (
                    <p className="text-xs text-text-muted">{t('ebay.noResults')}</p>
                  )}
                  {ebayPrice?.error && ebayPrice.error !== 'not_configured' && (
                    <p className="text-xs text-brand-red">{t('ebay.fetchFailed')}</p>
                  )}
                </div>
              )}

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
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <input type="number" step="0.01" min="0" placeholder={t('card.purchasePricePlaceholder')}
                  value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} className="input" />
              </div>

              <div className="flex gap-2 pb-safe">
                <button className="btn-primary flex-1" onClick={() => addMutation.mutate({
                  card_id: card.id, quantity, condition,
                  variant: variant || null,
                  purchase_price: purchasePrice ? parseFloat(purchasePrice) : undefined,
                  lang: cardLang,
                  grade: grade || 'raw',
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
