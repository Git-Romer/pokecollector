/**
 * CollectionCardImage — a collection item's catalogue artwork or private photo.
 *
 * A catalogue scan is a reference image of the printing; the owner's photo is
 * evidence of the actual physical card they have — condition, centering,
 * whatever makes their copy theirs. It is a fallback by default; the user can
 * choose to prefer private photos everywhere from Settings.
 *
 * The photo is always badged. A phone photo and a catalogue scan are not the
 * same kind of thing, and a collection is much less useful if you cannot tell
 * at a glance which you are looking at.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Camera } from 'lucide-react'
import CardImage from './CardImage'
import { CardDisplay, CardIdentity, CardRow } from './card-system'
import { fetchCollectionItemPhoto } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { hasCatalogueImage, resolveCardImageUrl } from '../utils/imageUrl'

const hasReferenceImage = (card) => Boolean(card?.custom_image_url) || hasCatalogueImage(card)

// Personal photos are a fallback by default. A per-user preference can make
// them primary, but never for manually created cards: those already have their
// own editable artwork and keep the pencil marker as their sole source badge.
export const showsOwnPhoto = (item, card, preferOwnPhotos = false) => Boolean(
  item?.has_scan_photo
  && !card?.is_custom
  && (preferOwnPhotos || !hasReferenceImage(card))
)

function useNearViewport(enabled, eager = false) {
  const [target, setTarget] = useState(null)
  const [visible, setVisible] = useState(eager)

  useEffect(() => {
    if (!enabled || visible) return undefined
    if (!target || typeof IntersectionObserver === 'undefined') {
      if (target) setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '300px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [enabled, eager, target, visible])

  return { viewportRef: setTarget, visible: eager || visible }
}

function useCollectionPhotoResource(item, { enabled = true, eager = false } = {}) {
  const { user } = useAuth()
  const shouldFetch = enabled && Boolean(item?.has_scan_photo) && Boolean(item?.id)
  const { viewportRef, visible } = useNearViewport(shouldFetch, eager)
  const photoKey = item?.card_id || item?.card?.id || item?.id

/**
 * Object URL for this item's own photo, or null when it has none. Safe to
 * call for any item — it fetches nothing when there is no photo to fetch.
 */

  // The Blob is cached, not the object URL: object URLs belong to the component
  // instance that created them and are revoked on unmount, so caching one would
  // hand later renders a URL that has already been released. The same photo can
  // appear in the grid, the list and the detail modal at once.
  const { data: blob } = useQuery({
    queryKey: ['collection-photo', user?.id ?? 'single-user', photoKey],
    queryFn: () => fetchCollectionItemPhoto(item.id),
    enabled: shouldFetch && visible,
    staleTime: Infinity,
    retry: false,
  })

  const [photoUrl, setPhotoUrl] = useState(null)
  useEffect(() => {
    if (!blob) {
      setPhotoUrl(null)
      return
    }
    const url = URL.createObjectURL(blob)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [blob])

  return { photoUrl, viewportRef }
}

export function useCollectionPhotoUrl(item, options = {}) {
  return useCollectionPhotoResource(item, { ...options, eager: options.eager ?? true }).photoUrl
}

/**
 * The overlay badge shape used wherever a tile is large enough to carry one —
 * matches the established corner-badge convention (see ProductSourceBadge in
 * Collection.jsx, and the variant/condition pill in BinderDetail.jsx): -2
 * corner spacing, z-20, rounded-full, theme-aware translucent background with
 * a blur, not flat black.
 */
export function OwnPhotoOverlayBadge({ t, className = 'h-6 w-6' }) {
  return (
    <span
      title={t('collection.ownPhoto')}
      className={clsx(
        'absolute bottom-2 right-2 z-20 inline-flex items-center justify-center rounded-full border border-white/30 bg-bg/85 text-white shadow-lg backdrop-blur-sm',
        className,
      )}
    >
      <Camera size={12} />
    </span>
  )
}

export default function CollectionCardImage({
  item,
  alt,
  className,
  size = 'small',
  showName = false,
}) {
  const { t, settings } = useSettings()
  const card = item?.card
  const ownPhoto = showsOwnPhoto(item, card, settings.prefer_own_card_photos === 'true')
  const { photoUrl, viewportRef } = useCollectionPhotoResource(item, { enabled: ownPhoto })

  if (!ownPhoto) {
    return <CardImage src={resolveCardImageUrl(card, size)} alt={alt} className={className} showName={showName} />
  }

  // While the blob is in flight CardImage shows the card back, which is exactly
  // what this item looked like before — so there is no flash of empty space.
  return (
    <div ref={viewportRef} className="relative w-full h-full">
      <CardImage src={photoUrl} alt={alt} className={className} showName={showName} />
      {photoUrl && <OwnPhotoOverlayBadge t={t} />}
    </div>
  )
}

/**
 * Own-photo image resolution, shared by every own-photo-aware card-system
 * wrapper below. Takes `item` (for the own-photo lookup) and the `card` to
 * fall back to, plus any explicit `image` override. Callers decide how to
 * present `isOwnPhoto` — an overlay badge on a full-size tile, a pill in a
 * compact row's badge list, etc. — rather than this hook picking one shape
 * for every context.
 */
function useOwnPhotoDisplay(item, card, image, size) {
  const { settings } = useSettings()
  const ownPhoto = showsOwnPhoto(item, card, settings.prefer_own_card_photos === 'true')
  const { photoUrl, viewportRef } = useCollectionPhotoResource(item, { enabled: ownPhoto })
  const catalogueSrc = image ?? resolveCardImageUrl(card, size)
  const resolvedImage = ownPhoto ? (photoUrl || catalogueSrc) : catalogueSrc
  return { resolvedImage, isOwnPhoto: ownPhoto && Boolean(photoUrl), viewportRef }
}

/**
 * Same own-photo priority as CollectionCardImage, rendered through the shared
 * card-system (CardDisplay) instead of a bare CardImage — for grid/carousel
 * tiles that also want state indicators, fallback-badge borders, etc.
 *
 * A dedicated component rather than something inlined in the caller's
 * `.map()`: the own-photo fetch is a hook (useCollectionPhotoUrl), and hooks
 * cannot run inside a loop callback — each card needs its own component
 * instance to own that call.
 *
 * `item` is the collection item — used for the own-photo lookup (`item.id`,
 * `item.has_scan_photo`). The full card handed to CardDisplay defaults to
 * `item.card` (the normal `/api/collection` shape), but a few endpoints
 * (dashboard summaries) flatten the card fields onto the item itself instead
 * of nesting them, so `card` can be passed explicitly to override that.
 */
export function CollectionCardDisplay({ item, card = item?.card ?? item, image, overlay, size = 'small', ...displayProps }) {
  const { t } = useSettings()
  const { resolvedImage, isOwnPhoto, viewportRef } = useOwnPhotoDisplay(item, card, image, size)

  return (
    <CardDisplay
      card={card}
      image={resolvedImage}
      viewportRef={viewportRef}
      {...displayProps}
      overlay={(
        <>
          {overlay}
          {isOwnPhoto && <OwnPhotoOverlayBadge t={t} />}
        </>
      )}
    />
  )
}

/**
 * CollectionCardDisplay's counterpart for the compact list/table identity —
 * see it for the shape of `item`/`card`. The thumbnail here is small enough
 * that an overlay badge would sit on top of the whole image, so the own-photo
 * marker rides as a badge pill in `details` instead.
 */
export function CollectionCardIdentity({ item, card = item?.card ?? item, image, size = 'small', ...identityProps }) {
  const { resolvedImage, isOwnPhoto, viewportRef } = useOwnPhotoDisplay(item, card, image, size)
  return <CardIdentity card={card} image={resolvedImage} ownPhoto={isOwnPhoto} viewportRef={viewportRef} {...identityProps} />
}

/** CollectionCardDisplay's counterpart for the full row layout — see it for the shape of `item`/`card`. */
export function CollectionCardRow({ item, card = item?.card ?? item, image, size = 'small', badges = [], ...rowProps }) {
  const { resolvedImage, isOwnPhoto, viewportRef } = useOwnPhotoDisplay(item, card, image, size)
  return (
    <CardRow
      card={card}
      image={resolvedImage}
      viewportRef={viewportRef}
      badges={isOwnPhoto ? [...badges, { label: '📷', variant: 'gray' }] : badges}
      {...rowProps}
    />
  )
}
