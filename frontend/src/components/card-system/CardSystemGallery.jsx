import { useState } from 'react'
import { Check } from 'lucide-react'
import CardDialog from './CardDialog'
import CardDisplay from './CardDisplay'
import CardLegend from './CardLegend'
import CardRow, { CardIdentity } from './CardRow'
import CardStack from './CardStack'

const CARD_BACK = '/cardback.jpg'
const BASE_CARD = {
  id: 'gallery-pikachu',
  name: 'Pikachu with a deliberately long card name',
  number: '057',
  set_ref: { abbreviation: 'SSP' },
  rarity: 'Illustration Rare',
  owned: true,
  owned_quantity: 2,
  owned_variants: [{ variant: 'Reverse Holo', quantity: 2 }],
}

const FALLBACK_CARD = {
  ...BASE_CARD,
  id: 'gallery-fallback',
  name: 'Fallback example',
  data_source_lang: 'fr',
  price_source_lang: 'de',
  image_source_lang: 'en',
}

const FALLBACK_COMBINATIONS = [
  ['No fallback', {}],
  ['Data', { data_source_lang: 'fr' }],
  ['Price', { price_source_lang: 'de' }],
  ['Image', { image_source_lang: 'en' }],
  ['Data + price', { data_source_lang: 'fr', price_source_lang: 'de' }],
  ['Data + image', { data_source_lang: 'fr', image_source_lang: 'en' }],
  ['Price + image', { price_source_lang: 'de', image_source_lang: 'en' }],
  ['Data + price + image', { data_source_lang: 'fr', price_source_lang: 'de', image_source_lang: 'en' }],
]

function GalleryExample({ label, children }) {
  return <div className="min-w-0 space-y-2">
    <p className="truncate text-xs font-bold text-text-secondary" title={label}>{label}</p>
    {children}
  </div>
}

const binderProgress = (complete) => (
  <span
    className={complete
      ? 'inline-flex items-center justify-center rounded-full border border-green/40 bg-green/90 p-1 text-white shadow-sm'
      : 'inline-flex items-center rounded-full border border-white/15 bg-bg-elevated px-1.5 py-0.5 text-[10px] font-bold leading-none text-text-secondary shadow-sm'}
  >
    {complete ? <Check size={10} strokeWidth={3} aria-hidden /> : '0/1'}
  </span>
)

export default function CardSystemGallery() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [compactRevision, setCompactRevision] = useState(0)
  const [lazyStressMounted, setLazyStressMounted] = useState(false)

  return (
    <main className="min-h-screen bg-bg-primary p-4 text-text-primary sm:p-8" data-testid="card-system-gallery">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="space-y-2">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-brand-red">Contributor preview</p>
          <h1 className="text-2xl font-black">PokéCollector card system</h1>
          <p className="max-w-3xl text-sm text-text-secondary">
            Approved variants and states. New visual ideas should extend this system and add a gallery example.
          </p>
        </header>

        <section className="space-y-3" data-testid="fallback-combinations">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Fallback-border combinations</h2>
            <p className="mt-1 text-xs text-text-secondary">Every supported data, price, and image fallback combination.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {FALLBACK_COMBINATIONS.map(([label, fallbacks], index) => (
              <GalleryExample key={label} label={label}>
                <CardDisplay
                  card={{ ...BASE_CARD, ...fallbacks, id: `gallery-fallback-${index}`, name: 'Pikachu' }}
                  image={CARD_BACK}
                  price="€12.34"
                  loading="eager"
                />
              </GalleryExample>
            ))}
          </div>
        </section>

        <section className="space-y-3" data-testid="state-combinations">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Ownership and contextual states</h2>
            <p className="mt-1 text-xs text-text-secondary">Ownership variants, wishlist, generic ownership, and binder requirement progress.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <GalleryExample label="Owned variants ×2">
              <CardDisplay card={BASE_CARD} image={CARD_BACK} price="€12.34" loading="eager" />
            </GalleryExample>
            <GalleryExample label="Multiple owned variants">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-multiple', owned_quantity: 4, owned_variants: [{ variant: 'Normal', quantity: 1 }, { variant: 'Holo', quantity: 3 }] }} image={CARD_BACK} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Owned, variant unknown">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-generic-owned', owned_variants: [] }} image={CARD_BACK} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Wishlisted">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-wishlisted', wishlisted: true }} image={CARD_BACK} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Binder requirement 0/1">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-binder-missing' }} image={CARD_BACK} showStateIndicators={false} captionAccessory={binderProgress(false)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Binder requirement complete">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-binder-complete' }} image={CARD_BACK} showStateIndicators={false} captionAccessory={binderProgress(true)} loading="eager" />
            </GalleryExample>
          </div>
        </section>

        <section className="space-y-3" data-testid="interaction-combinations">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Interaction and availability states</h2>
            <p className="mt-1 text-xs text-text-secondary">Selectable, selected, missing, unavailable, and failed-image behavior.</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            <GalleryExample label="Selectable">
              <CardDisplay variant="selectable" card={{ ...BASE_CARD, id: 'gallery-selectable' }} image={CARD_BACK} onSelect={() => {}} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Selectable, selected">
              <CardDisplay variant="selectable" card={{ ...BASE_CARD, id: 'gallery-selected' }} image={CARD_BACK} selected onSelect={() => {}} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Unowned / missing">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-missing', owned: false, owned_quantity: 0, owned_variants: [] }} image={CARD_BACK} dimWhenUnowned loading="eager" />
            </GalleryExample>
            <GalleryExample label="Unavailable">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-unavailable' }} image={CARD_BACK} unavailableReason="Already used" loading="eager" />
            </GalleryExample>
            <GalleryExample label="Image error with retry">
              <CardDisplay card={{ ...BASE_CARD, id: 'gallery-error', name: 'Failed artwork' }} image="/__card-system-missing-image.jpg" loading="eager" />
            </GalleryExample>
          </div>
        </section>

        <section className="space-y-3" data-testid="display-variants">
          <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Supported display variants</h2>
          <div key={compactRevision} className="grid gap-3 lg:grid-cols-2" data-testid="compact-card-variants">
            <CardRow
              card={BASE_CARD}
              image={CARD_BACK}
              name={BASE_CARD.name}
              setNumber="SSP 057"
              badges={[{ label: 'Reverse Holo ×2', variant: 'purple' }]}
              value="€24.68"
            />
            <div className="rounded-xl border border-border bg-bg-card p-3">
              <CardIdentity card={BASE_CARD} image={CARD_BACK} name={BASE_CARD.name} setNumber="SSP 057" subtext="Illustration Rare" />
            </div>
          </div>
          <button
            type="button"
            className="sr-only"
            data-testid="remount-compact-cards"
            onClick={() => setCompactRevision(value => value + 1)}
          >
            Remount compact cards
          </button>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <GalleryExample label="Carousel"><div className="w-32"><CardDisplay variant="carousel" card={BASE_CARD} image={CARD_BACK} loading="eager" /></div></GalleryExample>
            <GalleryExample label="Ranking"><div className="w-32"><CardDisplay variant="ranking" card={BASE_CARD} image={CARD_BACK} loading="eager" /></div></GalleryExample>
            <GalleryExample label="Artwork"><div className="w-28"><CardDisplay variant="artwork" card={BASE_CARD} image={CARD_BACK} alt={BASE_CARD.name} loading="eager" /></div></GalleryExample>
            <GalleryExample label="Stack"><div className="w-28"><CardStack card={BASE_CARD} image={CARD_BACK} layers={2} alt={BASE_CARD.name} loading="eager" /></div></GalleryExample>
          </div>
          <div className="flex items-end gap-5">
            <CardDisplay variant="compact-artwork" card={BASE_CARD} image={CARD_BACK} alt={BASE_CARD.name} loading="eager" />
            <div className="w-12"><CardDisplay variant="comparison" card={BASE_CARD} image={CARD_BACK} alt={BASE_CARD.name} loading="eager" /></div>
          </div>
        </section>

        <section className="space-y-3" data-testid="legend-variant">
          <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Shared legend</h2>
          <div className="rounded-xl border border-border bg-bg-card p-3">
            <CardLegend collapsible={false} showSelection showBinderProgress showProductSource />
          </div>
        </section>

        <button type="button" className="btn-primary" onClick={() => setDialogOpen(true)} data-testid="open-card-dialog">
          Open shared card dialog
        </button>
        <button
          type="button"
          className="sr-only"
          data-testid="mount-lazy-card-stress"
          onClick={() => setLazyStressMounted(true)}
        >
          Mount lazy card stress list
        </button>

        {lazyStressMounted && (
          <>
            <section className="space-y-2" data-testid="lazy-card-stress">
              {Array.from({ length: 80 }, (_, index) => (
                <div key={index} className="rounded-xl border border-border bg-bg-card p-2">
                  <CardIdentity
                    card={{ ...BASE_CARD, id: `lazy-card-${index}` }}
                    image={`/api/images/card/lazy-card-${index}/small`}
                    name={`Lazy compact card ${index + 1}`}
                    setNumber={`TST ${String(index + 1).padStart(3, '0')}`}
                  />
                </div>
              ))}
            </section>
            <section className="hidden" data-testid="lazy-card-stress-hidden" aria-hidden>
              {Array.from({ length: 80 }, (_, index) => (
                <CardIdentity
                  key={index}
                  card={{ ...BASE_CARD, id: `lazy-hidden-card-${index}` }}
                  image={`/api/images/card/lazy-hidden-card-${index}/small`}
                  name={`Hidden responsive card ${index + 1}`}
                />
              ))}
            </section>
          </>
        )}
      </div>

      {dialogOpen && (
        <CardDialog
          card={FALLBACK_CARD}
          image={CARD_BACK}
          tabs={[{ id: 'overview', label: 'Overview' }, { id: 'prices', label: 'Prices' }]}
          activeTab="overview"
          onClose={() => setDialogOpen(false)}
        >
          <div className="rounded-xl border border-border bg-bg-card p-4 text-sm text-text-secondary">
            Shared dialog content slot
          </div>
        </CardDialog>
      )}
    </main>
  )
}
