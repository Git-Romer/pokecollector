import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from 'lucide-react'
import clsx from 'clsx'
import { getArtistsIndex } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { normalizeTcgdexLanguage } from '../utils/tcgdexLanguages'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'

const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300
const SORT_OPTIONS = ['name', 'cards', 'progress', 'missing']

export function parseArtistsState(searchParams) {
  const read = (key) => String(searchParams?.get?.(key) ?? '').trim()
  const requestedSort = read('sort_by')
  return {
    q: read('q'),
    lang: normalizeTcgdexLanguage(read('lang') || 'all', 'all'),
    sortBy: SORT_OPTIONS.includes(requestedSort) ? requestedSort : 'name',
    sortOrder: read('sort_order') === 'desc' ? 'desc' : 'asc',
    page: /^[1-9]\d*$/.test(read('page')) ? Number(read('page')) : 1,
  }
}

function clampPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(100, Math.max(0, Math.round(numeric * 10) / 10))
}

function ArtistRow({ artist, t, formatPrice }) {
  const total = Math.max(0, Number(artist?.total_count) || 0)
  const owned = Math.max(0, Number(artist?.owned_count) || 0)
  const missing = Math.max(0, Number(artist?.missing_count ?? total - owned) || 0)
  const missingValue = Number(artist?.missing_value) || 0
  const percent = clampPercent(artist?.progress ?? (total > 0 ? (owned / total) * 100 : 0))
  const languages = Array.isArray(artist?.languages) ? artist.languages.filter(Boolean) : []

  return (
    <li className="group relative transition-colors hover:bg-bg-elevated/40">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Link
            to={`/artist/${encodeURIComponent(artist.name || '')}`}
            title={artist.name}
            className="min-w-0 truncate text-sm font-medium text-text-primary transition-colors group-hover:text-brand-red focus-visible:text-brand-red after:absolute after:inset-0 after:content-['']"
          >
            {artist.name}
          </Link>
          {languages.length > 0 && (
            <span className="flex flex-wrap items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
              {languages.map((code) => <span key={code}>{code}</span>)}
            </span>
          )}
        </div>

        <div className="flex items-baseline justify-end gap-2 whitespace-nowrap text-[11px] tabular-nums">
          <span className="text-text-muted">
            <span className="font-semibold text-text-secondary">{owned.toLocaleString()}</span>
            {' / '}
            {total.toLocaleString()}
            <span className="ml-1 hidden sm:inline">{t('artists.ownedOf')}</span>
          </span>
          <span
            className={clsx(
              'w-11 text-right font-bold',
              percent >= 100 ? 'text-green' : percent > 0 ? 'text-text-primary' : 'text-text-muted',
            )}
          >
            {percent}%
          </span>
        </div>

        <div className="min-w-0">
          <div
            className="hp-bar-track max-w-[28rem]"
            role="progressbar"
            aria-label={t('artists.progress').replace('{artist}', artist.name || '')}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={t('artists.progressValue')
              .replace('{owned}', owned.toLocaleString())
              .replace('{total}', total.toLocaleString())
              .replace('{percent}', percent)}
          >
            <div
              className={clsx('hp-bar-fill', percent >= 66 ? 'healthy' : percent >= 33 ? 'medium' : 'low')}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
          {missing > 0 && (
            <span className="text-text-secondary">
              {t('artists.missing').replace('{count}', missing.toLocaleString())}
            </span>
          )}
          {missingValue > 0 && (
            <span className="text-text-muted" title={t('artists.missingValue')}>
              {formatPrice(missingValue)}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}

export default function Artists() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { t, formatPrice } = useSettings()

  const { q, lang, sortBy, sortOrder, page } = useMemo(
    () => parseArtistsState(searchParams),
    [searchParams],
  )

  // The input is local so typing stays responsive; the URL is written once the
  // typed text settles, which keeps Back/Forward and shared links meaningful.
  const [search, setSearch] = useState(q)
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS)
  // The last q observed in the URL, so an external change (Back/Forward, a
  // shared link) can reset the input.
  const urlQRef = useRef(q)
  // Only typing writes to the URL; a URL-driven reset must never write back,
  // otherwise going Back would immediately restore the query it just left.
  const typingRef = useRef(false)

  const updateParams = useCallback((updates, { replace = false, resetPage = true } = {}) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(updates).forEach(([key, rawValue]) => {
      const value = String(rawValue ?? '').trim()
      const isDefault = (key === 'q' && value === '')
        || (key === 'lang' && value === 'all')
        || (key === 'sort_by' && value === 'name')
        || (key === 'sort_order' && value === 'asc')
        || (key === 'page' && (value === '' || value === '1'))
      if (!value || isDefault) next.delete(key)
      else next.set(key, value)
    })
    if (resetPage) next.delete('page')
    setSearchParams(next, { replace })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (q === urlQRef.current) return
    urlQRef.current = q
    typingRef.current = false
    setSearch(q)
  }, [q])

  useEffect(() => {
    if (!typingRef.current) return
    // Wait for the debounce to catch up with what is currently in the box.
    if (debouncedSearch !== search.trim()) return
    typingRef.current = false
    if (debouncedSearch === q) return
    urlQRef.current = debouncedSearch
    updateParams({ q: debouncedSearch })
  }, [debouncedSearch, search, q, updateParams])

  const queryParams = useMemo(() => ({
    q: q || undefined,
    lang,
    sort_by: sortBy,
    sort_order: sortOrder,
    page,
    page_size: PAGE_SIZE,
  }), [q, lang, sortBy, sortOrder, page])

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['artists-index', queryParams],
    queryFn: () => getArtistsIndex(queryParams).then(r => r.data),
    // Keeps the current page on screen while the next one loads so the list
    // does not collapse between pages or filter changes.
    placeholderData: (prev) => prev,
    staleTime: 60 * 1000,
  })

  const artists = Array.isArray(data?.artists) ? data.artists.filter(Boolean) : []
  const totalCount = Math.max(0, Number(data?.total_count) || 0)
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  const languageOptions = useMemo(() => {
    const codes = Array.isArray(data?.languages) ? [...data.languages] : []
    if (lang !== 'all' && !codes.includes(lang)) codes.push(lang)
    return codes.length > 0 ? codes.map(code => ({ code })) : undefined
  }, [data?.languages, lang])

  // A direct link can land on a page that no longer exists once the real totals
  // arrive. Rewrite it instead of showing an empty list.
  useEffect(() => {
    if (!data || isFetching || page <= totalPages) return
    updateParams(
      { page: totalPages > 1 ? String(totalPages) : '' },
      { replace: true, resetPage: false },
    )
  }, [data, isFetching, page, totalPages, updateParams])

  const orderLabels = {
    name: { asc: t('artists.orderNameAsc'), desc: t('artists.orderNameDesc') },
    cards: { asc: t('artists.orderCardsAsc'), desc: t('artists.orderCardsDesc') },
    progress: { asc: t('artists.orderProgressAsc'), desc: t('artists.orderProgressDesc') },
    missing: { asc: t('artists.orderMissingAsc'), desc: t('artists.orderMissingDesc') },
  }
  const orderLabel = orderLabels[sortBy]?.[sortOrder] || t('common.sortAscending')
  const toggleOrder = () => updateParams({ sort_order: sortOrder === 'asc' ? 'desc' : 'asc' })

  const showing = t('artists.showing')
    .replace('{count}', artists.length)
    .replace('{total}', totalCount.toLocaleString())

  if (isLoading) {
    return (
      <div className="space-y-4 pb-2">
        <div className="skeleton h-8 w-40 rounded" />
        <div className="skeleton h-24 rounded-xl" />
        <div className="card space-y-2.5 p-3">
          {[...Array(8)].map((_, i) => <div key={i} className="skeleton h-9 rounded-lg" />)}
        </div>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="space-y-4 pb-2">
        <h1 className="text-xl font-bold text-text-primary">{t('artists.title')}</h1>
        <div className="card py-12 text-center">
          <p className="text-brand-red">{t('artists.loadFailed')}</p>
          <p className="mt-1 text-sm text-text-muted">{error.message}</p>
          <button type="button" onClick={() => refetch()} className="btn-ghost mt-4 mx-auto">
            {t('artists.retry')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-2">
      {/* ─── Header ───────────────────────────────────────────────── */}
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-text-primary">{t('artists.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          <span className="font-semibold tabular-nums text-text-primary">{totalCount.toLocaleString()}</span>
          {' '}
          {t('artists.count')}
        </p>
        <p className="mt-0.5 text-xs text-text-muted">{t('artists.subtitle')}</p>
      </div>

      {/* ─── Search, language and sort ────────────────────────────── */}
      <div className="card space-y-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="artists-search" className="sr-only">{t('artists.searchPlaceholder')}</label>
            <div className="relative">
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                id="artists-search"
                type="text"
                value={search}
                onChange={(event) => {
                  typingRef.current = true
                  setSearch(event.target.value)
                }}
                placeholder={t('artists.searchPlaceholder')}
                autoComplete="off"
                className="input pl-8 py-2 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:w-auto md:grid-cols-[11rem_minmax(0,1fr)]">
            <div className="min-w-0">
              <label htmlFor="artists-language" className="mb-1 block text-xs text-text-muted">
                {t('artists.language')}
              </label>
              <TcgdexLanguageSelect
                id="artists-language"
                value={lang}
                includeAll
                allLabel={t('artists.allLanguages')}
                compact
                languages={languageOptions}
                onChange={(value) => updateParams({ lang: value })}
                className="select"
              />
            </div>

            <div className="min-w-0">
              <label htmlFor="artists-sort" className="mb-1 block text-xs text-text-muted">
                {t('artists.sortBy')}
              </label>
              <div className="flex gap-2">
                <select
                  id="artists-sort"
                  value={sortBy}
                  onChange={(event) => updateParams({ sort_by: event.target.value })}
                  className="select min-w-0 flex-1"
                >
                  <option value="name">{t('artists.sortName')}</option>
                  <option value="cards">{t('artists.sortCards')}</option>
                  <option value="progress">{t('artists.sortProgress')}</option>
                  <option value="missing">{t('artists.sortMissing')}</option>
                </select>
                <button
                  type="button"
                  onClick={toggleOrder}
                  className="btn-ghost flex-shrink-0 whitespace-nowrap px-2.5 py-2 text-xs"
                  aria-label={orderLabel}
                  title={orderLabel}
                >
                  {sortOrder === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  <span className="hidden sm:inline">{orderLabel}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <p className="border-t border-border pt-3 text-xs text-text-muted" aria-live="polite">
          {showing}
          {isFetching && <span className="ml-1">{t('common.updating')}</span>}
        </p>
      </div>

      {/* ─── Artist list ──────────────────────────────────────────── */}
      {artists.length === 0 ? (
        <div className="card py-12 text-center">
          <p className="text-text-secondary">
            {q ? t('artists.empty').replace('{query}', q) : t('artists.emptyAll')}
          </p>
          <p className="mt-1 text-sm text-text-muted">
            {q ? t('artists.emptyHint') : t('artists.emptyAllHint')}
          </p>
          {q && (
            <button
              type="button"
              onClick={() => {
                typingRef.current = false
                urlQRef.current = ''
                setSearch('')
                updateParams({ q: '' })
              }}
              className="btn-ghost mt-4 mx-auto"
            >
              {t('common.clear')}
            </button>
          )}
        </div>
      ) : (
        <ul className="card divide-y divide-border overflow-hidden p-0">
          {artists.map((artist) => (
            <ArtistRow
              key={artist.name}
              artist={artist}
              t={t}
              formatPrice={formatPrice}
            />
          ))}
        </ul>
      )}

      {/* ─── Pagination ───────────────────────────────────────────── */}
      {totalPages > 1 && artists.length > 0 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => updateParams({ page: String(Math.max(1, page - 1)) }, { resetPage: false })}
            disabled={page <= 1}
            className="btn-ghost px-2 py-1.5 disabled:opacity-50"
            aria-label={t('artists.previous')}
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm tabular-nums text-text-secondary">
            {t('artists.pageOf')
              .replace('{page}', page)
              .replace('{pages}', totalPages)}
          </span>
          <button
            type="button"
            onClick={() => updateParams({ page: String(Math.min(totalPages, page + 1)) }, { resetPage: false })}
            disabled={page >= totalPages}
            className="btn-ghost px-2 py-1.5 disabled:opacity-50"
            aria-label={t('artists.next')}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
