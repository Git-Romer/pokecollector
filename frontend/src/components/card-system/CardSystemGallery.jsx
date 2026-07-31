import { useState } from 'react'
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
  name: 'Fallback artwork example',
  data_source_lang: 'en',
  price_source_lang: 'en',
  image_source_lang: 'en',
}

export default function CardSystemGallery() {
  const [dialogOpen, setDialogOpen] = useState(false)

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

        <section className="space-y-3" data-testid="full-card-variants">
          <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Full card variants</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
            <CardDisplay card={BASE_CARD} image={CARD_BACK} price="€12.34" languageLabel="EN" loading="eager" />
            <CardDisplay variant="selectable" card={BASE_CARD} image={CARD_BACK} selected onSelect={() => {}} loading="eager" />
            <CardDisplay card={{ ...BASE_CARD, id: 'gallery-missing', owned: false, owned_quantity: 0, owned_variants: [] }} image={CARD_BACK} dimWhenUnowned loading="eager" />
            <CardDisplay card={FALLBACK_CARD} image={CARD_BACK} price="€9.99" loading="eager" />
            <CardDisplay card={{ ...BASE_CARD, id: 'gallery-unavailable' }} image={CARD_BACK} unavailableReason="Already used" loading="eager" />
            <CardDisplay card={{ ...BASE_CARD, id: 'gallery-error', name: 'Failed artwork with retry' }} image="/__card-system-missing-image.jpg" loading="eager" />
          </div>
        </section>

        <section className="space-y-3" data-testid="compact-card-variants">
          <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Compact and table variants</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <CardRow
              card={BASE_CARD}
              image={CARD_BACK}
              name={BASE_CARD.name}
              setNumber="SSP 057"
              languageLabel="EN"
              badges={[{ label: 'Reverse Holo ×2', variant: 'purple' }]}
              value="€24.68"
              loading="eager"
            />
            <div className="rounded-xl border border-border bg-bg-card p-3">
              <CardIdentity card={BASE_CARD} image={CARD_BACK} name={BASE_CARD.name} setNumber="SSP 057" subtext="Illustration Rare" loading="eager" />
            </div>
          </div>
        </section>

        <section className="space-y-3" data-testid="context-card-variants">
          <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Carousel and ranking variants</h2>
          <div className="flex gap-5">
            <div className="w-32"><CardDisplay variant="carousel" card={BASE_CARD} image={CARD_BACK} loading="eager" /></div>
            <div className="w-32"><CardDisplay variant="ranking" card={BASE_CARD} image={CARD_BACK} loading="eager" /></div>
          </div>
        </section>

        <section className="space-y-3" data-testid="artwork-variants">
          <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted">Artwork-only variants</h2>
          <div className="flex items-end gap-5">
            <div className="w-28"><CardDisplay variant="artwork" card={BASE_CARD} image={CARD_BACK} alt={BASE_CARD.name} loading="eager" /></div>
            <CardDisplay variant="compact-artwork" card={BASE_CARD} image={CARD_BACK} alt={BASE_CARD.name} loading="eager" />
            <div className="w-12"><CardDisplay variant="comparison" card={BASE_CARD} image={CARD_BACK} alt={BASE_CARD.name} loading="eager" /></div>
            <div className="w-28"><CardStack card={BASE_CARD} image={CARD_BACK} layers={2} alt={BASE_CARD.name} loading="eager" /></div>
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
      </div>

      {dialogOpen && (
        <CardDialog
          card={BASE_CARD}
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
