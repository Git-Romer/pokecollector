import { useState, useEffect, useId, memo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Plus, Heart, X, PenLine, Pencil, Trash2, ExternalLink } from 'lucide-react'
import { addToCollection, addToWishlist, cloneCustomCard, createCustomCard, updateCustomCard, updateCardCustomImage, deleteCustomCard, getSets, getPriceHistory, updateCollectionItem, removeFromCollection } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { cardImageUrl, resolveCardImageUrl } from '../utils/imageUrl'
import { CARD_VARIANTS, getAvailableVariants, getDefaultVariant } from '../utils/cardVariants'
import MoneyInput from './MoneyInput'
import { getEffectiveCardPrice } from '../utils/prices'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { cardmarketLinks } from '../utils/cardmarket'
import UnifiedCard, { UnifiedCardDialog } from './UnifiedCard'

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
  const { t, settings, exchangeRate, exchangeRateReady } = useSettings()
  const confirmDialog = useConfirmDialog()
  const [name, setName] = useState(editCard?.name || '')
  const [setChoice, setSetChoice] = useState('')
  const [customSetId, setCustomSetId] = useState('')
  const [number, setNumber] = useState(editCard?.number || '')
  const [rarity, setRarity] = useState(editCard?.rarity || '')
  const [selectedTypes, setSelectedTypes] = useState(editCard?.types || [])
  const [hp, setHp] = useState(editCard?.hp || '')
  const [artist, setArtist] = useState(editCard?.artist || '')
  const [imageUrl, setImageUrl] = useState(editCard?.images_small || editCard?.image_url || '')
  const [isSharedTemplate, setIsSharedTemplate] = useState(editCard?.is_shared_template || false)

  const [createdCard, setCreatedCard] = useState(null)
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState('Normal')
  const [purchasePrice, setPurchasePrice] = useState('')
  const queryClient = useQueryClient()

  const { data: fetchedSets = [] } = useQuery({
    queryKey: ['sets', settings.language || 'en'],
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
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
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
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
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
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
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
      is_shared_template: isSharedTemplate,
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
      variant,
      purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
      lang: createdCard.lang || 'en',
    })
  }

  const toggleType = (tp) => {
    setSelectedTypes(prev => prev.includes(tp) ? prev.filter(t => t !== tp) : [...prev, tp])
  }

  const handleDelete = async () => {
    if (!editCard) return
    const confirmed = await confirmDialog({
      title: t('common.delete'),
      message: t('common.confirm_delete'),
      confirmLabel: t('common.delete'),
      destructive: true,
    })
    if (!confirmed) return
    deleteMutation.mutate()
  }

  return createPortal(
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
                <input type="text" required placeholder={t('cardSearch.customNamePlaceholder')} value={name}
                  onChange={(e) => setName(e.target.value)} className="input" />
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-bg-card p-3">
                <input
                  type="checkbox"
                  checked={isSharedTemplate}
                  onChange={(event) => setIsSharedTemplate(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-brand-red"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-text-primary">{t('cardSearch.shareAsTemplate')}</span>
                  <span className="block text-xs text-text-muted">{t('cardSearch.shareAsTemplateHelp')}</span>
                </span>
              </label>
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
                  <input type="text" placeholder={t('cardSearch.cardNumberPlaceholder')} value={number}
                    onChange={(e) => setNumber(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.rarity')}</label>
                  <input type="text" placeholder={t('cardSearch.rarityPlaceholder')} value={rarity}
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
                  <input type="text" placeholder={t('cardSearch.hpPlaceholder')} value={hp}
                    onChange={(e) => setHp(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.artist')}</label>
                  <input type="text" placeholder={t('cardSearch.artistPlaceholder')} value={artist}
                    onChange={(e) => setArtist(e.target.value)} className="input" />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-1 block">{t('cardSearch.imageUrl')}</label>
                <input type="url" placeholder="https://..." value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)} className="input" />
                {imageUrl && /^https?:\/\//i.test(imageUrl) && (
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
                  {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <MoneyInput
                  placeholder={t('card.purchasePricePlaceholder')}
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                />
              </div>
              <div className="flex gap-3">
                <button onClick={handleAddToCollection} disabled={addMutation.isPending || !exchangeRateReady} className="btn-primary flex-1">
                  <Plus size={16} /> {addMutation.isPending ? t('card.adding') : t('card.addToCollection')}
                </button>
                <button onClick={onClose} className="btn-ghost">{t('common.close')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export const CardItem = memo(function CardItem({ card, showActions = true, onAddToBinder = null, compact = false, lang = null, dimWhenUnowned = false }) {
  const [showModal, setShowModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [clonedCard, setClonedCard] = useState(null)
  const [modalTab, setModalTab] = useState('overview')
  const { t, pricePrimary, pricePrimaryField, formatPrice } = useSettings()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const ownsCustomCard = Boolean(
    card.is_custom
    && (card.is_custom_owner || Number(card.custom_owner_id) === Number(user?.id))
  )
  const isForeignTemplate = Boolean(card.is_custom && card.is_shared_template && !ownsCustomCard)

  const cloneMutation = useMutation({
    mutationFn: () => cloneCustomCard(card.id),
    onSuccess: (clone) => {
      setClonedCard(clone)
      queryClient.invalidateQueries({ queryKey: ['custom-cards'] })
      invalidateCardState(queryClient)
      if (onAddToBinder) {
        onAddToBinder(clone.id)
      } else {
        setModalTab('add')
        setShowModal(true)
      }
      toast.success(t('cardSearch.templateCopied'))
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(typeof detail === 'string' ? detail : detail?.message)
    },
  })

  const cardImage = card.images?.small || resolveCardImageUrl(card) || (card.image ? `${card.image}/low.webp` : null)
  const selectedPrice = getEffectiveCardPrice(card, null, pricePrimaryField)
  const price = selectedPrice > 0
    ? selectedPrice
    : (getPriceValue(card, pricePrimary)
      ?? card.cardmarket?.prices?.trendPrice
      ?? card.price_market
      ?? card.price_trend)
  const openModal = (tab = 'overview') => {
    setModalTab(tab)
    setShowModal(true)
  }
  const languageLabel = lang ? tcgdexLanguageLabel(lang) : null
  const formattedPrice = price ? formatPrice(price) : null

  return (
    <>
      <UnifiedCard
        card={card}
        image={cardImage}
        price={formattedPrice}
        languageLabel={languageLabel}
        compact={compact}
        dimWhenUnowned={dimWhenUnowned}
        onClick={() => openModal(
          isForeignTemplate
            ? 'overview'
            : showActions && !onAddToBinder
              ? 'add'
              : 'overview'
        )}
        onAdd={showActions
          ? () => {
              if (isForeignTemplate) cloneMutation.mutate()
              else if (onAddToBinder) onAddToBinder(card.id)
              else openModal('add')
            }
          : undefined}
      />

      {showModal && (
        <CardModal
          card={clonedCard || card}
          onClose={() => setShowModal(false)}
          onEdit={ownsCustomCard ? () => { setShowModal(false); setShowEditModal(true) } : undefined}
          isForeignTemplate={!clonedCard && isForeignTemplate}
          onCopyTemplate={() => cloneMutation.mutate()}
          copyTemplatePending={cloneMutation.isPending}
          initialTab={modalTab}
        />
      )}
      {showEditModal && (
        <CustomCardModal
          editCard={card}
          onClose={() => setShowEditModal(false)}
          onCreated={() => {
            invalidateCardState(queryClient)
            invalidateTcgdexFilterLanguages(queryClient)
          }}
          sets={[]}
        />
      )}
    </>
  )
})

function OwnedVersionRow({ item, onQuantityChange, onRemove, isUpdating, isRemoving, t }) {
  const [quantity, setQuantity] = useState(item.quantity || 1)

  useEffect(() => {
    setQuantity(item.quantity || 1)
  }, [item.id, item.quantity])

  const commitQuantity = () => {
    const nextQuantity = Math.max(1, parseInt(quantity, 10) || 1)
    setQuantity(nextQuantity)
    if (nextQuantity !== item.quantity) onQuantityChange(item, nextQuantity)
  }

  return (
    <div className="flex items-center gap-2 rounded-xl bg-bg-card border border-border p-2">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary font-medium truncate">
          {[item.variant || 'Normal', item.condition].filter(Boolean).join(' · ')}
        </p>
      </div>
      <input
        type="number"
        min="1"
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
        onBlur={commitQuantity}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        disabled={isUpdating || isRemoving}
        className="input text-center px-2 py-1.5"
        style={{ width: '4.25rem', colorScheme: 'dark' }}
        aria-label={t('card.quantity')}
        title={t('card.quantity')}
      />
      <button
        type="button"
        onClick={() => onRemove(item)}
        disabled={isRemoving}
        className="btn-ghost text-brand-red border-brand-red/30 hover:bg-brand-red/10 px-2 py-1.5"
        title={t('collection.remove')}
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

export function CardModal({ card, onClose, onEdit, defaultLang = 'en', ownedItems = null, initialTab = 'overview', isForeignTemplate = false, onCopyTemplate, copyTemplatePending = false }) {
  if (!card || !card.id) return null

  const [activeTab, setActiveTab] = useState(initialTab)
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState(() => getDefaultVariant(card))
  const [collectionLang, setCollectionLang] = useState(card.lang || defaultLang || 'en')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [resolvedCardId, setResolvedCardId] = useState(card.id)
  const [customImageUrl, setCustomImageUrl] = useState(card.custom_image_url || '')
  const [savedCustomImageUrl, setSavedCustomImageUrl] = useState(card.custom_image_url || '')
  const [customImageVersion, setCustomImageVersion] = useState(0)
  const [localOwnedItems, setLocalOwnedItems] = useState(() => ownedItems || card.owned_items || [])
  const customImageInputId = useId()
  const { t, formatPrice, formatUsdPrice, pricePrimary, pricePrimaryField, exchangeRate, exchangeRateReady } = useSettings()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  useEffect(() => {
    setActiveTab(initialTab)
  }, [card.id, initialTab])

  useEffect(() => {
    setResolvedCardId(card.id)
  }, [card.id])

  // Price history chart
  const cardIdForHistory = card?.card_id || (typeof card?.id === 'string' ? card.id : null)
  const { data: priceHistory = [] } = useQuery({
    queryKey: ['price-history', cardIdForHistory],
    queryFn: () => getPriceHistory(cardIdForHistory).then(r => r.data),
    enabled: typeof cardIdForHistory === 'string' && cardIdForHistory.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  useEffect(() => {
    const nextUrl = card.custom_image_url || ''
    setCustomImageUrl(nextUrl)
    setSavedCustomImageUrl(nextUrl)
  }, [card.id, card.custom_image_url])

  useEffect(() => {
    setCollectionLang(card.lang || defaultLang || 'en')
  }, [card.id, card.lang, defaultLang])

  useEffect(() => {
    setLocalOwnedItems(ownedItems || card.owned_items || [])
  }, [card.id, card.owned_items, ownedItems])

  const safePriceHistory = Array.isArray(priceHistory) ? priceHistory : []
  const hasApiImage = Boolean(card?.images?.large || card?.images_large || card?.images?.small || card?.images_small || card?.image)
  const customImageCardId = card?.card_id || card?.id
  const canEditCustomImage = !card.is_custom && !hasApiImage && typeof customImageCardId === 'string'
  const customImageProxyUrl = canEditCustomImage && savedCustomImageUrl
    ? `${cardImageUrl(customImageCardId, 'large')}?v=${customImageVersion}`
    : null
  const manualImageProxyUrl = card.is_custom ? resolveCardImageUrl(card, 'large') : null
  const cardImage = manualImageProxyUrl
    || card?.images?.large
    || card?.images_large
    || (card?.image ? `${card.image}/high.webp` : null)
    || card?.images?.small
    || card?.images_small
    || customImageProxyUrl
    || resolveCardImageUrl(card, 'large')
    || resolveCardImageUrl(card)
  const dexIds = [...new Set(
    (Array.isArray(card.dex_ids) ? card.dex_ids : card.dex_id != null ? [card.dex_id] : [])
      .map(Number)
      .filter(dexId => Number.isInteger(dexId) && dexId > 0)
  )]
  const navigateFromModal = (target) => {
    onClose()
    navigate(target)
  }
  const modalOwnedItems = localOwnedItems
  const detailedOwnedQuantity = modalOwnedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
  const ownedQuantity = modalOwnedItems.length > 0 ? detailedOwnedQuantity : (card.owned_quantity ?? 0)
  const availableVariants = getAvailableVariants(card)
  const selectableVariants = availableVariants.length > 0 ? availableVariants : CARD_VARIANTS
  const availableVariantKey = availableVariants.join('|')
  const marketLinks = cardmarketLinks(card, variant)

  useEffect(() => {
    if (availableVariants.length > 0 && !availableVariants.includes(variant)) {
      setVariant(getDefaultVariant(card))
    }
  }, [card.id, availableVariantKey, variant])

  const addMutation = useMutation({
    mutationFn: (data) => addToCollection(data),
    onSuccess: () => {
      toast.success(`${t('common.add')} ${quantity}x ${card.name}!`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      onClose()
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const wishlistMutation = useMutation({
    mutationFn: (data) => addToWishlist(data),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToWishlist')}`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      onClose()
    },
    onError: () => toast.error(t('card.wishlistFailed')),
  })

  const quantityMutation = useMutation({
    mutationFn: ({ item, quantity: nextQuantity }) => updateCollectionItem(item.id, { quantity: nextQuantity }),
    onSuccess: (_response, { item, quantity: nextQuantity }) => {
      setLocalOwnedItems(current => current.map(row => (
        row.id === item.id ? { ...row, quantity: nextQuantity } : row
      )))
      toast.success(t('collection.updated'))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: () => toast.error(t('collection.updateFailed')),
  })

  const removeMutation = useMutation({
    mutationFn: (item) => removeFromCollection(item.id),
    onSuccess: (_response, item) => {
      const remaining = localOwnedItems.filter(row => row.id !== item.id)
      setLocalOwnedItems(remaining)
      if (remaining.length === 0) setActiveTab('add')
      toast.success(t('collection.removed'))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: () => toast.error(t('collection.removeFailed')),
  })

  const customImageMutation = useMutation({
    mutationFn: (url) => updateCardCustomImage(card.card_id || card.id, { custom_image_url: url || null }),
    onSuccess: (updatedCard) => {
      const nextUrl = updatedCard?.custom_image_url || ''
      setCustomImageUrl(nextUrl)
      setSavedCustomImageUrl(nextUrl)
      setCustomImageVersion((version) => version + 1)
      toast.success(t('card.customImageSaved'))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const ALL_PRICE_KEYS = ['trend', 'avg', 'avg1', 'avg7', 'avg30', 'low']
  const ALL_HOLO_PRICE_KEYS = ['trend-holo', 'avg-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo', 'low-holo']

  const HOLO_PRICE_FIELD_MAP = {
    'trend-holo': 'price_trend_holo',
    'avg-holo': 'price_market_holo',
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
      const displayKey = key.replace('-holo', '')
      return val != null ? { key, displayKey, val } : null
    })
    .filter(Boolean)

  const isReverseHolo = variant === 'Reverse Holo'
  const selectedPriceBreakdown = isReverseHolo && displayedHoloPrices.length > 0
    ? displayedHoloPrices
    : displayedPrices.map(({ key, val }) => ({ key, displayKey: key, val }))

  const tcgPrices = [
    card.price_tcg_normal_market != null ? { key: 'tcg-normal', val: card.price_tcg_normal_market, label: 'Normal' } : null,
    card.price_tcg_reverse_market != null ? { key: 'tcg-reverse', val: card.price_tcg_reverse_market, label: 'Reverse' } : null,
    card.price_tcg_holo_market != null ? { key: 'tcg-holo', val: card.price_tcg_holo_market, label: 'Holo' } : null,
  ].filter(Boolean)

  const effectivePrimaryPrice = getEffectiveCardPrice(card, variant, pricePrimaryField)
  const selectedPrimaryPrice = effectivePrimaryPrice > 0 ? effectivePrimaryPrice : getPriceValue(card, pricePrimary)
  const historyPriceField = ['price_market', 'price_trend', 'price_low'].includes(pricePrimaryField) ? pricePrimaryField : 'price_market'
  const historyDataKey = historyPriceField
  const historyPriceLabel = pricePrimaryField === historyPriceField ? t(`prices.${pricePrimary}`) : t('prices.avg')
  const modalTabs = [
    { id: 'overview', label: t('cardTabs.overview') },
    { id: 'prices', label: t('cardTabs.prices') },
    ...(ownedQuantity > 0 ? [{ id: 'owned', label: t('cardTabs.owned') }] : []),
    ...(!isForeignTemplate ? [
      { id: 'add', label: t('cardTabs.add') },
      { id: 'wishlist', label: t('cardTabs.wishlist') },
    ] : []),
  ]

  return (
    <UnifiedCardDialog
      card={card}
      image={cardImage}
      variantEffectSource={variant}
      price={selectedPrimaryPrice > 0 ? formatPrice(selectedPrimaryPrice) : null}
      tabs={modalTabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
    >
      <div className="min-w-0 space-y-4">

            {isForeignTemplate && (
              <div className="rounded-xl border border-yellow/30 bg-yellow/10 p-4">
                <p className="text-sm font-semibold text-text-primary">{t('cardSearch.sharedTemplate')}</p>
                <p className="mt-1 text-xs text-text-secondary">{t('cardSearch.sharedTemplateHelp')}</p>
                <button
                  type="button"
                  onClick={onCopyTemplate}
                  disabled={copyTemplatePending}
                  className="btn-primary mt-3"
                >
                  <Plus size={16} /> {copyTemplatePending ? t('common.saving') : t('cardSearch.copyToCollection')}
                </button>
              </div>
            )}

            {activeTab === 'overview' && <div className="grid grid-cols-2 gap-3 text-sm">
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
                  <button
                    type="button"
                    onClick={() => navigateFromModal(`/search?${new URLSearchParams({ artist: card.artist }).toString()}`)}
                    className="block max-w-full truncate text-left text-text-primary font-medium text-sm hover:text-brand-red hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/50 rounded"
                  >
                    {card.artist}
                  </button>
                </div>
              )}
              {dexIds.length > 0 && (
                <div>
                  <span className="text-text-muted text-xs">{t('nav.pokedex')}</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {dexIds.map(dexId => (
                      <button
                        key={dexId}
                        type="button"
                        onClick={() => navigateFromModal(`/pokedex/${dexId}`)}
                        className="rounded-full border border-border bg-bg-card px-2 py-1 text-xs font-semibold text-text-primary hover:border-brand-red/50 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/50"
                      >
                        #{String(dexId).padStart(3, '0')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>}

            {activeTab === 'prices' && selectedPriceBreakdown.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                    {t('prices.cardmarketTitle')} · {variant}
                  </p>
                </div>
                {selectedPrimaryPrice != null && (
                  <p className="text-2xl font-bold text-green">{formatPrice(selectedPrimaryPrice)}</p>
                )}
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs border-t border-border pt-2">
                  {selectedPriceBreakdown.map(({ key, displayKey, val }) => (
                    <div key={key}>
                      <span className="text-text-muted">{t(`prices.${displayKey}`)}</span>
                      <p className={displayKey === 'trend' ? 'text-green font-bold' : 'text-text-primary font-bold'}>
                        {formatPrice(val)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'prices' && !card.is_custom && marketLinks.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2 border border-border">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  {t('cardmarket.buy')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {marketLinks.map((link) => (
                    <a
                      key={link.productId || link.url}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost text-xs inline-flex items-center gap-1.5"
                    >
                      <ExternalLink size={14} />
                      {link.fallback
                        ? t('cardmarket.search')
                        : link.label || t('cardmarket.openProduct')}
                    </a>
                  ))}
                </div>
                {marketLinks.some((link) => link.fallback) && (
                  <p className="text-[10px] text-text-muted">{t('cardmarket.searchFallback')}</p>
                )}
              </div>
            )}

            {activeTab === 'prices' && tcgPrices.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  TCGPlayer
                </p>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {tcgPrices.map(({ key, val, label }) => (
                    <div key={key}>
                      <span className="text-text-muted block">{label}</span>
                      <span className="font-bold text-blue-400">{formatUsdPrice(val)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'overview' && canEditCustomImage && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2 border border-border">
                <div>
                  <label htmlFor={customImageInputId} className="text-xs text-text-muted font-medium uppercase tracking-wide block">
                    {t('card.customImageUrl')}
                  </label>
                  <p className="text-xs text-text-secondary mt-1">
                    {t('card.customImageUrlDesc')}
                  </p>
                </div>
                <input
                  id={customImageInputId}
                  type="url"
                  placeholder="https://..."
                  value={customImageUrl}
                  onChange={(e) => setCustomImageUrl(e.target.value)}
                  className="input w-full"
                />
                {customImageProxyUrl && (
                  <div className="w-20 h-28 rounded overflow-hidden border border-border">
                    <img src={customImageProxyUrl} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => customImageMutation.mutate(customImageUrl.trim())}
                    disabled={customImageMutation.isPending || customImageUrl.trim() === savedCustomImageUrl}
                    className="btn-primary text-sm"
                  >
                    {customImageMutation.isPending ? t('common.saving') : t('card.saveCustomImage')}
                  </button>
                  {savedCustomImageUrl && (
                    <button
                      type="button"
                      onClick={() => customImageMutation.mutate('')}
                      disabled={customImageMutation.isPending}
                      className="btn-ghost text-sm"
                    >
                      {t('card.clearCustomImage')}
                    </button>
                  )}
                </div>
              </div>
            )}


            {/* Price History Chart */}
            {activeTab === 'prices' && safePriceHistory && safePriceHistory.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  {t('prices.history')}
                </p>
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={safePriceHistory} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#606078' }}
                        tickFormatter={(d) => { try { return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) } catch { return '' } }}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={30}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#606078' }}
                        tickFormatter={(v) => { try { return formatPrice(Number(v)) } catch { return '' } }}
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
                        formatter={(val) => { try { return [formatPrice(Number(val)), historyPriceLabel] } catch { return ['', ''] } }}
                      />
                      <Area
                        type="monotone"
                        dataKey={historyDataKey}
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
                  const first = safePriceHistory[0]?.[historyDataKey]
                  const last = safePriceHistory[safePriceHistory.length - 1]?.[historyDataKey]
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
              {activeTab === 'owned' && ownedQuantity > 0 && (
                <div className="rounded-xl border border-green/30 bg-green/10 p-3">
                  <p className="text-sm font-semibold text-green">✓ {t('cardSearch.alreadyOwned')} · {ownedQuantity}x</p>
                  {modalOwnedItems.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {modalOwnedItems.map(item => (
                        <OwnedVersionRow
                          key={item.id}
                          item={item}
                          onQuantityChange={(row, nextQuantity) => quantityMutation.mutate({ item: row, quantity: nextQuantity })}
                          onRemove={(row) => removeMutation.mutate(row)}
                          isUpdating={quantityMutation.isPending}
                          isRemoving={removeMutation.isPending}
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {activeTab === 'add' && <>
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
                  {selectableVariants.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                {availableVariants.length > 0 && (
                  <p className="text-[10px] text-text-muted mt-1">
                    📋 {t('card.availableVariants')}: {availableVariants.join(', ')}
                  </p>
                )}
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
                <label className="text-xs text-text-muted mb-1.5 block">🌐 {t('lang.selectLabel')}</label>
                <TcgdexLanguageSelect value={collectionLang} onChange={setCollectionLang} className="select w-full" />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <MoneyInput
                  placeholder={t('card.purchasePricePlaceholder')}
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                />
              </div>

              <div className="flex gap-2">
                <button className="btn-primary flex-1" onClick={() => addMutation.mutate({
                  card_id: resolvedCardId, quantity, condition,
                  variant,
                  purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
                  lang: collectionLang,
                })} disabled={addMutation.isPending || !exchangeRateReady}>
                  <Plus size={16} /> {addMutation.isPending ? t('card.adding') : t('card.addToCollection')}
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
              </>}
              {activeTab === 'wishlist' && (
                <div className="space-y-3 rounded-xl border border-border bg-bg-card p-4">
                  <div>
                    <label className="mb-1 block text-xs text-text-muted">{t('card.quantity')}</label>
                    <input
                      type="number"
                      min="1"
                      max="99"
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)))}
                      className="input"
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-primary w-full"
                    onClick={() => wishlistMutation.mutate({ card_id: card.id, quantity: Math.max(1, Math.min(99, quantity)) })}
                    disabled={wishlistMutation.isPending}
                  >
                    <Heart size={16} />
                    {wishlistMutation.isPending ? t('common.saving') : t('binderTypes.addToWishlist')}
                  </button>
                </div>
              )}
            </div>
      </div>
    </UnifiedCardDialog>
  )
}

export default CardItem
