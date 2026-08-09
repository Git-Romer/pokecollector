/**
 * CollectionCardImage — a collection item's picture, preferring the owner's own
 * photo when TCGdex has no scan of the card.
 *
 * About one card in fourteen has no catalogue image — trainer kits, Japanese
 * printings, the newest energy subsets — and the collection shows an anonymous
 * card back for every one of them. The scanner already photographed the physical
 * card, so where that photo was kept it is shown here instead.
 *
 * The photo is always badged. A phone photo and a catalogue scan are not the
 * same kind of thing: one is evidence of what the owner actually has, the other
 * is a reference image, and a collection is much less useful if you cannot tell
 * at a glance which you are looking at.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Camera } from 'lucide-react'
import CardImage from './CardImage'
import { CardDisplay, CardIdentity, CardRow } from './card-system'
import { fetchCollectionItemPhoto } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { hasCatalogueImage, resolveCardImageUrl } from '../utils/imageUrl'

// Should this item show the owner's photo rather than the catalogue?
// A catalogue scan wins whenever one exists: it is flat, square, evenly lit and
// consistent with every other card on the page. The photo is the fallback for
// cards that would otherwise have no picture at all — which also means a card
// gaining a TCGdex scan later silently upgrades, with the photo left in place.
export const showsOwnPhoto = (item) =>
  Boolean(item?.has_scan_photo) && !hasCatalogueImage(item?.card)

/**
 * Object URL for this item's own photo, or null when it has none (or has a
 * catalogue scan, which is preferred). Safe to call for any item — it fetches
 * nothing when there is no photo to fetch.
 */
export function useCollectionPhotoUrl(item) {
  const ownPhoto = showsOwnPhoto(item)

  // The Blob is cached, not the object URL: object URLs belong to the component
  // instance that created them and are revoked on unmount, so caching one would
  // hand later renders a URL that has already been released. The same photo can
  // appear in the grid, the list and the detail modal at once.
  const { data: blob } = useQuery({
    queryKey: ['collection-photo', item?.id],
    queryFn: () => fetchCollectionItemPhoto(item.id),
    enabled: ownPhoto && Boolean(item?.id),
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

  return photoUrl
}

export default function CollectionCardImage({
  item,
  alt,
  className,
  size = 'small',
  badgeSize = 12,
  showName = false,
}) {
  const { t } = useSettings()
  const card = item?.card
  const ownPhoto = showsOwnPhoto(item)
  const photoUrl = useCollectionPhotoUrl(item)

  if (!ownPhoto) {
    return <CardImage src={resolveCardImageUrl(card, size)} alt={alt} className={className} showName={showName} />
  }

  // While the blob is in flight CardImage shows the card back, which is exactly
  // what this item looked like before — so there is no flash of empty space.
  return (
    <div className="relative w-full h-full">
      <CardImage src={photoUrl} alt={alt} className={className} showName={showName} />
      {photoUrl && (
        <span
          className="absolute bottom-1 right-1 z-10 inline-flex items-center justify-center rounded-md bg-black/70 text-white/90 border border-white/20 p-1 pointer-events-none"
          title={t('collection.ownPhoto')}
        >
          <Camera size={badgeSize} />
        </span>
      )}
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
  const ownPhoto = showsOwnPhoto(item)
  const photoUrl = useCollectionPhotoUrl(item)
  const catalogueSrc = image ?? resolveCardImageUrl(card, size)
  const resolvedImage = ownPhoto ? (photoUrl || catalogueSrc) : catalogueSrc
  return { resolvedImage, isOwnPhoto: ownPhoto && Boolean(photoUrl) }
}

/** The overlay badge shape used wherever a tile is large enough to carry one. */
function OwnPhotoOverlayBadge({ size = 12, t }) {
  return (
    <span
      className="absolute bottom-1 right-1 z-10 inline-flex items-center justify-center rounded-md bg-black/70 text-white/90 border border-white/20 p-1 pointer-events-none"
      title={t('collection.ownPhoto')}
    >
      <Camera size={size} />
    </span>
  )
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
export function CollectionCardDisplay({ item, card = item?.card ?? item, badgeSize = 12, image, overlay, size = 'small', ...displayProps }) {
  const { t } = useSettings()
  const { resolvedImage, isOwnPhoto } = useOwnPhotoDisplay(item, card, image, size)

  return (
    <CardDisplay
      card={card}
      image={resolvedImage}
      {...displayProps}
      overlay={(
        <>
          {overlay}
          {isOwnPhoto && <OwnPhotoOverlayBadge size={badgeSize} t={t} />}
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
  const { resolvedImage, isOwnPhoto } = useOwnPhotoDisplay(item, card, image, size)
  return <CardIdentity card={card} image={resolvedImage} ownPhoto={isOwnPhoto} {...identityProps} />
}

/** CollectionCardDisplay's counterpart for the full row layout — see it for the shape of `item`/`card`. */
export function CollectionCardRow({ item, card = item?.card ?? item, image, size = 'small', badges = [], ...rowProps }) {
  const { resolvedImage, isOwnPhoto } = useOwnPhotoDisplay(item, card, image, size)
  return (
    <CardRow
      card={card}
      image={resolvedImage}
      badges={isOwnPhoto ? [...badges, { label: '📷', variant: 'gray' }] : badges}
      {...rowProps}
    />
  )
}
