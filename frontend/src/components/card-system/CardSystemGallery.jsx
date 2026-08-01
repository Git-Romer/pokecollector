import { useState } from 'react'
import { Check } from 'lucide-react'
import CardDialog from './CardDialog'
import CardDisplay from './CardDisplay'
import CardLegend from './CardLegend'
import CardRow, { CardIdentity } from './CardRow'
import CardStack from './CardStack'

const card = ({ id, name, number, set, rarity, price, normal = false, holo = false, reverse = false, firstEdition = false }) => ({
  id,
  name,
  number,
  localId: number,
  set_ref: { id: set.id, abbreviation: set.abbreviation, name: set.name },
  rarity,
  price_market: price,
  images_small: `/api/images/card/${id}/small`,
  images_large: `/api/images/card/${id}/large`,
  variants_normal: normal,
  variants_holo: holo,
  variants_reverse: reverse,
  variants_first_edition: firstEdition,
  owned: false,
  owned_quantity: 0,
  owned_variants: [],
})

const CRI = { id: 'me04_en', abbreviation: 'CRI', name: 'Chaos Rising' }
const POR = { id: 'me03_en', abbreviation: 'POR', name: 'Perfect Order' }
const BASE = { id: 'base1_en', abbreviation: 'BS', name: 'Base Set' }

const CARDS = {
  cinccino: card({ id: 'me04-119_en', name: 'Cinccino ex', number: '119', set: CRI, rarity: 'Special illustration rare', price: 50.24, holo: true }),
  tranquility: card({ id: 'me04-120_en', name: "AZ's Tranquility", number: '120', set: CRI, rarity: 'Special illustration rare', price: 24.94, holo: true }),
  ampharos: card({ id: 'me04-090_en', name: 'Ampharos', number: '090', set: CRI, rarity: 'Illustration rare', price: 10.71, holo: true }),
  chespin: card({ id: 'me04-087_en', name: 'Chespin', number: '087', set: CRI, rarity: 'Illustration rare', price: 5.40, holo: true }),
  crobat: card({ id: 'me04-093_en', name: 'Crobat', number: '093', set: CRI, rarity: 'Illustration rare', price: 4.34, holo: true }),
  beedrill: card({ id: 'me04-098_en', name: 'Beedrill ex', number: '098', set: CRI, rarity: 'Ultra Rare', price: 3.82, holo: true }),
  emma: card({ id: 'me04-107_en', name: 'Emma', number: '107', set: CRI, rarity: 'Ultra Rare', price: 3.16, holo: true }),
  greninja: card({ id: 'me04-022_en', name: 'Mega Greninja ex', number: '022', set: CRI, rarity: 'Double rare', price: 1.67, holo: true }),
  delphox: card({ id: 'me04-013_en', name: 'Delphox', number: '013', set: CRI, rarity: 'Rare', price: 1.45, normal: true, holo: true }),
  weedle: card({ id: 'me04-001_en', name: 'Weedle', number: '001', set: CRI, rarity: 'Common', price: 0.04, normal: true }),
  aegislash: card({ id: 'me03-058_en', name: 'Aegislash', number: '058', set: POR, rarity: 'Uncommon', price: 0.03, normal: true, reverse: true }),
  charizard: card({ id: 'base1-4_en', name: 'Charizard', number: '4', set: BASE, rarity: 'Rare', price: 446.70, holo: true, firstEdition: true }),
}

const imageFor = (entry) => entry.images_large
const priceFor = (entry) => new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(entry.price_market)
const ownedAs = (entry, ownedVariants) => ({
  ...entry,
  owned: true,
  owned_quantity: ownedVariants.reduce((sum, item) => sum + item.quantity, 0),
  owned_variants: ownedVariants,
})

const FALLBACK_CARD = {
  ...CARDS.cinccino,
  data_source_lang: 'fr',
  price_source_lang: 'de',
  image_source_lang: 'en',
}

const FALLBACK_COMBINATIONS = [
  ['No fallback', CARDS.cinccino, {}],
  ['Data', CARDS.tranquility, { data_source_lang: 'fr' }],
  ['Price', CARDS.ampharos, { price_source_lang: 'de' }],
  ['Image', CARDS.chespin, { image_source_lang: 'en' }],
  ['Data + price', CARDS.crobat, { data_source_lang: 'fr', price_source_lang: 'de' }],
  ['Data + image', CARDS.beedrill, { data_source_lang: 'fr', image_source_lang: 'en' }],
  ['Price + image', CARDS.emma, { price_source_lang: 'de', image_source_lang: 'en' }],
  ['All three', CARDS.greninja, { data_source_lang: 'fr', price_source_lang: 'de', image_source_lang: 'en' }],
]

function GalleryExample({ label, children }) {
  return <div className="min-w-0 space-y-2 rounded-2xl border border-white/5 bg-black/20 p-2.5 shadow-[0_14px_35px_rgba(0,0,0,0.2)] sm:p-3">
    <p className="truncate text-[10px] font-black uppercase tracking-[0.12em] text-text-secondary" title={label}>{label}</p>
    {children}
  </div>
}

function GalleryHeading({ eyebrow, title, description }) {
  return <div className="space-y-1">
    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-red">{eyebrow}</p>
    <h2 className="text-lg font-black text-text-primary sm:text-xl">{title}</h2>
    <p className="max-w-3xl text-xs leading-relaxed text-text-secondary sm:text-sm">{description}</p>
  </div>
}

const sectionClassName = 'space-y-5 rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(227,0,11,0.10),transparent_35%),linear-gradient(145deg,rgba(22,23,36,0.98),rgba(8,9,15,0.98))] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.35)] sm:p-6'

const binderProgress = (value, complete = false) => (
  <span
    className={complete
      ? 'inline-flex items-center justify-center rounded-full border border-green/40 bg-green/90 p-1 text-white shadow-sm'
      : 'inline-flex items-center rounded-full border border-white/15 bg-bg-elevated px-1.5 py-0.5 text-[10px] font-bold leading-none text-text-secondary shadow-sm'}
  >
    {complete ? <Check size={10} strokeWidth={3} aria-hidden /> : value}
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

        <section className={sectionClassName} data-testid="fallback-combinations">
          <GalleryHeading
            eyebrow="Fallback language intelligence"
            title="One visual system, every fallback combination"
            description="Eight supported combinations using real cards from 2026's Chaos Rising set. Border color communicates the fallback source without adding noise to the card title."
          />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            {FALLBACK_COMBINATIONS.map(([label, entry, fallbacks], index) => (
              <GalleryExample key={label} label={label}>
                <CardDisplay
                  card={{ ...entry, ...fallbacks, id: `${entry.id}-fallback-${index}` }}
                  image={imageFor(entry)}
                  price={priceFor(entry)}
                  loading="eager"
                />
              </GalleryExample>
            ))}
          </div>
        </section>

        <section className={sectionClassName} data-testid="state-combinations">
          <GalleryHeading
            eyebrow="Collection awareness"
            title="Every card state, instantly recognizable"
            description="Genuine Normal, Holo, Reverse Holo, and legacy First Edition printings alongside wishlist and binder requirement states."
          />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5 lg:gap-4">
            <GalleryExample label="Owned · Normal ×2">
              <CardDisplay card={ownedAs(CARDS.weedle, [{ variant: 'Normal', quantity: 2 }])} image={imageFor(CARDS.weedle)} price={priceFor(CARDS.weedle)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Owned · Holo ×2">
              <CardDisplay card={ownedAs(CARDS.cinccino, [{ variant: 'Holo', quantity: 2 }])} image={imageFor(CARDS.cinccino)} price={priceFor(CARDS.cinccino)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Owned · Reverse ×2">
              <CardDisplay card={ownedAs(CARDS.aegislash, [{ variant: 'Reverse Holo', quantity: 2 }])} image={imageFor(CARDS.aegislash)} price={priceFor(CARDS.aegislash)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="First Edition · legacy">
              <CardDisplay card={ownedAs(CARDS.charizard, [{ variant: 'First Edition', quantity: 1 }])} image={imageFor(CARDS.charizard)} price={priceFor(CARDS.charizard)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Multiple variants">
              <CardDisplay card={ownedAs(CARDS.delphox, [{ variant: 'Normal', quantity: 1 }, { variant: 'Holo', quantity: 3 }])} image={imageFor(CARDS.delphox)} price={priceFor(CARDS.delphox)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Owned · single Holo">
              <CardDisplay card={ownedAs(CARDS.chespin, [{ variant: 'Holo', quantity: 1 }])} image={imageFor(CARDS.chespin)} price={priceFor(CARDS.chespin)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Wishlist">
              <CardDisplay card={{ ...CARDS.tranquility, wishlisted: true }} image={imageFor(CARDS.tranquility)} price={priceFor(CARDS.tranquility)} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Binder · 0/1">
              <CardDisplay card={CARDS.crobat} image={imageFor(CARDS.crobat)} price={priceFor(CARDS.crobat)} showStateIndicators={false} captionAccessory={binderProgress('0/1')} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Binder · 2/4">
              <CardDisplay card={CARDS.greninja} image={imageFor(CARDS.greninja)} price={priceFor(CARDS.greninja)} showStateIndicators={false} captionAccessory={binderProgress('2/4')} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Binder · complete">
              <CardDisplay card={CARDS.beedrill} image={imageFor(CARDS.beedrill)} price={priceFor(CARDS.beedrill)} showStateIndicators={false} captionAccessory={binderProgress(null, true)} loading="eager" />
            </GalleryExample>
          </div>
        </section>

        <section className={sectionClassName} data-testid="interaction-combinations">
          <GalleryHeading
            eyebrow="Purposeful feedback"
            title="Clear interaction states without visual drift"
            description="Selection, availability, missing-card, and image-recovery behavior share the same card anatomy on every screen size."
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            <GalleryExample label="Selectable">
              <CardDisplay variant="selectable" card={CARDS.cinccino} image={imageFor(CARDS.cinccino)} onSelect={() => {}} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Selectable, selected">
              <CardDisplay variant="selectable" card={CARDS.tranquility} image={imageFor(CARDS.tranquility)} selected onSelect={() => {}} loading="eager" />
            </GalleryExample>
            <GalleryExample label="Unowned / missing">
              <CardDisplay card={CARDS.ampharos} image={imageFor(CARDS.ampharos)} dimWhenUnowned loading="eager" />
            </GalleryExample>
            <GalleryExample label="Unavailable">
              <CardDisplay card={CARDS.chespin} image={imageFor(CARDS.chespin)} unavailableReason="Already used" loading="eager" />
            </GalleryExample>
            <GalleryExample label="Image error with retry">
              <CardDisplay card={CARDS.emma} image="/__card-system-missing-image.jpg" loading="eager" />
            </GalleryExample>
          </div>
        </section>

        <section className={sectionClassName} data-testid="display-variants">
          <GalleryHeading
            eyebrow="Built to travel"
            title="One card identity, every product surface"
            description="Rich grids, compact rows, rankings, carousels, comparisons, and stacks all preserve the same visual language."
          />
          <div key={compactRevision} className="grid gap-3 lg:grid-cols-2" data-testid="compact-card-variants">
            <CardRow
              card={ownedAs(CARDS.cinccino, [{ variant: 'Holo', quantity: 2 }])}
              image={imageFor(CARDS.cinccino)}
              name={CARDS.cinccino.name}
              setNumber="CRI 119"
              badges={[{ label: 'Holo ×2', variant: 'purple' }]}
              value={priceFor(CARDS.cinccino)}
            />
            <div className="rounded-xl border border-border bg-bg-card p-3">
              <CardIdentity card={CARDS.tranquility} image={imageFor(CARDS.tranquility)} name={CARDS.tranquility.name} setNumber="CRI 120" subtext={CARDS.tranquility.rarity} />
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
            <GalleryExample label="Carousel"><div className="w-32"><CardDisplay variant="carousel" card={CARDS.greninja} image={imageFor(CARDS.greninja)} loading="eager" /></div></GalleryExample>
            <GalleryExample label="Ranking"><div className="w-32"><CardDisplay variant="ranking" card={CARDS.ampharos} image={imageFor(CARDS.ampharos)} loading="eager" /></div></GalleryExample>
            <GalleryExample label="Artwork"><div className="w-28"><CardDisplay variant="artwork" card={CARDS.emma} image={imageFor(CARDS.emma)} alt={CARDS.emma.name} loading="eager" /></div></GalleryExample>
            <GalleryExample label="Stack"><div className="w-28"><CardStack card={CARDS.crobat} image={imageFor(CARDS.crobat)} layers={2} alt={CARDS.crobat.name} loading="eager" /></div></GalleryExample>
          </div>
          <div className="flex items-end gap-5">
            <CardDisplay variant="compact-artwork" card={CARDS.beedrill} image={imageFor(CARDS.beedrill)} alt={CARDS.beedrill.name} loading="eager" />
            <div className="w-12"><CardDisplay variant="comparison" card={CARDS.chespin} image={imageFor(CARDS.chespin)} alt={CARDS.chespin.name} loading="eager" /></div>
          </div>
        </section>

        <section className={sectionClassName} data-testid="legend-variant">
          <GalleryHeading
            eyebrow="Learn once"
            title="A shared legend for the whole collection"
            description="Every badge, border, and contextual state is explained in one consistent vocabulary."
          />
          <div className="rounded-2xl border border-border bg-bg-card/90 p-4 shadow-inner sm:p-5">
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
                    card={{ ...CARDS.cinccino, id: `lazy-card-${index}` }}
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
                  card={{ ...CARDS.cinccino, id: `lazy-hidden-card-${index}` }}
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
          image={imageFor(FALLBACK_CARD)}
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
