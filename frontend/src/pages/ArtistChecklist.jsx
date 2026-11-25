import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Layers,
  Search,
} from 'lucide-react'
import clsx from 'clsx'
import { getArtistChecklist } from '../api/client'
import WindowedCardGrid from '../components/WindowedCardGrid'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { normalizeTcgdexLanguage } from '../utils/tcgdexLanguages'
import { useScrollToTopOnPush } from '../hooks/useListScrollRestoration'
import { CardDisplay } from '../components/card-system'
import { CardModal } from '../components/CardItem'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'

const PAGE_SIZE = 60
const SORT_OPTIONS = ['number', 'name', 'price']
const OWNERSHIP_OPTIONS = ['owned', 'missing']
const UNKNOWN_SET_KEY = '__unknown_set__'

export function navigateBackFromArtist(navigate) {
  navigate('/artists')
}

// React Router already decodes route params, so a name that legitimately
// contains "%" must not be decoded again: that would throw or corrupt it.
export function decodeArtistParam(value) {
  return String(value || '')
}

export function parseArtistChecklistState(searchParams) {
  const read = (key) => String(searchParams?.get?.(key) ?? '').trim()
  const requestedOwnership = read('ownership')
  const requestedSort = read('sort_by')
  return {
    lang: normalizeTcgdexLanguage(read('lang') || 'all', 'all'),
    ownership: OWNERSHIP_OPTIONS.includes(requestedOwnership) ? requestedOwnership : '',
    sortBy: SORT_OPTIONS.includes(requestedSort) ? requestedSort : 'number',
    sortOrder: read('sort_order') === 'desc' ? 'desc' : 'asc',
    page: /^[1-9]\d*$/.test(read('page')) ? Number(read('page')) : 1,
  }
}

export function isCardOwned(card) {
  return Boolean(card?.owned) || Number(card?.owned_quantity || 0) > 0
}

// Cards arrive sorted by the server. Grouping keeps that order inside each set
// and keeps sets in the order their first card appears, so the collector number
// sort (which the API already orders by set release date) stays meaningful while
// each set reads as one block.
export function groupCardsBySet(cards = []) {
  const groups = []
  const byKey = new Map()

  for (const card of cards) {
    // Only set_ref.id addresses the set detail page; card.set_id is the TCGdex
    // set code and must never be used as the route id.
    const linkId = card?.set_ref?.id ? String(card.set_ref.id) : null
    const key = linkId || card?.set_id || UNKNOWN_SET_KEY
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        linkId,
        setName: card?.set_name || card?.set_ref?.name || '',
        owned: 0,
        total: 0,
        cards: [],
      }
      byKey.set(key, group)
      groups.push(group)
    }
    group.cards.push(card)
    group.total += 1
    if (isCardOwned(card)) group.owned += 1
  }

  return groups
}

function Stat({ value, label, tone = 'text-text-primary' }) {
  const display = typeof value === 'number' ? value.toLocaleString() : value
  return (
    <div className="min-w-0">
      <p className={clsx('truncate text-lg font-bold tabular-nums md:text-2xl', tone)} title={String(display)}>
        {display}
      </p>
      <p className="text-xs text-text-muted">{label}</p>
    </div>
  )
}

export default function ArtistChecklist() {
  const navigate = useNavigate()
  const { artistName } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const { t, formatPrice } = useSettings()
  useScrollToTopOnPush()

  const artistQuery = decodeArtistParam(artistName)
  const { lang, ownership, sortBy, sortOrder, page } = useMemo(
    () => parseArtistChecklistState(searchParams),
    [searchParams],
  )

  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedCardTab, setSelectedCardTab] = useState('add')

  const updateParams = useCallback((updates, { replace = false, resetPage = true } = {}) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(updates).forEach(([key, rawValue]) => {
      const value = String(rawValue ?? '').trim()
      const isDefault = (key === 'ownership' && value === '')
        || (key === 'sort_by' && value === 'number')
        || (key === 'sort_order' && value === 'asc')
        || (key === 'lang' && value === 'all')
      if (!value || isDefault) next.delete(key)
      else next.set(key, value)
    })
    if (resetPage) next.delete('page')
    setSearchParams(next, { replace })
  }, [searchParams, setSearchParams])

  const queryParams = useMemo(() => ({
    artist: artistQuery,
    lang,
    ownership: ownership || undefined,
    page,
    page_size: PAGE_SIZE,
    sort_by: sortBy,
    sort_order: sortOrder,
  }), [artistQuery, lang, ownership, page, sortBy, sortOrder])

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['artist-checklist', queryParams],
    queryFn: () => getArtistChecklist(queryParams).then(r => r.data),
    enabled: Boolean(artistQuery),
    // Keeps the previous page on screen while the next one loads, so paging and
    // filter changes do not collapse the grid.
    placeholderData: (prev) => prev,
    staleTime: 60 * 1000,
  })

  const cards = data?.cards || []
  const rootTotal = Number(data?.total_count) || 0
  const ownedCount = Number(data?.owned_count) || 0
  const missingCount = Math.max(rootTotal - ownedCount, 0)
  const missingValue = Number(data?.missing_value) || 0
  const artists = Array.isArray(data?.artists) ? data.artists.filter(Boolean) : []
  const displayArtist = artists.length ? artists.join(' · ') : artistQuery

  // The endpoint reports artist-wide totals plus `list_count`, the number of
  // cards matching the ownership filter. Fall back to arithmetic when an older
  // response omits it so paging still terminates.
  const responseListCount = data?.list_count == null ? null : Number(data.list_count)
  const filteredTotal = Number.isFinite(responseListCount)
    ? responseListCount
    : ownership === 'owned'
      ? ownedCount
      : ownership === 'missing'
        ? missingCount
        : rootTotal
  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE))

  const progressValue = data?.progress
  const numericProgress = progressValue == null ? NaN : Number(progressValue)
  const rawPercent = Number.isFinite(numericProgress)
    ? numericProgress
    : (rootTotal > 0 ? (ownedCount / rootTotal) * 100 : 0)
  const safeProgress = Math.min(100, Math.max(0, Math.round(rawPercent * 10) / 10))

  // The server reports the languages this artist actually has printings in.
  // A language named in the URL but absent from that list is kept visible so the
  // selector never claims "all" while the query filters by it.
  const languageOptions = useMemo(() => {
    const codes = Array.isArray(data?.languages) ? [...data.languages] : []
    if (lang !== 'all' && !codes.includes(lang)) codes.push(lang)
    return codes.map(code => ({ code }))
  }, [data?.languages, lang])

  const grouped = sortBy === 'number'
  const setGroups = useMemo(
    () => (grouped ? groupCardsBySet(cards) : null),
    [grouped, cards],
  )

  // A direct link or a shrinking result set can leave the URL on a page that no
  // longer exists. Rewrite it once the real totals are known.
  useEffect(() => {
    if (!data || isFetching || page <= totalPages) return
    updateParams(
      { page: totalPages > 1 ? String(totalPages) : '' },
      { replace: true, resetPage: false },
    )
  }, [data, isFetching, page, totalPages, updateParams])

  const artistHasCards = rootTotal > 0 || ownedCount > 0 || cards.length > 0
  const emptyMessage = !artistHasCards
    ? t('artistChecklist.emptyArtist').replace('{artist}', artistQuery)
    : ownership === 'owned'
      ? t('artistChecklist.emptyOwned')
      : ownership === 'missing'
        ? t('artistChecklist.emptyMissing')
        : t('artistChecklist.emptyArtist').replace('{artist}', artistQuery)

  const searchLink = `/search?artist=${encodeURIComponent(artistQuery)}`

  const renderCard = (card) => {
    const printings = Array.isArray(card.printings) ? card.printings : []
    const price = card.price_market ?? card.price_trend ?? null
    return (
      <CardDisplay
        key={card.id}
        card={card}
        image={resolveCardImageUrl(card)}
        price={price > 0 ? formatPrice(price) : null}
        dimWhenUnowned
        captionAccessory={printings.length > 1 ? (
          <span
            className="inline-flex items-center gap-0.5 rounded-full border border-border px-1 py-0.5 text-[9px] font-semibold text-text-muted"
            title={t('artistChecklist.printings').replace('{count}', printings.length)}
          >
            <Layers size={9} aria-hidden />{printings.length}
          </span>
        ) : null}
        onClick={() => {
          setSelectedCardTab('add')
          setSelectedCard(card)
        }}
        onAdd={() => {
          setSelectedCardTab('add')
          setSelectedCard(card)
        }}
      />
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-40 rounded" />
        <div className="skeleton h-36 rounded-xl" />
        <div className="skeleton h-20 rounded-xl" />
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
          {[...Array(24)].map((_, i) => <div key={i} className="skeleton aspect-[2.5/3.5] rounded-lg" />)}
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="space-y-4 pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" onClick={() => navigateBackFromArtist(navigate)} className="btn-ghost text-sm py-1.5">
            <ArrowLeft size={14} /> {t('common.back')}
          </button>
          <Link
            to="/artists"
            className="text-xs font-medium text-text-muted transition-colors hover:text-brand-red"
          >
            {t('artists.allArtists')}
          </Link>
        </div>
        <div className="card py-12 text-center">
          <p className="text-brand-red">{t('artistChecklist.loadFailed')}</p>
          <p className="mt-1 text-sm text-text-muted">{error.message}</p>
          <button type="button" onClick={() => refetch()} className="btn-ghost mt-4 mx-auto">
            {t('artistChecklist.retry')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={() => navigateBackFromArtist(navigate)} className="btn-ghost text-sm py-1.5">
          <ArrowLeft size={14} /> {t('common.back')}
        </button>
        <Link
          to="/artists"
          className="text-xs font-medium text-text-muted transition-colors hover:text-brand-red"
        >
          {t('artists.allArtists')}
        </Link>
      </div>

      {/* Artist header */}
      <div className="card">
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-xl font-bold text-text-primary" title={displayArtist}>
                {displayArtist}
              </h1>
              <Link
                to={searchLink}
                className="btn-ghost h-11 w-11 shrink-0 p-0"
                aria-label={`${t('nav.cardSearch')}: ${displayArtist}`}
                title={`${t('nav.cardSearch')}: ${displayArtist}`}
              >
                <Search size={16} aria-hidden="true" />
              </Link>
            </div>
            <p className="mt-0.5 text-sm text-text-secondary">
              {rootTotal.toLocaleString()} {t('artistChecklist.cards')}
            </p>
            {artists.length > 1 && (
              <p className="mt-1 text-xs text-text-muted">
                <span className="font-semibold uppercase tracking-wide">{t('artistChecklist.artistsIncluded')}</span>
                {' · '}
                {artists.join(', ')}
              </p>
            )}

            <div className="mt-3">
              <div className="mb-1 flex items-baseline gap-2 text-sm">
                <span className="text-text-secondary">
                  {ownedCount.toLocaleString()} / {rootTotal.toLocaleString()} {t('artistChecklist.ownedOf')}
                </span>
                <span className="shrink-0 whitespace-nowrap font-bold tabular-nums text-brand-red">
                  {safeProgress}%
                </span>
              </div>
              <div
                className="hp-bar-track"
                role="progressbar"
                aria-label={t('artistChecklist.progress')}
                aria-valuenow={safeProgress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={t('artists.progressValue')
                  .replace('{owned}', ownedCount.toLocaleString())
                  .replace('{total}', rootTotal.toLocaleString())
                  .replace('{percent}', safeProgress)}
              >
                <div
                  className={clsx('hp-bar-fill', safeProgress >= 66 ? 'healthy' : safeProgress >= 33 ? 'medium' : 'low')}
                  style={{ width: `${safeProgress}%` }}
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              <Stat value={ownedCount} label={t('artistChecklist.owned')} tone="text-green" />
              <Stat value={missingCount} label={t('artistChecklist.missing')} tone="text-brand-red" />
              {missingValue > 0 && (
                <Stat value={formatPrice(missingValue)} label={t('artistChecklist.missingValue')} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Ownership filter */}
      <div className="flex w-full min-w-0 gap-2 overflow-x-auto pb-1" role="group" aria-label={t('artistChecklist.filterGroup')}>
        {[
          { key: '', label: t('artistChecklist.all'), count: rootTotal },
          { key: 'owned', label: t('artistChecklist.ownedFilter'), count: ownedCount },
          { key: 'missing', label: t('artistChecklist.missingFilter'), count: missingCount },
        ].map(({ key, label, count }) => {
          const active = ownership === key
          return (
            <button
              key={key || 'all'}
              type="button"
              aria-pressed={active}
              onClick={() => updateParams({ ownership: key })}
              className={clsx(
                'whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all',
                active
                  ? 'border border-brand-red/30 bg-brand-red/20 text-brand-red'
                  : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary',
              )}
            >
              {label} ({count.toLocaleString()})
            </button>
          )
        })}
      </div>

      {/* Sort and language */}
      <div className="card p-3">
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div>
            <label htmlFor="artist-checklist-language" className="mb-1 block text-xs text-text-muted">
              {t('artistChecklist.language')}
            </label>
            <TcgdexLanguageSelect
              id="artist-checklist-language"
              value={lang}
              includeAll
              allLabel={t('artistChecklist.allLanguages')}
              compact
              languages={languageOptions}
              onChange={(value) => updateParams({ lang: value })}
              className="select"
            />
          </div>

          <div>
            <label htmlFor="artist-checklist-sort" className="mb-1 block text-xs text-text-muted">
              {t('artistChecklist.sortBy')}
            </label>
            <div className="flex gap-2">
              <select
                id="artist-checklist-sort"
                value={sortBy}
                onChange={(event) => updateParams({ sort_by: event.target.value })}
                className="select"
              >
                <option value="number">{t('artistChecklist.sortNumber')}</option>
                <option value="name">{t('artistChecklist.sortName')}</option>
                <option value="price">{t('artistChecklist.sortPrice')}</option>
              </select>
              <button
                type="button"
                onClick={() => updateParams({ sort_order: sortOrder === 'asc' ? 'desc' : 'asc' })}
                className="btn-ghost flex-shrink-0 px-3"
                aria-label={sortOrder === 'asc' ? t('common.sortDescending') : t('common.sortAscending')}
                title={sortOrder === 'asc' ? t('common.sortDescending') : t('common.sortAscending')}
              >
                {sortOrder === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
          </div>

          <p className="text-xs text-text-muted md:text-right" aria-live="polite">
            {t('artistChecklist.showingCards')
              .replace('{count}', cards.length)
              .replace('{total}', filteredTotal.toLocaleString())}
            {isFetching && <span className="ml-1">{t('common.updating')}</span>}
          </p>
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="card py-12 text-center">
          <p className="text-text-secondary">{emptyMessage}</p>
        </div>
      ) : grouped ? (
        <div className="space-y-5">
          {setGroups.map((group, index) => (
            <section
              key={group.key}
              className={clsx('space-y-2', index > 0 && 'border-t border-border pt-4')}
            >
              <div className="flex items-baseline justify-between gap-2 px-0.5">
                {group.linkId ? (
                  <Link
                    to={`/sets/${encodeURIComponent(group.linkId)}`}
                    className="min-w-0 truncate text-sm font-semibold text-text-secondary transition-colors hover:text-brand-red"
                  >
                    {group.setName || group.linkId}
                  </Link>
                ) : (
                  <span className="truncate text-sm font-semibold text-text-secondary">
                    {group.setName || t('artistChecklist.unknownSet')}
                  </span>
                )}
                <span className="shrink-0 rounded-full border border-border bg-bg-card px-2 py-0.5 text-[10px] font-bold tabular-nums text-text-muted">
                  {group.owned}/{group.total}
                </span>
              </div>
              <WindowedCardGrid
                items={group.cards}
                renderItem={renderCard}
                label={group.setName || t('artistChecklist.unknownSet')}
                className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2"
              />
            </section>
          ))}
        </div>
      ) : (
        <WindowedCardGrid
          items={cards}
          renderItem={renderCard}
          label={artistQuery}
          className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2"
        />
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => updateParams({ page: String(Math.max(1, page - 1)) }, { resetPage: false })}
            disabled={page <= 1}
            className="btn-ghost py-1.5 px-2 disabled:opacity-50"
            aria-label={t('artistChecklist.previous')}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm text-text-secondary tabular-nums">
            {t('artistChecklist.pageOf')
              .replace('{page}', page)
              .replace('{pages}', totalPages)}
          </span>
          <button
            type="button"
            onClick={() => updateParams({ page: String(Math.min(totalPages, page + 1)) }, { resetPage: false })}
            disabled={page >= totalPages}
            className="btn-ghost py-1.5 px-2 disabled:opacity-50"
            aria-label={t('artistChecklist.next')}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {selectedCard && (
        <CardModal
          key={selectedCard.id}
          card={selectedCard}
          defaultLang={lang === 'all' ? (selectedCard.lang || 'en') : lang}
          initialTab={selectedCardTab}
          onClose={() => setSelectedCard(null)}
        />
      )}
    </div>
  )
}
