import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, SortAsc } from 'lucide-react'
import { getPokedexSpecies, searchCards } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import PokeBallLoader from '../components/PokeBallLoader'
import CardItem from '../components/CardItem'
import { useVisibleTcgdexLanguages } from '../hooks/useVisibleTcgdexLanguages'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { getEffectiveCardPrice } from '../utils/prices'
import { useDetailBackNavigation, useScrollToTopOnPush } from '../hooks/useListScrollRestoration'

function SpeciesArtwork({ species, name }) {
  const handleError = (event) => {
    const image = event.currentTarget
    const stage = image.dataset.fallback
    if (!stage) {
      image.dataset.fallback = 'sprite'
      image.src = species.sprite_url
      image.style.imageRendering = 'pixelated'
      return
    }
    if (stage === 'sprite') {
      image.dataset.fallback = 'placeholder'
      image.src = '/pokeball.svg'
      return
    }
    image.onerror = null
  }
  return (
    <img
      src={species.artwork_url}
      onError={handleError}
      alt={`${name} official artwork`}
      className="h-44 w-44 object-contain sm:h-56 sm:w-56"
    />
  )
}

function compareCardIdentity(a, b) {
  const setA = a.set?.name || a.set_ref?.name || ''
  const setB = b.set?.name || b.set_ref?.name || ''
  return String(setA).localeCompare(String(setB), undefined, { numeric: true, sensitivity: 'base' })
    || String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true, sensitivity: 'base' })
    || String(a.id || '').localeCompare(String(b.id || ''))
}

function compareCardPrice(a, b, priceField, direction = 'asc') {
  const priceA = getEffectiveCardPrice(a, null, priceField) || Number.POSITIVE_INFINITY
  const priceB = getEffectiveCardPrice(b, null, priceField) || Number.POSITIVE_INFINITY
  const missingA = !Number.isFinite(priceA)
  const missingB = !Number.isFinite(priceB)

  // Unpriced cards always stay at the end, including for descending order.
  if (missingA !== missingB) return missingA ? 1 : -1
  if (!missingA && priceA !== priceB) return direction === 'desc' ? priceB - priceA : priceA - priceB
  return compareCardIdentity(a, b)
}

export default function PokedexSpecies() {
  const { dexId } = useParams()
  const dexNumber = Number(dexId)
  const goBack = useDetailBackNavigation('pokedex', '/pokedex')
  useScrollToTopOnPush()
  const [searchParams] = useSearchParams()
  const { t, settings, pricePrimary, pricePrimaryField } = useSettings()
  const language = settings.language === 'de' ? 'de' : 'en'
  const [cardLanguage, setCardLanguage] = useState('all')
  const [cardSort, setCardSort] = useState('price_asc')
  const visibleLanguages = useVisibleTcgdexLanguages()
  const cardLanguageCodes = useMemo(() => [...new Set(
    visibleLanguages
      .map((entry) => typeof entry === 'string' ? entry : entry?.code)
      .filter(Boolean)
  )], [visibleLanguages])

  const speciesQuery = useQuery({
    queryKey: ['pokedex', 'species', dexNumber, language],
    queryFn: () => getPokedexSpecies(dexNumber, { lang: language }),
    enabled: Number.isInteger(dexNumber),
  })

  const cardsQuery = useQuery({
    queryKey: ['pokedex', 'cards', dexNumber, cardLanguage],
    queryFn: () => searchCards({ dex_id: dexNumber, lang: cardLanguage, page_size: 2000 }).then(r => r.data),
    enabled: Number.isInteger(dexNumber),
    staleTime: 60_000,
  })

  const selectedPriceLabel = t(`prices.${pricePrimary}`)

  const cards = useMemo(() => {
    const rows = cardsQuery.data?.data || []
    return [...rows].sort((a, b) => {
      if (cardSort === 'price_desc') return compareCardPrice(a, b, pricePrimaryField, 'desc')
      if (cardSort === 'owned_first') {
        if (Boolean(a.owned) !== Boolean(b.owned)) return a.owned ? -1 : 1
        return compareCardPrice(a, b, pricePrimaryField)
      }
      if (cardSort === 'wishlist_first') {
        if (Boolean(a.wishlisted) !== Boolean(b.wishlisted)) return a.wishlisted ? -1 : 1
        return compareCardPrice(a, b, pricePrimaryField)
      }
      if (cardSort === 'set_number') return compareCardIdentity(a, b)
      return compareCardPrice(a, b, pricePrimaryField)
    })
  }, [cardsQuery.data, cardSort, pricePrimaryField])

  if (speciesQuery.isLoading) return <div className="flex justify-center py-20"><PokeBallLoader size={52} /></div>
  if (speciesQuery.isError || !speciesQuery.data) return <p className="p-6 text-brand-red">{t('common.error')}</p>

  const species = speciesQuery.data
  const name = language === 'de' ? species.name_de : species.name_en
  const secondaryName = language === 'de' ? species.name_en : species.name_de
  const generationQuery = searchParams.get('generation')
  const suffix = generationQuery ? `?generation=${generationQuery}` : ''

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 pb-28 pt-2 sm:px-6 lg:px-8">
      <button type="button" onClick={goBack} className="btn-ghost inline-flex items-center gap-2">
        <ArrowLeft size={16} /> {t('common.back')}
      </button>

      <section className="overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-bg-card to-bg-surface p-5 sm:p-7">
        <div className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center">
          <div className="flex justify-center rounded-3xl bg-bg-elevated/60 p-4">
            <SpeciesArtwork species={species} name={name} />
          </div>
          <div>
            <p className="text-sm font-black tracking-[0.2em] text-brand-red">#{String(species.dex_id).padStart(3, '0')}</p>
            <h1 className="mt-1 text-4xl font-black text-text-primary">{name}</h1>
            {secondaryName && secondaryName !== name && <p className="text-lg text-text-secondary">{secondaryName}</p>}
            <p className="mt-2 text-sm text-text-muted">Gen {species.generation} · {species.region}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {(species.types || []).map((type) => <span key={type} className="rounded-full border border-border bg-bg-card px-3 py-1 text-xs font-semibold capitalize text-text-secondary">{type}</span>)}
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <span className={`rounded-xl border px-3 py-2 text-sm font-bold ${species.owned ? 'border-green/30 bg-green/10 text-green' : 'border-border bg-bg-card text-text-secondary'}`}>
                {species.owned ? `✓ ${species.owned_cards} ${t('pokedex.cardsOwned')}` : t('pokedex.missing')}
              </span>
              <span className="rounded-xl border border-border bg-bg-card px-3 py-2 text-sm font-semibold text-text-secondary">
                {species.available_printings} {t('pokedex.printings')}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 border-t border-border pt-5">
          {species.previous_dex_id ? (
            <Link to={`/pokedex/${species.previous_dex_id}${suffix}`} className="btn-ghost justify-start gap-2"><ChevronLeft size={17} /> {t('pokedex.previous')}</Link>
          ) : <span />}
          {species.next_dex_id ? (
            <Link to={`/pokedex/${species.next_dex_id}${suffix}`} className="btn-ghost justify-end gap-2">{t('pokedex.next')} <ChevronRight size={17} /></Link>
          ) : <span />}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-black text-text-primary">{t('pokedex.availableCards')}</h2>
            <p className="text-sm text-text-muted">{cardsQuery.data?.total_count ?? cards.length} {t('pokedex.printings')}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <SortAsc size={15} aria-hidden="true" />
              <span>{t('pokedex.sortBy')}</span>
              <select
                className="select w-48 py-1.5 text-sm"
                value={cardSort}
                onChange={(event) => setCardSort(event.target.value)}
              >
                <option value="price_asc">{selectedPriceLabel}: {t('pokedex.sortLowToHigh')}</option>
                <option value="price_desc">{selectedPriceLabel}: {t('pokedex.sortHighToLow')}</option>
                <option value="owned_first">{t('pokedex.sortOwnedFirst')}</option>
                <option value="wishlist_first">{t('pokedex.sortWishlistFirst')}</option>
                <option value="set_number">{t('pokedex.sortSetNumber')}</option>
              </select>
            </label>
            <div className="flex max-w-full gap-2 overflow-x-auto pb-1" role="group" aria-label={t('pokedex.cardLanguage')}>
              <button
                type="button"
                onClick={() => setCardLanguage('all')}
                className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold ${cardLanguage === 'all' ? 'border-brand-red bg-brand-red/20 text-brand-red' : 'border-border text-text-secondary'}`}
              >
                {t('pokedex.allLanguages')}
              </button>
              {cardLanguageCodes.map((code) => (
                <button
                  type="button"
                  key={code}
                  onClick={() => setCardLanguage(code)}
                  className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold ${cardLanguage === code ? 'border-brand-red bg-brand-red/20 text-brand-red' : 'border-border text-text-secondary'}`}
                >
                  {tcgdexLanguageLabel(code)}
                </button>
              ))}
            </div>
          </div>
        </div>
        {cardsQuery.isLoading && <div className="flex justify-center py-16"><PokeBallLoader size={44} /></div>}
        {!cardsQuery.isLoading && cards.length === 0 && (
          <p className="rounded-2xl border border-border bg-bg-card p-6 text-center text-text-muted">{t('pokedex.noCards')}</p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {cards.map((card) => <CardItem key={card.id} card={card} />)}
        </div>
      </section>
    </div>
  )
}
