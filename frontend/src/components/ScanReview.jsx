import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, Loader2, Plus, Maximize2 } from 'lucide-react'
import { addToCollection, fetchScanJobItemImage } from '../api/client'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { CARD_VARIANTS, getDefaultVariant } from '../utils/cardVariants'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import MoneyInput from './MoneyInput'
import { parseMoneyInputValue } from '../utils/moneyInput'

// Shared between the capture modal (CardScanner) and the queue page (ScanQueue):
// both present the same "which candidate is this card, add it" review step.

// ─── Add-to-Collection Modal für Scan-Ergebnis ──────────────────────────────
export function ScanAddModal({ match, defaultLang, onClose, onAdded }) {
  const { t, exchangeRate, exchangeRateReady } = useSettings()
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState(() => getDefaultVariant(match))
  const [lang, setLang] = useState(match.lang || defaultLang || 'en')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [adding, setAdding] = useState(false)
  const queryClient = useQueryClient()

  const handleAdd = async () => {
    if (!exchangeRateReady) return
    setAdding(true)
    try {
      await addToCollection({
        card_id: match.id,
        quantity,
        condition,
        variant,
        lang,
        purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
      })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(`${match.name} ${t('scanner.addedToCollection')}!`)
      onAdded && onAdded()
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
      className="fixed inset-0 z-[300] bg-black/80 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl md:rounded-2xl bg-bg-surface border-t md:border border-border overflow-y-auto max-h-[85dvh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="p-5">
          {/* Card Info */}
          <div className="flex items-center gap-3 mb-4">
            {match.image && (
              <img src={match.image} alt={match.name}
                className="w-16 h-22 object-cover rounded-xl border border-white/10 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="font-bold text-white text-base truncate">{match.name}</p>
              <p className="text-xs font-mono text-brand-red/80 font-semibold">{`${(match.set_abbreviation || '').toUpperCase()} ${match.number || ''}`.trim()}</p>
              {match.rarity && <p className="text-[11px] text-text-muted">{match.rarity}</p>}
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary p-1 flex-shrink-0">
              <X size={18} />
            </button>
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

// ─── Match grid — the "which of these DB candidates is it" picker ──────────
// Shared by the single-photo result view and each panel of a batch result,
// so the card-tile rendering (image, language badge, hover-to-add) only
// exists once.
// Full-screen look at a candidate, next to the user's own photo where we have
// it. Comparing the two at real size is the decision the reviewer is actually
// making, so the modal shows both rather than the candidate alone.
export function CardZoomModal({ card, photoUrl, onClose, t }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!card && !photoUrl) return null
  // Prefer the explicit high-res URL, but derive it for matches stored before
  // that field existed — otherwise zooming an old job shows a 245px thumbnail,
  // which is exactly what this modal is meant to avoid. Thumbnail as a last
  // resort: a small image beats a broken one.
  const full = card?.image_hd || card?.image?.replace('/low.webp', '/high.webp') || card?.image

  return createPortal(
    <div className="fixed inset-0 z-[400] bg-black/90 flex flex-col p-4" onClick={onClose}>
      <div className="flex justify-end flex-shrink-0">
        <button onClick={onClose} aria-label={t('common.close')}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors">
          <X size={18} className="text-white" />
        </button>
      </div>
      <div
        className="flex-1 min-h-0 flex flex-col md:flex-row items-center justify-center gap-4 md:gap-8 py-3"
        onClick={e => e.stopPropagation()}
      >
        {photoUrl && (
          <figure className="flex flex-col items-center min-h-0 max-h-full">
            <img src={photoUrl} alt={t('scanner.yourPhoto')}
              className="max-h-[70vh] md:max-h-[80vh] max-w-full object-contain rounded-xl" />
            <figcaption className="text-[11px] text-text-muted mt-2">{t('scanner.yourPhoto')}</figcaption>
          </figure>
        )}
        {full && (
          <figure className="flex flex-col items-center min-h-0 max-h-full">
            <img src={full} alt={card?.name}
              className="max-h-[70vh] md:max-h-[80vh] max-w-full object-contain rounded-xl" />
            <figcaption className="text-[11px] text-text-muted mt-2">
              {card?.name}
              {card?.set_abbreviation && (
                <span className="font-mono text-brand-red/80"> {card.set_abbreviation.toUpperCase()} {card.number}</span>
              )}
            </figcaption>
          </figure>
        )}
      </div>
    </div>,
    document.body
  )
}

export function MatchesGrid({ matches, onSelect, onZoom, t }) {
  if (!matches?.length) {
    return (
      <div className="text-center py-6 space-y-2">
        <p className="text-text-muted text-sm">{t('scanner.noMatches')}</p>
        <p className="text-xs text-text-muted">{t('scanner.noMatchTip')}</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
      {matches.map(match => {
        const matchLang = match.lang || match._lang || 'en'
        const setCode = (match.set_abbreviation || match.set?.id || (match.id || '').split('-')[0]).toUpperCase()
        const localNum = match.localId || match.number || ''
        const cardIdLabel = `${setCode} ${localNum}`.trim()
        return (
          <div key={`${match.id}-${matchLang}`}
            className="flex flex-col cursor-pointer group hover:shadow-glow transition-all duration-200 hover:rotate-1"
            onClick={() => onSelect(match)}
          >
            <div className="relative w-full aspect-[2.5/3.5] overflow-hidden rounded-xl ring-1 ring-white/5 group-hover:ring-2 group-hover:ring-brand-red/30 transition-all duration-200">
              {match.image
                ? <img src={match.image} alt={match.name}
                    className="w-full h-full object-cover shadow-lg group-hover:scale-[1.02] transition-transform duration-300" />
                : <div className="w-full h-full bg-bg-surface rounded-xl flex items-center justify-center">
                    <span className="text-[9px] text-text-muted text-center p-1">{match.name}</span>
                  </div>
              }
              <span className={`absolute top-1 right-1 text-[8px] font-black px-1 py-0.5 rounded leading-none ${
                matchLang === 'de'
                  ? 'bg-yellow-500/80 text-yellow-900 border border-yellow-500/50'
                  : 'bg-blue-500/80 text-white border border-blue-500/50'
              }`}>
                {matchLang === 'de' ? '🇩🇪' : '🇬🇧'}
              </span>
              {match.printed_total_mismatch && (
                <span className="absolute top-1 left-1 text-[8px] font-black px-1 py-0.5 rounded leading-none bg-amber-500/90 text-black border border-amber-400"
                  title={t('scanner.printedTotalMismatch')}>
                  ⚠
                </span>
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 rounded-xl">
                <div className="w-7 h-7 rounded-full flex items-center justify-center"
                  style={{ background: '#e3000b', boxShadow: '0 0 12px rgba(227,0,11,0.5)' }}>
                  <Plus size={14} className="text-white" />
                </div>
                {onZoom && match.image && (
                  // stopPropagation: the tile itself opens add-to-collection.
                  <button
                    onClick={e => { e.stopPropagation(); onZoom(match) }}
                    title={t('scanner.expandCard')}
                    aria-label={t('scanner.expandCard')}
                    className="w-7 h-7 rounded-full flex items-center justify-center bg-black/70 hover:bg-black/90 transition-colors"
                  >
                    <Maximize2 size={13} className="text-white" />
                  </button>
                )}
              </div>
            </div>

            <div className="pt-1 flex flex-col gap-0.5">
              <p className="font-bold text-white text-[10px] leading-tight line-clamp-2">{match.name}</p>
              {cardIdLabel && (
                <p className="text-[9px] font-mono text-brand-red/80 font-semibold">{cardIdLabel}</p>
              )}
              {match.rarity && (
                <p className="text-[9px] text-text-muted truncate">{match.rarity}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// The stored photo for a queued item, as an object URL. Fetched as a blob
// because the endpoint is authenticated (an <img src> cannot send the bearer
// token), which also means it survives a reload where a local blob: URL would not.
export function useScanItemPhoto(jobId, item) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    if (!item.has_image) return undefined
    let revoked = false
    let objectUrl = null
    fetchScanJobItemImage(jobId, item.id)
      .then(next => {
        if (revoked) {
          URL.revokeObjectURL(next)
          return
        }
        objectUrl = next
        setUrl(next)
      })
      .catch(() => {})
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, item.id, item.has_image])

  return url
}

// `self-start` matters: the panel is a flex row, so without it the image is
// stretched to the full panel height (as tall as the match grid) and
// aspect-ratio is ignored. `object-contain` then keeps the whole card visible
// instead of cropping it to a narrow vertical slice.
export function ScanItemThumb({ url, onZoom, t }) {
  if (!url) {
    return <div className="w-24 aspect-[2.5/3.5] rounded-lg flex-shrink-0 self-start bg-white/5" />
  }
  return (
    <button
      type="button"
      onClick={onZoom}
      title={t?.('scanner.expandCard')}
      className="w-24 aspect-[2.5/3.5] flex-shrink-0 self-start rounded-lg overflow-hidden
        ring-1 ring-white/10 hover:ring-brand-red/40 transition-all cursor-zoom-in"
    >
      <img src={url} alt="" className="w-full h-full object-contain" />
    </button>
  )
}

// One queued photo in the review list: thumbnail + detected info + its own
// MatchesGrid, or a pending/error state.
export function ScanItemPanel({ jobId, item, onSelectMatch, onResolve, t }) {
  const photoUrl = useScanItemPhoto(jobId, item)
  // { card } for a candidate, null for "just the photo".
  const [zoom, setZoom] = useState(null)

  return (
    <div className={`rounded-2xl p-3 flex gap-3 transition-opacity ${item.resolved ? 'opacity-40' : ''}`}
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {zoom !== null && (
        <CardZoomModal card={zoom.card} photoUrl={photoUrl} onClose={() => setZoom(null)} t={t} />
      )}
      <ScanItemThumb url={photoUrl} onZoom={() => setZoom({ card: null })} t={t} />
      <div className="flex-1 min-w-0">
        {item.status === 'pending' && (
          <p className="text-sm text-text-muted flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> {t('scanner.itemPending')}
          </p>
        )}
        {item.status === 'failed' && (
          <p className="text-sm text-brand-red">{item.error || t('scanner.recognitionFailed')}</p>
        )}
        {item.status === 'done' && (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-bold text-white text-sm truncate">{item.recognized?.name || '—'}</p>
                {item.recognized?.number_local && (
                  <p className="text-xs text-text-muted">
                    Nr. {item.recognized.number_local}{item.recognized.number_total ? `/${item.recognized.number_total}` : ''}
                  </p>
                )}
              </div>
              {!item.resolved && (
                <button onClick={() => onResolve(item)}
                  title={t('scanner.markReviewedHint')}
                  className="text-[10px] font-semibold px-2 py-1 rounded-lg border border-white/10 text-text-muted hover:text-white flex-shrink-0">
                  <Check size={12} className="inline mr-1" />{t('scanner.markReviewed')}
                </button>
              )}
            </div>
            {!item.resolved && (
              <div className="mt-2">
                <MatchesGrid
                  matches={item.matches}
                  onSelect={match => onSelectMatch(item, match)}
                  onZoom={card => setZoom({ card })}
                  t={t}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
