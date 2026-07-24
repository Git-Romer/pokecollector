import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Check, Search } from 'lucide-react'
import clsx from 'clsx'
import { getPokedex } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import PokeBallLoader from '../components/PokeBallLoader'
import { getSavedListScrollPosition, isSavedPositionForLocation, useListScrollRestoration } from '../hooks/useListScrollRestoration'

const GENERATIONS = [
  { id: 1, region: 'Kanto', range: '#001–151' },
  { id: 2, region: 'Johto', range: '#152–251' },
  { id: 3, region: 'Hoenn', range: '#252–386' },
  { id: 4, region: 'Sinnoh', range: '#387–493' },
  { id: 5, region: 'Unova', range: '#494–649' },
  { id: 6, region: 'Kalos', range: '#650–721' },
  { id: 7, region: 'Alola', range: '#722–809' },
  { id: 8, region: 'Galar', range: '#810–905' },
  { id: 9, region: 'Paldea', range: '#906–1025' },
]

function SpeciesImage({ entry, name }) {
  const handleError = (event) => {
    const image = event.currentTarget
    const stage = image.dataset.fallback
    if (!stage) {
      image.dataset.fallback = 'artwork'
      image.src = entry.artwork_url
      return
    }
    if (stage === 'artwork') {
      image.dataset.fallback = 'placeholder'
      image.src = '/pokeball.svg'
      return
    }
    image.onerror = null
  }
  return (
    <img
      src={entry.sprite_url}
      alt={`${name} sprite`}
      loading="lazy"
      onError={handleError}
      className="h-20 w-20 sm:h-24 sm:w-24 object-contain [image-rendering:pixelated]"
    />
  )
}

function PokemonTile({ entry, onClick, language, t }) {
  const name = language === 'de' ? entry.name_de : entry.name_en
  const secondaryName = language === 'de' ? entry.name_en : entry.name_de
  return (
    <button
      type="button"
      id={`pokemon-${entry.dex_id}`}
      data-scroll-anchor={`pokemon-${entry.dex_id}`}
      onClick={onClick}
      className={clsx(
        'group relative rounded-2xl border p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-red',
        entry.owned
          ? 'border-green/30 bg-gradient-to-b from-green/10 to-bg-card'
          : 'border-border bg-bg-card hover:border-text-muted'
      )}
      aria-label={`#${String(entry.dex_id).padStart(3, '0')} ${name}, ${entry.owned ? t('pokedex.owned') : t('pokedex.missing')}`}
    >
      {entry.owned && (
        <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-green text-black shadow">
          <Check size={15} strokeWidth={3} />
        </span>
      )}
      <div className={clsx('flex justify-center transition-opacity', !entry.owned && 'opacity-65 group-hover:opacity-90')}>
        <SpeciesImage entry={entry} name={name} />
      </div>
      <p className="text-[10px] font-black tracking-[0.15em] text-text-muted">
        #{String(entry.dex_id).padStart(3, '0')}
      </p>
      <h3 className="mt-0.5 truncate text-sm font-bold text-text-primary">{name}</h3>
      {secondaryName && secondaryName !== name && (
        <p className="truncate text-[10px] text-text-muted">{secondaryName}</p>
      )}
      <div className="mt-2 space-y-0.5 text-[10px]">
        <p className={entry.owned ? 'font-semibold text-green' : 'font-semibold text-text-secondary'}>
          {entry.owned
            ? `✓ ${entry.owned_cards} ${t('pokedex.cardsOwned')}`
            : t('pokedex.missing')}
        </p>
        <p className="text-text-muted">
          {entry.available_printings > 0
            ? `${entry.available_printings} ${t('pokedex.printings')}`
            : t('pokedex.noPrintings')}
        </p>
      </div>
    </button>
  )
}

export default function Pokedex() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { t, settings } = useSettings()
  const requestedGeneration = Number(searchParams.get('generation'))
  const [generation, setGeneration] = useState(
    Number.isInteger(requestedGeneration) && requestedGeneration >= 1 && requestedGeneration <= 9
      ? requestedGeneration
      : null
  )
  // The list remounts after Back. Restore non-URL filters before its query runs
  // so the saved Pokémon anchor is present when scroll restoration occurs.
  const savedPosition = getSavedListScrollPosition('pokedex')
  const savedListState = isSavedPositionForLocation(savedPosition, location)
    ? savedPosition.listState
    : null
  const [status, setStatus] = useState(savedListState?.status || 'all')
  const [search, setSearch] = useState(savedListState?.search || '')
  const language = settings.language === 'de' ? 'de' : 'en'

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pokedex', generation, status, search, language],
    queryFn: () => getPokedex({
      generation: generation || undefined,
      status,
      search: search.trim() || undefined,
      lang: language,
    }),
    staleTime: 60_000,
  })

  const entries = data?.entries || []
  const { saveScrollPosition, createDetailNavigationState } = useListScrollRestoration({
    key: 'pokedex',
    isReady: !isLoading && !isError && entries.length > 0,
  })
  const grouped = useMemo(() => {
    if (generation || search.trim()) return [{ generation, entries }]
    return GENERATIONS.map((item) => ({
      generation: item.id,
      entries: entries.filter((entry) => entry.generation === item.id),
    })).filter((group) => group.entries.length)
  }, [entries, generation, search])

  const summary = data?.summary || { total: 0, owned: 0, missing: 0 }
  const progress = summary.total ? Math.round((summary.owned / summary.total) * 100) : 0
  const scope = generation ? GENERATIONS.find((item) => item.id === generation) : null
  const selectGeneration = (value) => {
    setGeneration(value)
    if (value) setSearchParams({ generation: String(value) })
    else setSearchParams({})
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 px-4 pb-28 pt-2 sm:px-6 lg:px-8">
      <section className="rounded-3xl border border-border bg-gradient-to-br from-bg-card to-bg-surface p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-brand-red">PokéCollector</p>
            <h1 className="mt-1 text-3xl font-black text-text-primary">
              {scope ? `${scope.region} Pokédex` : t('pokedex.title')}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">{t('pokedex.subtitle')}</p>
          </div>
          <div className="min-w-52 rounded-2xl border border-border bg-bg-card p-3">
            <div className="flex items-end justify-between gap-3">
              <span className="text-2xl font-black text-text-primary">{summary.owned}/{summary.total}</span>
              <span className="text-xs font-semibold text-text-muted">{progress}% {t('pokedex.collected')}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-elevated">
              <div className="h-full rounded-full bg-green transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-bg-surface p-3 sm:p-4">
        <label className="relative block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('pokedex.searchPlaceholder')}
            className="input w-full pl-10"
            aria-label={t('pokedex.searchPlaceholder')}
          />
        </label>

        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          <button
            type="button"
            onClick={() => selectGeneration(null)}
            className={clsx('whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold', !generation ? 'border-brand-red bg-brand-red/20 text-brand-red' : 'border-border text-text-secondary')}
          >
            {t('pokedex.national')}
          </button>
          {GENERATIONS.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => selectGeneration(item.id)}
              className={clsx('whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold', generation === item.id ? 'border-brand-red bg-brand-red/20 text-brand-red' : 'border-border text-text-secondary')}
            >
              Gen {item.id} · {item.region}
            </button>
          ))}
        </div>

        <div className="flex gap-2" role="group" aria-label="Ownership filter">
          {['all', 'owned', 'missing'].map((value) => (
            <button
              type="button"
              key={value}
              onClick={() => setStatus(value)}
              className={clsx('rounded-xl border px-3 py-1.5 text-xs font-bold', status === value ? 'border-green/40 bg-green/15 text-green' : 'border-border text-text-secondary')}
            >
              {t(`pokedex.${value}`)}
            </button>
          ))}
        </div>
      </section>

      {isLoading && <div className="flex justify-center py-16"><PokeBallLoader size={48} /></div>}
      {isError && <p className="rounded-xl border border-brand-red/30 bg-brand-red/10 p-4 text-brand-red">{t('common.error')}</p>}
      {!isLoading && !isError && entries.length === 0 && <p className="py-12 text-center text-text-muted">{t('common.noResults')}</p>}

      {!isLoading && grouped.map((group) => {
        const info = GENERATIONS.find((item) => item.id === group.generation)
        return (
          <section key={group.generation || 'results'} className="space-y-3">
            {!generation && !search.trim() && info && (
              <div className="flex items-end justify-between border-b border-border pb-2">
                <div>
                  <h2 className="text-xl font-black text-text-primary">{info.region}</h2>
                  <p className="text-xs text-text-muted">Gen {info.id} · {info.range}</p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {group.entries.map((entry) => (
                <PokemonTile
                  key={entry.dex_id}
                  entry={entry}
                  language={language}
                  t={t}
                  onClick={() => {
                    const anchorId = `pokemon-${entry.dex_id}`
                    saveScrollPosition(anchorId, { status, search })
                    navigate(`/pokedex/${entry.dex_id}${generation ? `?generation=${generation}` : ''}`, {
                      state: createDetailNavigationState(anchorId),
                    })
                  }}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
