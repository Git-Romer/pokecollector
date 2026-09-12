import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { fetchScanCandidateImage, fetchScanJobItemImage } from '../api/client'
import CardImage from './CardImage'
import { useDialogBehavior } from './ui/dialogBehavior'
import { formatRetryCountdown } from '../utils/retryCountdown'

// Shared between the queue page (ScanQueue) and, previously, the capture
// modal — the capture modal now has its own inline results grid and its own
// ScanAddModal in CardScanner.jsx, so everything below is specific to the
// persistent batch review page.

// ─── The stored photo for a queued item, as an object URL ──────────────────
// Fetched as a blob because the endpoint is authenticated (an <img src>
// cannot send the bearer token), which also means it survives a reload where
// a local blob: URL would not.
export function useScanItemPhoto(jobId, item) {
  const [url, setUrl] = useState(null)

  // `item` can be null — ScanQueue's review session calls this before a
  // photo is chosen, and hooks cannot sit behind a conditional.
  useEffect(() => {
    if (!item?.has_image) {
      setUrl(null)
      return undefined
    }
    let disposed = false
    let objectUrl = null
    fetchScanJobItemImage(jobId, item.id)
      .then(nextUrl => {
        if (disposed) {
          URL.revokeObjectURL(nextUrl)
          return
        }
        objectUrl = nextUrl
        setUrl(nextUrl)
      })
      .catch(() => setUrl(null))
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, item?.id, item?.has_image])

  return url
}

// ─── Linked pan/zoom comparison ─────────────────────────────────────────────
// Full-screen look at a candidate next to the user's own photo where we have
// it. Comparing the two at real size is the decision the reviewer is
// actually making, so the modal shows both rather than the candidate alone.
//
// With `matches` supplied this becomes the review surface itself: arrow keys
// step through the candidates for one photo, and accepting hands the chosen
// card to the add modal. Without them it is just a zoom, which is what
// clicking the photo thumbnail does.
//
// Both halves of the comparison live in an identically sized frame, and each
// image is contained within it. Two reasons it is the frame that carries the
// size rather than the image:
//
//   * a low-resolution stand-in would otherwise decide its own layout from
//     its ~245px intrinsic width, and the candidate would render a third the
//     size of the photo beside it;
//   * a phone photo and a catalogue scan are never quite the same shape, so
//     sizing each image independently leaves the two cards misaligned —
//     which defeats the point of showing them side by side.
//
// Give both sides one real card-shaped viewport instead of two loose boxes.
// The old max-width/max-height combination let a 3:4 phone photo and a
// catalogue scan settle at different rendered heights. A 5:7 viewport keeps
// their visible edges aligned; object-cover only trims the small amount of
// background/crop variance outside that shared card ratio.
//
// On phones the comparison stacks, but both figures still need to fit in
// the visible modal without scrolling. Dynamic viewport height is therefore
// the primary bound there; the result is still meaningfully larger than a
// half-width side-by-side card. From the tablet breakpoint onward the same
// figures sit side by side. A photo-only viewer can use considerably more
// space because it has no comparison sibling.
const COMPARISON_CARD_WIDTH = 'w-[min(76vw,24dvh,220px)] md:w-[min(30vw,44.286dvh,420px)]'
const SOLO_CARD_WIDTH = 'w-[min(88vw,55dvh,560px)]'
const CARD_FRAME = 'aspect-[5/7] w-full flex items-center justify-center rounded-xl'
const CARD_IMAGE = 'h-full w-full object-cover rounded-xl'

// Progressive load for one candidate scan.
//
// The thumbnail is already on screen in the grid, so it is in cache and
// paints instantly; blurring and upscaling it gives the eye something
// card-shaped in the right colours while the real scan arrives. Without it,
// an expanded candidate is a blank rectangle beside the user's photo, which
// reads as the wrong card having opened rather than as loading.
//
// The full-resolution image comes from our own cache, not the TCGdex CDN —
// the top candidates are pre-fetched during recognition (see
// backend/services/scan_candidate_images.py), so this is usually a local
// read.
function useCandidateFullImage(jobId, itemId, index, fallbackUrl) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    setUrl(null)
    let revoked = false
    let objectUrl = null

    // Only announce an image once it has actually decoded. Handing the <img>
    // a URL it has not fetched yet clears the "still loading" state — which
    // drops the blurred stand-in and the spinner — and then leaves a blank
    // frame for as long as the download takes. On a cold CDN fetch that is
    // ~5 seconds of nothing, which is precisely the symptom this stand-in
    // exists to prevent.
    const announceWhenDecoded = candidate => new Promise((resolve, reject) => {
      const probe = new Image()
      probe.onload = () => resolve(candidate)
      probe.onerror = reject
      probe.src = candidate
    })

    // Falling back to the CDN keeps a cache miss working, just without the
    // speed-up.
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
        return announceWhenDecoded(next)
          .then(ready => { if (!revoked) setUrl(ready) })
          .catch(() => {
            URL.revokeObjectURL(next)
            objectUrl = null
            return useFallback()
          })
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
// different parts of two different cards and answer nothing. It also
// survives stepping between candidates, so you can settle on the set symbol
// once and then arrow through the rest comparing the same corner.
//
// The two images are not pixel-aligned — a phone photo and a flatbed scan
// differ in crop, perspective and a degree or two of rotation — so "the same
// region" is proportional, not exact. That is enough to compare a corner; it
// is not an overlay and should not be sold as one.
const MAX_ZOOM = 6
const MIN_ZOOM = 1
const clamp01 = v => Math.min(1, Math.max(0, v))

function useLinkedZoom() {
  const [zoom, setZoom] = useState({ scale: 1, x: 0.5, y: 0.5 })

  // Zoom toward the pointer: keep whatever is under the cursor under the
  // cursor, which is the difference between exploring an image and fighting
  // it.
  const zoomAt = useCallback((factor, originX, originY) => {
    setZoom(prev => {
      const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.scale * factor))
      if (scale === prev.scale) return prev
      if (scale === 1) return { scale: 1, x: 0.5, y: 0.5 }
      // Blend the focus toward the cursor by how much of the zoom is new, so
      // a slow scroll drifts gently rather than snapping to each pointer
      // position.
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
  // width W: an image point p lands at s*p + o*W*(1 - s), so shifting the
  // origin by d moves the content on screen by W*d*(s - 1). Setting that
  // equal to the pointer movement gives d = dragFraction / (s - 1) — which is
  // what makes the card follow the finger rather than lag behind it.
  //
  // Floored below 1.5x: as the scale approaches 1 the divisor approaches
  // zero and the smallest drag would fling the focus across the whole card,
  // and there is almost nothing to pan to at that zoom anyway.
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

  // Click-to-zoom, as distinct from wheel-to-zoom. A click is one deliberate
  // "look here", so the point clicked becomes the fixed point of the
  // magnification exactly, rather than being drifted toward as the wheel
  // does.
  //
  // The click arrives as a fraction of the frame, which is not the fraction
  // of the image once already zoomed. Inverting the transform — an image
  // point p renders at s*p + o*(1 - s) in fractions — gives the image point
  // actually under the cursor as (click + o*(s - 1)) / s.
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

  const reset = useCallback(() => setZoom({ scale: 1, x: 0.5, y: 0.5 }), [])

  return { zoom, zoomAt, focusOn, panBy, reset }
}

// A zoomed image is scaled about the shared focus point. transform-origin
// does the work, so no arithmetic is needed to keep the two cards agreeing.
const zoomStyle = ({ scale, x, y }) => scale === 1 ? undefined : {
  transform: `scale(${scale})`,
  transformOrigin: `${x * 100}% ${y * 100}%`,
}

export function CardZoomModal({
  card, photoUrl, onClose, t, matches, index = 0, onIndex, onAccept, jobId, itemId,
}) {
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
  const closeOrReset = useCallback(() => (zoomed ? reset() : onClose()), [onClose, reset, zoomed])
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(true, closeOrReset, { restoreFocus: false })
  const onModalKeyDown = e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); return }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); return }
    onDialogKeyDown(e)
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  // Wheel handling is attached natively rather than via onWheel: React's
  // wheel listener is passive, so preventDefault there is ignored and the
  // page scrolls behind the modal while zooming.
  const surface = useRef(null)
  useEffect(() => {
    const node = surface.current
    if (!node) return undefined
    const onWheel = e => {
      e.preventDefault()
      const box = node.getBoundingClientRect()
      zoomAt(
        e.deltaY < 0 ? 1.15 : 1 / 1.15,
        clamp01((e.clientX - box.left) / box.width),
        clamp01((e.clientY - box.top) / box.height),
      )
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Drag to pan. Tracked from pointer-down so a stationary press remains a
  // card click while real movement is not mistaken for the zoom toggle.
  const onPointerDown = e => {
    if (!zoomed) return
    // Do not capture yet. Capturing an ordinary click retargets its click
    // event from the card to this full comparison surface, where it bubbles
    // to the backdrop and closes the viewer instead of resetting the zoom.
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      distance: 0,
      moved: false,
      pointerId: e.pointerId,
      captured: false,
    }
  }
  const onPointerMove = e => {
    if (!drag.current) return
    // Measure against the card, not the surface. The surface spans both
    // cards and the gap between them — roughly three times a card's width —
    // so dividing by it made every drag about a third of the distance it
    // should be.
    const box = (frameRef.current || e.currentTarget).getBoundingClientRect()
    const deltaX = e.clientX - drag.current.x
    const deltaY = e.clientY - drag.current.y
    const dx = deltaX / box.width
    const dy = deltaY / box.height
    // Pointer events can arrive in many tiny increments. Measure the whole
    // gesture rather than each event independently, otherwise a slow drag
    // can pan visibly but still be mistaken for a click on pointer-up.
    drag.current.distance += Math.hypot(deltaX, deltaY)
    if (drag.current.distance / Math.min(box.width, box.height) > 0.005) {
      drag.current.moved = true
      if (!drag.current.captured) {
        e.currentTarget.setPointerCapture?.(drag.current.pointerId)
        drag.current.captured = true
      }
    }
    drag.current.x = e.clientX
    drag.current.y = e.clientY
    panBy(dx, dy)
  }
  // A drag ends by firing a click. Remembered past pointerup so that click
  // can be swallowed — otherwise finishing a pan would zoom, or close the
  // comparison.
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

  // A card click is a simple fit/zoom toggle: the first click gives a clear
  // 2x close-up around that point and the next click returns to the complete
  // card. Keeping this binary avoids later clicks merely shifting the focus
  // (which reads as panning) and works the same in comparison and photo-only
  // views. The backdrop remains the explicit close target.
  const onCardClick = e => {
    e.stopPropagation()
    if (draggedRef.current) return
    if (zoomed) return reset()
    const box = e.currentTarget.getBoundingClientRect()
    focusOn(
      2,
      clamp01((e.clientX - box.left) / box.width),
      clamp01((e.clientY - box.top) / box.height),
    )
  }

  // Prefer the explicit high-res URL, but derive it for matches stored
  // before that field existed — otherwise zooming an old job shows a 245px
  // thumbnail, which is exactly what this modal is meant to avoid.
  // Thumbnail as a last resort: a small image beats a broken one.
  const cdnFull = card?.image_hd || card?.image?.replace('/low.webp', '/high.webp') || card?.image
  // Served from our cache when we can; the thumbnail stands in until it
  // lands. Above the early return: hooks cannot sit behind a conditional.
  const full = useCandidateFullImage(jobId, itemId, card ? index : null, cdnFull)

  // useCandidateFullImage already falls back thumbnail-URL-if-cache-miss, but
  // if that URL itself 404s or errors out there was nothing downstream to
  // catch it — a bare <img> just renders broken, permanently under the
  // "still loading" spinner below since `full` never arrives either. Keyed
  // on the candidate so stepping to the next one doesn't inherit a stale
  // failure.
  const [imageFailed, setImageFailed] = useState(false)
  const [retryAttempt, setRetryAttempt] = useState(0)
  useEffect(() => {
    setImageFailed(false)
    setRetryAttempt(0)
  }, [card?.id])
  // A failed thumbnail must not permanently hide a valid cached high-res
  // image that completes moments later.
  useEffect(() => {
    if (full) setImageFailed(false)
  }, [full])
  const retrySrc = full || (card?.image && retryAttempt > 0
    ? `${card.image}${card.image.includes('?') ? '&' : '?'}retry=${retryAttempt}`
    : card?.image)
  const cardWidth = photoUrl && card ? COMPARISON_CARD_WIDTH : SOLO_CARD_WIDTH

  if (!card && !photoUrl) return null

  return createPortal(
    // The backdrop closes the viewer. Card clicks deliberately stop here so
    // they can toggle zoom without dismissing the comparison.
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('scanner.compareCandidate')}
      tabIndex={-1}
      onKeyDown={onModalKeyDown}
      // Extra top padding, floored at the existing p-4: on some mobile
      // browsers a fixed, full-screen overlay can render partly behind the
      // address bar rather than below it, and safe-area-inset-top is the
      // platform's own answer for "how much is currently covered up top."
      className="fixed inset-0 z-[400] flex cursor-default flex-col bg-black/90 p-4 [padding-top:max(1rem,env(safe-area-inset-top))]"
      onClick={onClose}>
      <div className="flex flex-shrink-0 justify-end">
        <button type="button" onClick={onClose} aria-label={t('common.close')}
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20">
          <X size={18} className="text-white" />
        </button>
      </div>
      {/* The pair is centred as a block, but the two images sit in identical
          boxes aligned at the top. Centring each figure instead would let
          the captions decide the layout — one line under the photo against
          three under the candidate — and push the two cards out of line with
          each other, which is the one thing this view exists to avoid. */}
      <div
        ref={surface}
        // select-none: a drag over images and captions otherwise runs the
        // browser's native selection, painting everything blue mid-pan.
        // There is nothing here worth selecting — it is a comparison, not a
        // document.
        // overflow-y-auto is a safety net: the pair is sized to fit a typical
        // phone viewport, but a taller translated caption or a very short
        // screen should remain reachable instead of being silently clipped.
        className="flex min-h-0 flex-1 select-none items-start justify-center overflow-y-auto py-2 md:items-center md:py-3"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={swallowClickAfterDrag}
        onDragStart={e => e.preventDefault()}
        style={{ touchAction: zoomed ? 'none' : undefined }}
      >
        <div className="flex flex-col items-start justify-center gap-2 md:flex-row md:gap-8">
          {photoUrl && (
            <figure className={`${cardWidth} flex min-w-0 flex-col items-center`}>
              <div ref={frameRef} onClick={onCardClick}
                className={`${CARD_FRAME} overflow-hidden ${zoomed ? 'cursor-grab' : 'cursor-zoom-in'}`}>
                <img src={photoUrl} alt={t('scanner.yourPhoto')} className={CARD_IMAGE}
                  style={zoomStyle(zoom)} draggable={false} />
              </div>
              <figcaption className="mt-2 w-full text-center text-sm font-semibold text-white/85">{t('scanner.yourPhoto')}</figcaption>
            </figure>
          )}
          {card && (
            <figure className={`${cardWidth} flex min-w-0 flex-col items-center`}>
              {/* Structurally identical to the photo above, deliberately.
                  The clipping box has to be the frame on both sides: when it
                  was the image's own box here and the frame there, zooming
                  let one side expand into its letterboxing while the other
                  stayed pinned, and the two cards visibly diverged in size.
                  overflow-hidden also does the job an inner wrapper would
                  otherwise need — without it the blurred stand-in spreads
                  past the card edge into the black overlay and fades to
                  nothing. */}
              <div ref={frameRef} onClick={onCardClick}
                className={`${CARD_FRAME} relative overflow-hidden ${zoomed ? 'cursor-grab' : 'cursor-zoom-in'}`}>
                {!imageFailed && (
                  <img src={retrySrc} alt={card?.name}
                    // The loading placeholder is oversized via width/height,
                    // not transform: transform is reserved for pan/zoom, and a
                    // transition on it would make every pan lag a frame behind
                    // the pointer. Sizing this way still lets the oversize
                    // animate away smoothly instead of snapping the instant
                    // the high-res image lands — the snap otherwise landed
                    // mid-blur-fade and read as the candidate briefly being a
                    // different scale from the photo beside it.
                    className={`${CARD_IMAGE} transition-[filter,width,height] duration-300 ${full ? '' : 'blur-md'}`}
                    style={{ ...zoomStyle(zoom), ...(full ? null : { width: '105%', height: '105%' }) }}
                    draggable={false}
                    onError={() => setImageFailed(true)} />
                )}
                {/* Centred over the card it belongs to: tucked in a corner
                    it read as page furniture rather than as this image still
                    loading. */}
                {!full && !imageFailed && (
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="rounded-full bg-black/55 p-3">
                      <Loader2 size={28} className="animate-spin text-white/90" />
                    </span>
                  </span>
                )}
                {/* The candidate URL 404'd or errored out -- same failure
                    this card would hit anywhere else in the app, so the
                    same "artwork unavailable, retry" state rather than a
                    permanently blurred placeholder with a spinner that
                    never resolves. */}
                {imageFailed && (
                  // Not bg-bg-elevated (a flat grey fill reads as a broken
                  // layout against this modal's dark background, not as a
                  // card-shaped placeholder). Same bg-black/55 the loading
                  // spinner circle above already uses.
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/55 p-3 text-center"
                    onClick={e => e.stopPropagation()}>
                    <span className="grid h-10 w-10 place-items-center rounded-full border border-brand-red/40 bg-brand-red/15 text-brand-red">
                      <AlertTriangle size={18} aria-hidden />
                    </span>
                    <strong className="text-xs text-text-primary">{t('card.artworkUnavailable')}</strong>
                    <span className="text-[10px] leading-tight text-text-muted">{t('card.artworkUnavailableHint')}</span>
                    <button type="button" className="btn-ghost mt-1 min-h-8 px-3 py-1.5 text-xs"
                      onClick={() => { setImageFailed(false); setRetryAttempt(a => a + 1) }}
                      aria-label={t('card.retryImage')}>
                      <RefreshCw size={13} aria-hidden />{t('common.retry')}
                    </button>
                  </div>
                )}
              </div>
              <figcaption className="mt-2 w-full space-y-0.5 text-center">
                <p className="text-base font-bold text-white">{card?.name}</p>
                <p className="text-sm font-mono font-semibold text-brand-red">
                  {`${(card?.set_abbreviation || '').toUpperCase()} ${card?.number || ''}`.trim()}
                </p>
                <p className="text-sm leading-snug text-white/75">
                  {[card?.set, card?.rarity, (card?.lang || card?._lang || '').toUpperCase()]
                    .filter(Boolean).join(' · ')}
                </p>
              </figcaption>
            </figure>
          )}
        </div>
      </div>

      {/* Accept bar. stopPropagation because the overlay itself closes on
          click, and a mis-aimed tap next to Accept should not dismiss the
          comparison. */}
      {onAccept && card && (
        <div className="flex flex-shrink-0 cursor-default items-center justify-center gap-3 pb-1"
          onClick={e => e.stopPropagation()}>
          {canNavigate && (
            <button type="button" onClick={() => step(-1)} aria-label={t('scanner.previousMatch')}
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20">
              <ChevronLeft size={20} className="text-white" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onAccept(card)}
            className="flex cursor-pointer items-center gap-2 rounded-xl px-6 py-3 font-black text-white transition-all"
            style={{ background: '#e3000b', boxShadow: '0 0 16px rgba(227,0,11,0.35)' }}
          >
            <Check size={18} />{t('scanner.acceptMatch')}
          </button>
          {canNavigate && (
            <button type="button" onClick={() => step(1)} aria-label={t('scanner.nextMatch')}
              className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20">
              <ChevronRight size={20} className="text-white" />
            </button>
          )}
        </div>
      )}
      {canNavigate && (
        <p className="flex-shrink-0 pt-2 text-center text-sm text-white/70">
          {index + 1} / {matches.length} · {t('scanner.arrowKeyHint')} · {t('scanner.zoomHint')}
        </p>
      )}
    </div>,
    document.body
  )
}

// ─── Progressive / prefetched candidate images ──────────────────────────────
// Warm the browser cache for a candidate image before it is needed.
//
// Two delays are worth removing. Opening a scan item shows up to eight
// thumbnails from the TCGdex CDN, which is noticeably slower than its API;
// and the zoom modal then asks for the *high-res* version, which has never
// been fetched at that point, so an expanded card appears blank for a moment
// beside the user's photo and reads as the wrong card having opened.
//
// Decoding is left to the browser: this only needs the bytes in cache, and
// the requests are ordinary GETs the <img> tag will hit again and find warm.
// The seen set keeps a re-render from re-requesting.
const prefetched = new Set()
const MAX_PREFETCHED_IMAGES = 64

function prefetchImage(url) {
  if (!url || prefetched.has(url)) return
  if (prefetched.size >= MAX_PREFETCHED_IMAGES) {
    prefetched.delete(prefetched.values().next().value)
  }
  prefetched.add(url)
  const img = new Image()
  img.decoding = 'async'
  img.onerror = () => prefetched.delete(url)
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

// ─── The candidate grid — the "which of these DB candidates is it" picker ──
function CandidateGrid({ jobId, itemId, matches, onSelect, onZoom, t }) {
  usePrefetchMatchImages(matches)

  if (!matches?.length) return null

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {matches.map((match, matchIndex) => {
        const language = match.lang || match._lang || 'en'
        const hdImage = match.image_hd || match.image?.replace('/low.webp', '/high.webp') || match.image
        return (
          <div
            key={`${match.id}-${language}`}
            // Intent to look closely: pull the high-res now so the zoom
            // modal already has a fallback ready when the cache endpoint is
            // still warming up.
            onMouseEnter={() => prefetchImage(hdImage)}
            onTouchStart={() => prefetchImage(hdImage)}
            className="group relative flex flex-col transition-all duration-200 hover:rotate-1 hover:shadow-glow"
          >
            <button
              type="button"
              onClick={() => onZoom(match, matchIndex)}
              aria-label={t('scanner.compareCandidate')}
              title={t('scanner.compareCandidate')}
              className="relative aspect-[2.5/3.5] w-full overflow-hidden rounded-xl text-left ring-1 ring-white/5 transition-all duration-200 group-hover:ring-2 group-hover:ring-brand-red/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
            >
              {match.image ? (
                // CardImage, not a bare <img>: a candidate URL failing to load
                // (not just being absent) needs the same "artwork unavailable,
                // retry" state every other card image gets — a broken image
                // with no explanation is a worse result than the "no image at
                // all" branch below, which at least offers a way out. Full
                // (non-compact) error state, not compactError: these tiles
                // are large enough that the icon-only compact mode used for
                // small thumbnails elsewhere reads as unexplained, same
                // complaint this is fixing in the first place.
                <CardImage src={match.image} alt={match.name}
                  className="h-full w-full object-cover shadow-lg transition-transform duration-300 group-hover:scale-[1.02]" />
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded-xl bg-bg-surface">
                  <span className="p-1 text-center text-[9px] text-text-muted">{match.name}</span>
                </div>
              )}
              {match.printed_total_mismatch && (
                <span
                  className="absolute left-1 top-1 rounded border border-amber-400 bg-amber-500/90 px-1 py-0.5 text-[8px] font-black leading-none text-black"
                  title={t('scanner.printedTotalMismatch')}
                  aria-label={t('scanner.printedTotalMismatch')}
                >
                  ⚠
                </span>
              )}
            </button>

            <div className="flex items-start gap-1 pt-1">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[10px] font-bold leading-tight text-white">{match.name}</p>
                {(match.set_abbreviation || match.number) && (
                  <p className="text-[9px] font-mono font-semibold text-brand-red/80">
                    {`${(match.set_abbreviation || '').toUpperCase()} ${match.number || ''}`.trim()}
                  </p>
                )}
                {match.rarity && <p className="truncate text-[9px] text-text-muted">{match.rarity}</p>}
              </div>
              {onSelect && (
                <button
                  type="button"
                  onClick={() => onSelect(match)}
                  title={t('scanner.addToCollection')}
                  aria-label={t('scanner.addToCollection')}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
                  style={{ background: '#e3000b', boxShadow: '0 0 12px rgba(227,0,11,0.5)' }}
                >
                  <Plus size={15} className="text-white" />
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── One queued photo in the review list ────────────────────────────────────
// `w-24` matches the layout used elsewhere in the batch list: the thumbnail
// and status sit in a row, with the (much wider) candidate grid below.
function PhotoThumb({ url, onZoom, t }) {
  return (
    <div className="w-24 flex-shrink-0 self-start space-y-1.5">
      <button type="button" onClick={onZoom} disabled={!url}
        title={t('scanner.expandCard')} aria-label={t('scanner.expandCard')}
        className="grid aspect-[2.5/3.5] w-full place-items-center overflow-hidden rounded-xl border border-white/10 bg-bg-primary/50 ring-1 ring-transparent transition-all hover:ring-brand-red/40 disabled:cursor-default">
        {url
          ? <img src={url} alt={t('scanner.yourPhoto')} className="h-full w-full object-contain" />
          : <Camera size={28} className="text-text-muted opacity-50" />}
      </button>
    </div>
  )
}

export function ScanItemPanel({ jobId, item, onAdd, onRetry, onDismiss, onReview, onModalChange, retryNow, t }) {
  const photoUrl = useScanItemPhoto(jobId, item)
  // Photo-only zoom stays local. Expanding a *candidate* starts a review,
  // which the page owns because accepting can walk on into the next photo
  // (see openNextReview in ScanQueue.jsx) — no single panel can see past its
  // own item.
  const [photoExpanded, setPhotoExpanded] = useState(false)
  // Only meaningful once resolved; an unreviewed item is always expanded.
  const [expanded, setExpanded] = useState(false)

  const active = ['pending', 'processing', 'retrying'].includes(item.status)
  const noMatches = item.status === 'done' && !item.matches?.length

  // A resolved item is finished business. Left expanded it takes as much
  // room as one still needing a decision, and worse: resolving drops the
  // stored photo, so what remains is a large empty frame beside an empty
  // grid. Collapsed to a line, the list stays a list of things still to do.
  //
  // The confirmed candidate is not persisted once resolved (only the photo
  // is dropped), so the label falls back to what recognition itself read
  // off the card — usually the same name, just without the guarantee that
  // it is the exact printing the reviewer picked among several candidates.
  if (item.resolved && !expanded) {
    const label = item.recognized?.name || item.recognized?.name_en
      || `${t('scanner.photoNumber')} ${item.position + 1}`
    const numberLabel = item.recognized?.number ? `Nr. ${item.recognized.number}` : ''
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={t('scanner.showDetails')}
        className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.06]"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-green/40 bg-green/20">
          <Check size={13} className="text-green" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm font-bold text-white">{label}</span>
          {numberLabel && <span className="font-mono text-[11px] text-brand-red/80">{numberLabel}</span>}
        </span>
        <ChevronDown size={15} className="flex-shrink-0 text-text-muted" />
      </button>
    )
  }

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      {photoExpanded && (
        <CardZoomModal card={null} photoUrl={photoUrl} onClose={() => {
          setPhotoExpanded(false)
          onModalChange?.(false)
        }} t={t} />
      )}
      <div className="flex gap-4">
        <PhotoThumb
          url={photoUrl}
          onZoom={() => {
            if (!photoUrl) return
            setPhotoExpanded(true)
            onModalChange?.(true)
          }}
          t={t}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-text-muted">
                {t('scanner.photoNumber')} {item.position + 1}
              </p>
              {item.recognized?.name && (
                <p className="truncate text-base font-bold text-white">{item.recognized.name}</p>
              )}
              {item.recognized?.number && (
                <p className="text-xs text-text-muted">Nr. {item.recognized.number}</p>
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              {item.resolved && (
                <button type="button" onClick={() => setExpanded(false)}
                  title={t('scanner.hideDetails')} aria-label={t('scanner.hideDetails')}
                  className="btn-ghost px-2 py-1 text-xs text-text-muted hover:text-white">
                  <ChevronUp size={14} />
                </button>
              )}
              {!active && !item.resolved && (
                <button type="button" onClick={() => onDismiss(item)}
                  className="btn-ghost border-brand-red/30 px-2 py-1 text-xs text-brand-red hover:bg-brand-red/10">
                  <Trash2 size={14} /> {t('scanner.dismissScan')}
                </button>
              )}
            </div>
          </div>

          {active && (
            <p className="mt-3 flex items-center gap-2 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" />
              {item.status === 'retrying'
                ? formatRetryCountdown(item.next_attempt_at, t, retryNow, item.retry_reason)
                : t('scanner.itemProcessing')}
            </p>
          )}

          {(item.status === 'failed' || noMatches) && (
            <div className="mt-3 space-y-3">
              <p role="alert" className={`rounded-xl border px-3 py-2 text-sm ${
                item.status === 'failed'
                  ? 'border-brand-red/20 bg-brand-red/10 text-brand-red'
                  : 'border-border bg-bg-card text-text-muted'
              }`}>
                {item.error || t(noMatches ? 'scanner.noMatches' : 'scanner.recognitionFailed')}
              </p>
              {!item.resolved && (
                <button type="button" onClick={() => onRetry(item)} disabled={!item.has_image}
                  className="btn-secondary justify-center">
                {/* Retrying always drops the item out of a composite grid onto
                    its own request — "individually" only describes something
                    actually changing when the item was composited to begin
                    with. An item that was already individual (the reviewer's
                    own choice, or the only option under a single-image-only
                    provider) just gets a plain retry. */}
                  <RefreshCw size={14} /> {item.batch_mode ? t('scanner.retryIndividually') : t('common.retry')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {item.status === 'done' && item.matches?.length > 0 && (
        <div className="mt-4">
          <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
            {t('scanner.bestMatches')} ({item.matches.length})
          </p>
          <CandidateGrid
            jobId={jobId}
            itemId={item.id}
            matches={item.matches}
            onSelect={item.resolved ? undefined : match => onAdd(item, match)}
            onZoom={(match, matchIndex) => onReview(item, matchIndex)}
            t={t}
          />
        </div>
      )}
    </article>
  )
}
