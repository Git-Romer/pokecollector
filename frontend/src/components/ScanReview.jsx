import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, Loader2, Plus, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, RotateCw } from 'lucide-react'
import { addToCollection, fetchScanCandidateImage, fetchScanJobItemImage, rotateScanJobItemImage } from '../api/client'
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
//
// With `matches` supplied this becomes the review surface itself: arrow keys step
// through the candidates for one photo, and accepting hands the chosen card to the
// add modal. Without them it is just a zoom, which is what clicking the photo
// thumbnail still does.
// Both halves of the comparison live in an identically sized frame, and each
// image is contained within it. Two reasons it is the frame that carries the
// size rather than the image:
//
//   * a low-resolution stand-in would otherwise decide its own layout from its
//     245px intrinsic width, and the candidate would render a third the size of
//     the photo beside it;
//   * a phone photo and a catalogue scan are never quite the same shape, so
//     sizing each image independently leaves the two cards misaligned — which
//     defeats the point of showing them side by side.
const CARD_FRAME = 'h-[52vh] md:h-[62vh] w-[42vw] md:w-[30vw] max-w-[420px] flex items-center justify-center'
const CARD_IMAGE = 'max-h-full max-w-full object-contain rounded-xl'

// Progressive load for one candidate scan.
//
// The thumbnail is already on screen in the grid, so it is in cache and paints
// instantly; blurring and upscaling it gives the eye something card-shaped in the
// right colours while the real scan arrives. Without it an expanded candidate is
// a blank rectangle beside the user's photo, which reads as the wrong card having
// opened rather than as loading.
//
// The full-resolution image comes from our own cache, not the TCGdex CDN. The top
// candidates are pre-fetched during recognition, so this is usually a local read.
function useCandidateFullImage(jobId, itemId, index, fallbackUrl) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    setUrl(null)
    let revoked = false
    let objectUrl = null

    // Only announce an image once it has actually decoded. Handing the <img> a
    // URL it has not fetched yet clears the "still loading" state — which drops
    // the blurred stand-in and the spinner — and then leaves a blank frame for
    // as long as the download takes. On a cold CDN fetch that is ~5 seconds of
    // nothing, which is precisely the symptom this stand-in exists to prevent.
    const announceWhenDecoded = candidate => new Promise((resolve, reject) => {
      const probe = new Image()
      probe.onload = () => resolve(candidate)
      probe.onerror = reject
      probe.src = candidate
    })

    // Falling back to the CDN keeps a cache miss or a cold start working, just
    // without the speed-up — also the only option when there's no scan job to
    // fetch a cached candidate from at all (the single-photo capture flow has
    // no jobId/itemId, since nothing is queued for that path).
    const useFallback = () => fallbackUrl && announceWhenDecoded(fallbackUrl)
      .then(ready => { if (!revoked) setUrl(ready) })
      .catch(() => {})

    if (jobId == null || itemId == null || index == null) {
      useFallback()
      return () => { revoked = true }
    }

    fetchScanCandidateImage(jobId, itemId, index)
      .then(next => {
        if (revoked) return URL.revokeObjectURL(next)
        objectUrl = next
        setUrl(next)
      })
      .catch(useFallback)
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, itemId, index, fallbackUrl])

  return url
}

// Shared zoom state for the comparison.
//
// Deliberately one transform for both cards rather than one each. What the
// reviewer is doing is holding two images against each other, so zooming the
// photo has to take the candidate with it — a per-image zoom would show two
// different parts of two different cards and answer nothing. It also survives
// stepping between candidates, so you can settle on the set symbol once and then
// arrow through all eight comparing the same corner.
//
// The two images are not pixel-aligned — a phone photo and a flatbed scan differ
// in crop, perspective and a degree or two of rotation — so "the same region" is
// proportional, not exact. That is enough to compare a corner; it is not an
// overlay and should not be sold as one.
const MAX_ZOOM = 6
const MIN_ZOOM = 1
const clamp01 = v => Math.min(1, Math.max(0, v))

function useLinkedZoom() {
  const [zoom, setZoom] = useState({ scale: 1, x: 0.5, y: 0.5 })

  // Zoom toward the pointer: keep whatever is under the cursor under the cursor,
  // which is the difference between exploring an image and fighting it.
  const zoomAt = useCallback((factor, originX, originY) => {
    setZoom(prev => {
      const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.scale * factor))
      if (scale === prev.scale) return prev
      if (scale === 1) return { scale: 1, x: 0.5, y: 0.5 }
      // Blend the focus toward the cursor by how much of the zoom is new, so a
      // slow scroll drifts gently rather than snapping to each pointer position.
      const weight = 1 - prev.scale / scale
      return {
        scale,
        x: clamp01(prev.x + (originX - prev.x) * weight),
        y: clamp01(prev.y + (originY - prev.y) * weight),
      }
    })
  }, [])

  // Drag distances arrive as a fraction of the card frame. Working out the
  // matching change in focus, for `scale(s)` about origin `o` on a frame of
  // width W: an image point p lands at s*p + o*W*(1 - s), so shifting the origin
  // by d moves the content on screen by W*d*(s - 1). Setting that equal to the
  // pointer movement gives d = dragFraction / (s - 1) — which is what makes the
  // card follow the finger rather than lag behind it.
  //
  // Floored below 1.5x: as the scale approaches 1 the divisor approaches zero
  // and the smallest drag would fling the focus across the whole card, and there
  // is almost nothing to pan to at that zoom anyway.
  // Click-to-zoom, as distinct from wheel-to-zoom. A click is one deliberate
  // "look here", so the point clicked becomes the fixed point of the
  // magnification exactly, rather than being drifted toward as the wheel does.
  //
  // The click arrives as a fraction of the frame, which is not the fraction of
  // the image once already zoomed. Inverting the transform — an image point p
  // renders at s*p + o*(1 - s) in fractions — gives the image point actually
  // under the cursor as (click + o*(s - 1)) / s.
  const focusOn = useCallback((factor, clickX, clickY) => {
    setZoom(prev => {
      const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.scale * factor))
      if (scale === prev.scale) return prev
      const imagePoint = (click, origin) => clamp01((click + origin * (prev.scale - 1)) / prev.scale)
      return {
        scale,
        x: imagePoint(clickX, prev.x),
        y: imagePoint(clickY, prev.y),
      }
    })
  }, [])

  const panBy = useCallback((dxFraction, dyFraction) => {
    setZoom(prev => {
      if (prev.scale === 1) return prev
      const travel = Math.max(prev.scale - 1, 0.5)
      return {
        ...prev,
        x: clamp01(prev.x - dxFraction / travel),
        y: clamp01(prev.y - dyFraction / travel),
      }
    })
  }, [])

  const reset = useCallback(() => setZoom({ scale: 1, x: 0.5, y: 0.5 }), [])

  return { zoom, zoomAt, focusOn, panBy, reset }
}

// A zoomed image is scaled about the shared focus point. transform-origin does
// the work, so no arithmetic is needed to keep the two cards agreeing.
const zoomStyle = ({ scale, x, y }) => scale === 1 ? undefined : {
  transform: `scale(${scale})`,
  transformOrigin: `${x * 100}% ${y * 100}%`,
}

export function CardZoomModal({ card, photoUrl, onClose, t, matches, index = 0, onIndex, onAccept,
                               jobId, itemId }) {
  const canNavigate = Array.isArray(matches) && matches.length > 1 && onIndex
  const step = useCallback(delta => {
    if (!canNavigate) return
    // Wrap, so holding an arrow cycles rather than dead-ending on the last card.
    onIndex((index + delta + matches.length) % matches.length)
  }, [canNavigate, index, matches, onIndex])

  const { zoom, zoomAt, focusOn, panBy, reset } = useLinkedZoom()
  const zoomed = zoom.scale > 1
  const drag = useRef(null)
  // Either card will do — both frames are the same size by construction.
  const frameRef = useRef(null)

  useEffect(() => {
    const onKey = e => {
      // Escape backs out of the zoom first, then closes. Closing a modal the
      // reviewer had zoomed into loses their place for no reason.
      if (e.key === 'Escape') return zoomed ? reset() : onClose()
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step, zoomed, reset])

  // Wheel handling is attached natively rather than via onWheel: React's wheel
  // listener is passive, so preventDefault there is ignored and the page scrolls
  // behind the modal while zooming.
  const surface = useRef(null)
  useEffect(() => {
    const node = surface.current
    if (!node) return undefined
    const onWheel = e => {
      e.preventDefault()
      const box = e.currentTarget.getBoundingClientRect()
      zoomAt(
        e.deltaY < 0 ? 1.15 : 1 / 1.15,
        clamp01((e.clientX - box.left) / box.width),
        clamp01((e.clientY - box.top) / box.height),
      )
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Drag to pan. Tracked from the pointer-down position so a click that never
  // moved still counts as a click — the overlay closes on click, and a pan must
  // not be mistaken for one.
  const onPointerDown = e => {
    if (!zoomed) return
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = e => {
    if (!drag.current) return
    // Measure against the card, not the surface. The surface spans both cards
    // and the gap between them — roughly three times a card's width — so
    // dividing by it made every drag about a third of the distance it should be.
    const box = (frameRef.current || e.currentTarget).getBoundingClientRect()
    const dx = (e.clientX - drag.current.x) / box.width
    const dy = (e.clientY - drag.current.y) / box.height
    if (Math.abs(dx) + Math.abs(dy) > 0.005) drag.current.moved = true
    drag.current.x = e.clientX
    drag.current.y = e.clientY
    panBy(dx, dy)
  }
  // A drag ends by firing a click. Remembered past pointerup so that click can be
  // swallowed — otherwise finishing a pan would zoom, or close the comparison.
  const draggedRef = useRef(false)
  const endDrag = () => {
    draggedRef.current = Boolean(drag.current?.moved)
    drag.current = null
  }
  const swallowClickAfterDrag = e => {
    if (draggedRef.current) {
      draggedRef.current = false
      e.stopPropagation()
    }
  }

  // Clicking a card zooms into the point clicked; clicking the backdrop closes.
  // At full zoom a click resets, so there is always a way back without the
  // keyboard — which is also why double-click-to-reset was dropped. A double
  // click fires a single click first, so the two would have fought unless every
  // click were delayed to watch for a second, and that delay is felt.
  const onCardClick = e => {
    e.stopPropagation()
    if (draggedRef.current) return
    if (zoom.scale >= MAX_ZOOM) return reset()
    const box = e.currentTarget.getBoundingClientRect()
    focusOn(
      1.6,
      clamp01((e.clientX - box.left) / box.width),
      clamp01((e.clientY - box.top) / box.height),
    )
  }

  // Keep the neighbours warm so stepping through with the arrows does not flash
  // an empty frame on every press.
  useEffect(() => {
    if (!Array.isArray(matches) || !matches.length) return
    const next = matches[(index + 1) % matches.length]
    const prev = matches[(index - 1 + matches.length) % matches.length]
    ;[next, prev].forEach(m => prefetchImage(m?.image_hd || m?.image))
  }, [matches, index])

  // Prefer the explicit high-res URL, but derive it for matches stored before
  // that field existed — otherwise zooming an old job shows a 245px thumbnail,
  // which is exactly what this modal is meant to avoid. Thumbnail as a last
  // resort: a small image beats a broken one.
  const cdnFull = card?.image_hd || card?.image?.replace('/low.webp', '/high.webp') || card?.image
  // Served from our cache when we can; the thumbnail stands in until it lands.
  // Above the early return: hooks cannot sit behind a conditional.
  const full = useCandidateFullImage(jobId, itemId, card ? index : null, cdnFull)

  if (!card && !photoUrl) return null

  return createPortal(
    // Clicking anywhere closes, the image included — the whole overlay is the
    // dismiss target, which is what a full-screen viewer is expected to do.
    <div className="fixed inset-0 z-[400] bg-black/90 flex flex-col p-4 cursor-zoom-out" onClick={onClose}>
      <div className="flex justify-end flex-shrink-0">
        <button onClick={onClose} aria-label={t('common.close')}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors">
          <X size={18} className="text-white" />
        </button>
      </div>
      {/* The pair is centred as a block, but the two images sit in identical
          boxes aligned at the top. Centring each figure instead would let the
          captions decide the layout — one line under the photo against three
          under the candidate — and push the two cards out of line with each
          other, which is the one thing this view exists to avoid. */}
      <div
        ref={surface}
        // select-none: a drag over images and captions otherwise runs the
        // browser's native selection, painting everything blue mid-pan. There is
        // nothing here worth selecting — it is a comparison, not a document.
        className="flex-1 min-h-0 flex items-center justify-center py-3 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={swallowClickAfterDrag}
        onDragStart={e => e.preventDefault()}
        style={{ cursor: zoomed ? 'grab' : undefined, touchAction: zoomed ? 'none' : undefined }}
      >
        <div className="flex flex-col md:flex-row items-start justify-center gap-4 md:gap-8">
        {photoUrl && (
          <figure className="flex flex-col items-center">
            <div ref={frameRef} onClick={onCardClick}
              className={`${CARD_FRAME} overflow-hidden ${zoomed ? 'cursor-grab' : 'cursor-zoom-in'}`}>
              <img src={photoUrl} alt={t('scanner.yourPhoto')} className={CARD_IMAGE}
                style={zoomStyle(zoom)} draggable={false} />
            </div>
            <figcaption className="text-[11px] text-text-muted mt-2">{t('scanner.yourPhoto')}</figcaption>
          </figure>
        )}
        {card && (
          <figure className="flex flex-col items-center">
            {/* Structurally identical to the photo above, deliberately. The
                clipping box has to be the frame on both sides: when it was the
                image's own box here and the frame there, zooming let one side
                expand into its letterboxing while the other stayed pinned, and
                the two cards visibly diverged in size.
                overflow-hidden also does the job the inner wrapper used to —
                without it the blurred stand-in spreads past the card edge into
                the black overlay and fades to nothing. */}
            <div ref={frameRef} onClick={onCardClick}
              className={`${CARD_FRAME} relative overflow-hidden ${zoomed ? 'cursor-grab' : 'cursor-zoom-in'}`}>
              <img src={full || card.image} alt={card?.name}
                // Transition only the blur. Animating transform would make
                // every pan lag a frame behind the pointer.
                className={`${CARD_IMAGE} transition-[filter] duration-300
                  ${full ? '' : 'blur-md scale-105'}`}
                style={zoomStyle(zoom)} draggable={false} />
              {/* Centred over the card it belongs to: tucked in a corner it read
                  as page furniture rather than as this image still loading. */}
              {!full && (
                <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="rounded-full bg-black/55 p-3">
                    <Loader2 size={28} className="animate-spin text-white/90" />
                  </span>
                </span>
              )}
            </div>
            <figcaption className="text-center mt-2 space-y-0.5">
              <p className="text-sm font-bold text-white">{card?.name}</p>
              <p className="text-[11px] font-mono text-brand-red/80">
                {`${(card?.set_abbreviation || '').toUpperCase()} ${card?.number || ''}`.trim()}
              </p>
              <p className="text-[11px] text-text-muted">
                {[card?.set, card?.rarity, (card?.lang || card?._lang || '').toUpperCase()]
                  .filter(Boolean).join(' · ')}
              </p>
            </figcaption>
          </figure>
        )}
        </div>
      </div>

      {/* Accept bar. stopPropagation because the overlay itself closes on click,
          and a mis-aimed tap next to Accept should not dismiss the comparison. */}
      {onAccept && card && (
        <div className="flex-shrink-0 flex items-center justify-center gap-3 pb-1 cursor-default"
          onClick={e => e.stopPropagation()}>
          {canNavigate && (
            <button onClick={() => step(-1)} aria-label={t('scanner.previousMatch')}
              className="w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors">
              <ChevronLeft size={20} className="text-white" />
            </button>
          )}
          <button
            onClick={() => onAccept(card)}
            className="px-6 py-3 rounded-xl font-black text-white flex items-center gap-2 transition-all"
            style={{ background: '#e3000b', boxShadow: '0 0 16px rgba(227,0,11,0.35)' }}
          >
            <Check size={18} />{t('scanner.acceptMatch')}
          </button>
          {canNavigate && (
            <button onClick={() => step(1)} aria-label={t('scanner.nextMatch')}
              className="w-10 h-10 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors">
              <ChevronRight size={20} className="text-white" />
            </button>
          )}
        </div>
      )}
      {canNavigate && (
        <p className="flex-shrink-0 text-center text-[11px] text-text-muted pt-2">
          {index + 1} / {matches.length} · {t('scanner.arrowKeyHint')} · {t('scanner.zoomHint')}
        </p>
      )}
    </div>,
    document.body
  )
}

// Warm the browser cache for a candidate image before it is needed.
//
// Two delays are worth removing. Opening a scan page loads up to eight thumbnails
// per photo from the TCGdex CDN, which is noticeably slower than its API; and the
// zoom modal then asks for the *high-res* version, which has never been fetched at
// that point, so an expanded card appears blank for a moment beside the user's
// photo and reads as the wrong card having opened.
//
// Decoding is left to the browser: this only needs the bytes in cache, and the
// requests are ordinary GETs the <img> tag will hit again and find warm. The seen
// set keeps a re-render from re-requesting.
const prefetched = new Set()

function prefetchImage(url) {
  if (!url || prefetched.has(url)) return
  prefetched.add(url)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
}

// Thumbnails are small and always shown, so fetch them all as soon as the
// matches arrive. The high-res versions are ~10x larger and most are never
// opened, so those wait for intent — a hover or a touch on the tile.
export function usePrefetchMatchImages(matches) {
  useEffect(() => {
    (matches || []).forEach(m => prefetchImage(m.image))
  }, [matches])
}

export function MatchesGrid({ matches, onSelect, onZoom, t }) {
  usePrefetchMatchImages(matches)

  if (!matches?.length) {
    return (
      <div className="text-center py-6 space-y-2">
        <p className="text-text-muted text-sm">{t('scanner.noMatches')}</p>
        <p className="text-xs text-text-muted">{t('scanner.noMatchTip')}</p>
      </div>
    )
  }

  // The API caps candidates at eight, so four across is always exactly two rows.
  // Fewer columns than before, which hands the width back to the scanned photo —
  // the thing the user is actually comparing against.
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {matches.map((match, matchIndex) => {
        const matchLang = match.lang || match._lang || 'en'
        const setCode = (match.set_abbreviation || match.set?.id || (match.id || '').split('-')[0]).toUpperCase()
        const localNum = match.localId || match.number || ''
        const cardIdLabel = `${setCode} ${localNum}`.trim()
        return (
          <div key={`${match.id}-${matchLang}`}
            className="flex flex-col cursor-pointer group hover:shadow-glow transition-all duration-200 hover:rotate-1"
            // The tile opens the comparison, because deciding whether this is
            // the card comes before adding it. Adding is the deliberate act and
            // gets its own button.
            onClick={() => (onZoom ? onZoom(match, matchIndex) : onSelect(match))}
            // Intent to look closely: pull the high-res now so the zoom modal has
            // it by the time the expand button is clicked.
            onMouseEnter={() => prefetchImage(match.image_hd)}
            onTouchStart={() => prefetchImage(match.image_hd)}
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
                {/* stopPropagation: the tile behind this opens the comparison.
                    Adding straight from the grid stays possible for a card you
                    already recognise, without a look you did not ask for. */}
                <button
                  onClick={e => { e.stopPropagation(); onSelect(match) }}
                  title={t('scanner.addToCollection')}
                  aria-label={t('scanner.addToCollection')}
                  className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                  style={{ background: '#e3000b', boxShadow: '0 0 12px rgba(227,0,11,0.5)' }}
                >
                  <Plus size={15} className="text-white" />
                </button>
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

  // Recognition rewrites the stored photo when it works out which way up the
  // card is, so the bytes change *after* the item first appears. The page polls
  // while a job runs, which means the first fetch happens during `pending` —
  // before that rewrite — and without `updated_at` here nothing would ever ask
  // for the corrected image. A card photographed upside down stayed upside down
  // on screen while the file on the server was the right way up.
  const revision = item?.updated_at || item?.status

  // Held in a ref so the unmount cleanup can revoke whatever is current without
  // the effect that fetches having to depend on it.
  const currentUrl = useRef(null)
  useEffect(() => () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
  }, [])

  useEffect(() => {
    // Nullable: the review modal lives at page level and asks for whichever item
    // is currently open, which is nothing at all until a review starts.
    if (!item?.has_image) return undefined
    let cancelled = false
    fetchScanJobItemImage(jobId, item.id)
      .then(next => {
        if (cancelled) {
          URL.revokeObjectURL(next)
          return
        }
        // Swap only once the replacement is in hand, and revoke the old one
        // then — not in the effect's cleanup, which runs *before* the new fetch
        // resolves and would blank a photo the reviewer is looking at.
        if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
        currentUrl.current = next
        setUrl(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [jobId, item?.id, item?.has_image, revision])

  // Blank immediately when the *item* changes, so stepping to the next photo
  // never shows the previous card for a frame. Deliberately not keyed on the
  // revision: a re-fetch of the same photo should hold the old frame until the
  // corrected one arrives rather than flashing empty.
  useEffect(() => { setUrl(null) }, [item?.id])

  return url
}

// `self-start` matters: the panel is a flex row, so without it the image is
// stretched to the full panel height (as tall as the match grid) and
// aspect-ratio is ignored. `object-contain` then keeps the whole card visible
// instead of cropping it to a narrow vertical slice.
// Wider than the candidate tiles on purpose: this is the card the user is
// actually identifying, and the 4-column match grid leaves the room for it.
const THUMB_WIDTH = 'w-32 sm:w-44 lg:w-52'

export function ScanItemThumb({ url, onZoom, onRotate, rotating, t }) {
  if (!url) {
    return <div className={`${THUMB_WIDTH} aspect-[2.5/3.5] rounded-lg flex-shrink-0 self-start bg-white/5`} />
  }
  return (
    <div className={`${THUMB_WIDTH} flex-shrink-0 self-start`}>
      <button
        type="button"
        onClick={onZoom}
        title={t?.('scanner.expandCard')}
        className="w-full aspect-[2.5/3.5] rounded-lg overflow-hidden block
          ring-1 ring-white/10 hover:ring-brand-red/40 transition-all cursor-zoom-in"
      >
        <img src={url} alt="" className="w-full h-full object-contain" />
      </button>
      {/* Photos are straightened automatically when the matched card has a
          catalogue scan to compare against. Nothing reliable exists for the rest
          — two automatic fallbacks were measured at 62% and 58% against a 25%
          baseline, and a wrong guess turns a correct photo upside down — so the
          reviewer gets a quarter-turn button instead of a coin flip. */}
      {onRotate && (
        <button
          type="button"
          onClick={onRotate}
          disabled={rotating}
          title={t?.('scanner.rotatePhoto')}
          aria-label={t?.('scanner.rotatePhoto')}
          className="mt-1 w-full py-1 rounded-lg border border-white/10 bg-white/5 text-text-muted
            hover:text-white hover:border-white/20 transition-colors flex items-center justify-center
            disabled:opacity-50"
        >
          {rotating
            ? <Loader2 size={13} className="animate-spin" />
            : <RotateCw size={13} />}
        </button>
      )}
    </div>
  )
}

// One queued photo in the review list: thumbnail + detected info + its own
// MatchesGrid, or a pending/error state.
export function ScanItemPanel({ jobId, item, onSelectMatch, onResolve, onReview, onRotated, t }) {
  const photoUrl = useScanItemPhoto(jobId, item)
  // Photo-only zoom stays local. Expanding a *candidate* starts a review, which
  // the page owns because it can run on past the end of this item into the next.
  const [zoom, setZoom] = useState(false)
  const [rotating, setRotating] = useState(false)
  // Only meaningful once resolved; an unreviewed item is always expanded.
  const [expanded, setExpanded] = useState(false)

  const rotate = async () => {
    setRotating(true)
    try {
      await rotateScanJobItemImage(jobId, item.id, 90)
      // The server bumps updated_at, which is what useScanItemPhoto keys on, so
      // refreshing the job data is all it takes for the new photo to appear.
      onRotated?.()
    } catch {
      toast.error(t('scanner.rotateFailed'))
    } finally {
      setRotating(false)
    }
  }

  // A confirmed card is finished business. Left expanded it takes as much room as
  // one still needing a decision, and rather worse: resolving drops the stored
  // photo, so what remains is a large empty frame beside an empty grid. Collapsed
  // to a line, the list stays a list of things still to do.
  const confirmed = (item.matches || []).find(m => m.tcg_card_id === item.selected_card_id)
  if (item.resolved && !expanded) {
    const label = confirmed?.name || item.recognized?.name_en || item.recognized?.name || item.filename
    const setLabel = confirmed
      ? `${(confirmed.set_abbreviation || '').toUpperCase()} ${confirmed.number || ''}`.trim()
      : ''
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={t('scanner.showDetails')}
        className="w-full rounded-2xl px-3 py-2 flex items-center gap-3 text-left transition-colors
          hover:bg-white/[0.06]"
        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0
          bg-green/20 border border-green/40">
          <Check size={13} className="text-green" />
        </span>
        <span className="flex-1 min-w-0 flex items-baseline gap-2">
          <span className="font-bold text-white text-sm truncate">{label}</span>
          {setLabel && <span className="text-[11px] font-mono text-brand-red/80">{setLabel}</span>}
          {confirmed?.set && (
            <span className="text-[11px] text-text-muted truncate hidden sm:inline">{confirmed.set}</span>
          )}
        </span>
        <ChevronDown size={15} className="text-text-muted flex-shrink-0" />
      </button>
    )
  }

  return (
    // Not dimmed when resolved: collapsing already says "finished", and far
    // better than fading. Expanding is an explicit request to look at something,
    // so greying out what was asked for — the collapse control included — works
    // against the person doing it.
    <div className="rounded-2xl p-3 flex gap-3"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {zoom && (
        <CardZoomModal card={null} photoUrl={photoUrl} onClose={() => setZoom(false)} t={t} />
      )}
      <ScanItemThumb url={photoUrl} onZoom={() => setZoom(true)}
        onRotate={item.has_image ? rotate : undefined} rotating={rotating} t={t} />
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
              {item.resolved && (
                <button onClick={() => setExpanded(false)}
                  title={t('scanner.hideDetails')}
                  aria-label={t('scanner.hideDetails')}
                  className="text-[10px] font-semibold px-2 py-1 rounded-lg border border-white/10 text-text-muted hover:text-white flex-shrink-0">
                  <ChevronUp size={12} className="inline" />
                </button>
              )}
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
                  onZoom={(card, matchIndex) => onReview?.(item, matchIndex)}
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
