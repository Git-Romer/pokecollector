import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Plus } from 'lucide-react'
import { addToCollection, uploadCollectionItemPhoto } from '../api/client'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { CARD_VARIANTS, getDefaultVariant } from '../utils/cardVariants'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import MoneyInput from './MoneyInput'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { CardDisplay } from './card-system'
import { hasCatalogueImage } from '../utils/imageUrl'
import { useDialogBehavior } from './ui/dialogBehavior'
import PrintingDetailSelector from './PrintingDetailSelector'

export async function attachScanFallbackPhoto({ created, getPhoto, uploadPhoto = uploadCollectionItemPhoto }) {
  const createdCard = created?.card
  const hasReferenceArtwork = hasCatalogueImage(createdCard) || Boolean(createdCard?.custom_image_url)
  if (!getPhoto || !createdCard || created?.has_scan_photo || hasReferenceArtwork) return false
  try {
    const photo = await getPhoto()
    if (!photo) return false
    await uploadPhoto(created.id, photo)
    return true
  } catch {
    // Photo retention is best-effort and must never undo the collection add.
    return false
  }
}

// ─── Add-to-Collection Modal für Scan-Ergebnis ──────────────────────────────
// `getPhoto`, when given, resolves to the Blob/File the user actually scanned.
// Callers decide how to source it: CardScanner has the raw File in hand,
// ScanQueue fetches it from the job's stored bytes. Called only after the
// collection item exists, and only matters for cards TCGdex has no scan of —
// and only when the matched card has no catalogue artwork and no saved fallback.
// A failed photo attach must never block adding the card itself.
export function ScanAddModal({
  match,
  defaultLang,
  getPhoto,
  onClose,
  onAdded,
  addCard,
  preservePhotoBeforeAdd = false,
}) {
  const { t, exchangeRate, exchangeRateReady } = useSettings()
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState(() => getDefaultVariant(match))
  const [printingDetails, setPrintingDetails] = useState([])
  const [lang, setLang] = useState(match.lang || defaultLang || 'en')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [adding, setAdding] = useState(false)
  const queryClient = useQueryClient()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(true, onClose)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  const handleAdd = async () => {
    if (!exchangeRateReady) return
    setAdding(true)
    try {
      const payload = {
        card_id: match.id,
        quantity,
        condition,
        variant,
        printing_details: printingDetails,
        lang,
        purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
      }
      // Resolving a queued scan deletes its private source photo. Retain the
      // Blob before an atomic add+resolve so missing catalogue artwork can
      // still receive the same best-effort fallback photo as direct scans.
      const retainedPhoto = preservePhotoBeforeAdd && getPhoto
        ? await getPhoto().catch(() => null)
        : null
      const created = addCard
        ? await addCard(payload)
        : (await addToCollection(payload)).data
      // Never overwrite a photo the item already has — grouping into an
      // existing row (same card/variant/condition/lang) is common, and a
      // second scan of the same card is not necessarily a better photo.
      await attachScanFallbackPhoto({
        created,
        match,
        getPhoto: retainedPhoto ? () => Promise.resolve(retainedPhoto) : getPhoto,
      })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(`${match.name} ${t('scanner.addedToCollection')}!`)
      onAdded && onAdded(created)
      onClose()
    } catch (err) {
      const msg = err?.response?.data?.detail || t('card.addFailed')
      toast.error(msg)
    } finally {
      setAdding(false)
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('scanner.addToCollection')}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-[300] flex items-end justify-center bg-black/80 p-2 backdrop-blur-xs sm:items-center sm:p-3"
      onClick={onClose}
    >
      <div
        className="relative max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-bg-surface shadow-2xl sm:max-h-[calc(100dvh-1.5rem)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20 sm:hidden" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-50 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/70 text-white shadow-lg hover:bg-black focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-red"
          aria-label={t('common.close')}
        >
          <X size={18} />
        </button>
        <div className="p-5">
          {/* Card Info */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-16 flex-shrink-0">
              <CardDisplay variant="artwork" card={match} image={match.image} alt={match.name} showStateIndicators={false} loading="eager" />
            </div>
            <div className="flex-1 min-w-0 pr-9">
              <p className="font-bold text-white text-base truncate">{match.name}</p>
              <p className="text-xs font-mono text-brand-red/80 font-semibold">{`${(match.set_abbreviation || '').toUpperCase()} ${match.number || ''}`.trim()}</p>
              {match.rarity && <p className="text-[11px] text-text-muted">{match.rarity}</p>}
            </div>
          </div>

          <div className="space-y-3">
            {/* Language */}
            <div>
              <label className="text-xs text-text-muted mb-1.5 block font-medium">🌐 {t('lang.filter')}</label>
              <TcgdexLanguageSelect value={lang} onChange={setLang} className="select w-full" />
            </div>

            {/* Quantity + Condition */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('common.quantity')}</label>
                <input
                  type="number" min="1" value={quantity}
                  onChange={e => setQuantity(parseInt(e.target.value) || 1)}
                  className="input"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                <select value={condition} onChange={e => setCondition(e.target.value)} className="select">
                  {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {/* Variant */}
            <div>
              <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
              <select value={variant} onChange={e => setVariant(e.target.value)} className="select">
                {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('printingDetails.label')}</label>
              <PrintingDetailSelector value={printingDetails} onChange={setPrintingDetails} />
            </div>


            {/* Purchase price */}
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('scanner.purchasePriceLabel')}</label>
              <MoneyInput
                placeholder={t('analytics.amountPlaceholder')}
                value={purchasePrice}
                onChange={e => setPurchasePrice(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 mt-5">
            <button
              onClick={handleAdd}
              disabled={adding || !exchangeRateReady}
              className="flex-1 py-3 rounded-xl font-black text-white flex items-center justify-center gap-2 transition-all"
              style={{ background: adding ? '#555' : '#e3000b', boxShadow: adding ? 'none' : '0 0 16px rgba(227,0,11,0.3)' }}
            >
              {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {adding ? t('scanner.adding') : t('scanner.addToCollection')}
            </button>
            <button onClick={onClose} className="btn-ghost px-3">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

