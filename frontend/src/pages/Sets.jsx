import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, Search, Bell, BellOff, SortAsc, Filter, ChevronUp, ChevronDown } from 'lucide-react'
import { getSets, markSetsSeen } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'

export default function Sets() {
  const navigate = useNavigate()
  const { t } = useSettings()
  const [search, setSearch] = useState('')
  const [series, setSeries] = useState('')
  const [sortBy, setSortBy] = useState('release_date')
  const [sortOrder, setSortOrder] = useState('desc')
  const [progressFilter, setProgressFilter] = useState('all')
  const [langFilter, setLangFilter] = useState('all') // 'de' | 'en' | 'all'
  const queryClient = useQueryClient()

  const { data: sets = [], isLoading, isFetching } = useQuery({
    queryKey: ['sets', langFilter],
    queryFn: () => getSets({ lang: langFilter }).then(r => r.data),
  })

  const refreshMutation = useMutation({
    mutationFn: () => getSets({ refresh: true, lang: langFilter }),
    onSuccess: (data) => {
      queryClient.setQueryData(['sets', langFilter], data.data)
      queryClient.invalidateQueries({ queryKey: ['sets'] })
      toast.success(t('sets.refreshed'))
    },
    onError: () => toast.error(t('sets.refreshFailed')),
  })

  const markSeenMutation = useMutation({
    mutationFn: markSetsSeen,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sets'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success(t('sets.markedSeen'))
    },
  })

  const newSets = sets.filter(s => s.is_new)
  const allSeries = [...new Set(sets.map(s => s.series).filter(Boolean))].sort()

  const filtered = useMemo(() => {
    let result = sets.filter(s => {
      if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
      if (series && s.series !== series) return false
      const owned = s.owned_count ?? 0
      const total = s.total ?? 0
      if (progressFilter === 'started' && owned === 0) return false
      if (progressFilter === 'complete' && (owned < total || total === 0)) return false
      return true
    })

    result = [...result].sort((a, b) => {
      let valA, valB
      const owned_a = a.owned_count ?? 0
      const owned_b = b.owned_count ?? 0
      switch (sortBy) {
        case 'release_date': valA = a.release_date || ''; valB = b.release_date || ''; break
        case 'name': valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); break
        case 'total': valA = a.total ?? 0; valB = b.total ?? 0; break
        case 'progress':
          valA = a.total > 0 ? owned_a / a.total : 0
          valB = b.total > 0 ? owned_b / b.total : 0
          break
        default: return 0
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })

    return result
  }, [sets, search, series, progressFilter, sortBy, sortOrder])

  const toggleOrder = () => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')

  return (
    <div className="space-y-4 pb-2">

      {/* ─── Header ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{t('sets.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">
            {sets.length} {t('sets.setsTotal')}
            {newSets.length > 0 && (
              <span className="ml-2 badge badge-red">{newSets.length} {t('sets.newSets')}</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {newSets.length > 0 && (
            <button onClick={() => markSeenMutation.mutate()} className="btn-ghost text-sm py-1.5">
              <BellOff size={14} /> {t('sets.markAllSeen')}
            </button>
          )}
          <button onClick={() => refreshMutation.mutate()} disabled={refreshMutation.isPending || isFetching}
            className="btn-ghost text-sm py-1.5">
            <RefreshCw size={14} className={refreshMutation.isPending ? 'animate-spin' : ''} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* New Sets Alert */}
      {newSets.length > 0 && (
        <div className="card border-brand-red/30 bg-brand-red/5">
          <div className="flex items-center gap-3">
            <Bell size={18} className="text-brand-red flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">
                {newSets.length} {t('sets.newSets')} {t('sets.newSetsDetected')}
              </p>
              <p className="text-xs text-text-secondary">{newSets.map(s => s.name).join(', ')}</p>
            </div>
          </div>
        </div>
      )}

      {/* ─── Filters & Sort ───────────────────────────────────────── */}
      <div className="card space-y-3">
        {/* Language filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-text-muted">{t('lang.filter')}:</span>
          {[
            { value: 'all', label: t('lang.all') },
            { value: 'de', label: `🇩🇪 ${t('lang.de')}` },
            { value: 'en', label: `🇬🇧 ${t('lang.en')}` },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setLangFilter(opt.value)}
              className={`px-3 py-1 rounded-lg text-xs font-bold transition-colors ${
                langFilter === opt.value
                  ? opt.value === 'de'
                    ? 'bg-yellow/20 text-yellow border border-yellow/50'
                    : opt.value === 'en'
                      ? 'bg-blue/20 text-blue-400 border border-blue-400/50'
                      : 'bg-brand-red text-white'
                  : 'bg-bg-card text-text-secondary hover:text-text-primary border border-border'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-0" style={{ flexBasis: '160px' }}>
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input type="text" placeholder={t('sets.filterSets')} value={search}
              onChange={(e) => setSearch(e.target.value)} className="input pl-8 text-sm py-2" />
          </div>
          <select className="select w-full sm:w-48 text-sm py-2" value={series} onChange={(e) => setSeries(e.target.value)}>
            <option value="">{t('common.allSeries')}</option>
            {allSeries.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3">
          <div className="flex items-center gap-2">
            <SortAsc size={14} className="text-text-muted flex-shrink-0" />
            <select className="select text-sm py-1.5 flex-1 sm:w-40 sm:flex-initial" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="release_date">{t('sets.sortReleaseDate')}</option>
              <option value="name">{t('sets.sortName')}</option>
              <option value="total">{t('sets.sortCardCount')}</option>
              <option value="progress">{t('sets.sortProgress')}</option>
            </select>
            <button onClick={toggleOrder} className="btn-ghost py-1.5 px-2 text-sm font-medium flex-shrink-0">
              {sortOrder === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
            <Filter size={14} className="text-text-muted mr-1 flex-shrink-0" />
            {[
              { value: 'all', label: t('sets.filterAll') },
              { value: 'started', label: t('sets.filterStarted') },
              { value: 'complete', label: t('sets.filterComplete') },
            ].map(opt => (
              <button key={opt.value} onClick={() => setProgressFilter(opt.value)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                  progressFilter === opt.value
                    ? 'bg-brand-red text-white'
                    : 'bg-bg-card text-text-secondary hover:text-text-primary border border-border'
                }`}>
                {opt.label}
              </button>
            ))}
          </div>

          <span className="text-xs text-text-muted sm:ml-auto">
            {filtered.length} / {sets.length} {t('sets.setsTotal')}
          </span>
        </div>
      </div>

      {/* ─── FEATURED SET HERO ────────────────────────────────────── */}
      {!isLoading && filtered.length > 0 && (() => {
        const hero = filtered.reduce((best, s) => {
          const bPct = best.total > 0 ? (best.owned_count || 0) / best.total : 0
          const sPct = s.total > 0 ? (s.owned_count || 0) / s.total : 0
          return sPct > bPct ? s : best
        }, filtered[0])
        const heroOwned = hero.owned_count ?? 0
        const heroTotal = hero.total ?? 0
        const heroPct = heroTotal > 0 ? Math.round((heroOwned / heroTotal) * 100) : 0
        return (
          <div
            className="set-hero cursor-pointer mb-6 group"
            onClick={() => navigate(`/sets/${hero.id}`)}
          >
            <div className="set-hero-glow" />
            <div className="relative z-10 flex items-center justify-between p-6 gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-brand-red font-black uppercase tracking-[0.2em] mb-2">{t('sets.topSet')}</p>
                <p className="text-2xl font-black text-white leading-tight mb-1 break-words">{hero.name}</p>
                <p className="text-sm text-text-muted mb-4">{hero.series}</p>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-sm text-text-secondary">{heroOwned}/{heroTotal} {t('sets.heroCards')}</span>
                  <span className={`text-sm font-bold ${heroPct === 100 ? 'text-green' : 'text-text-primary'}`}>{heroPct}%</span>
                </div>
                <div className="hp-bar-track w-48 max-w-full">
                  <div className={`hp-bar-fill ${heroPct >= 66 ? 'healthy' : heroPct >= 33 ? 'medium' : 'low'}`} style={{ width: `${heroPct}%` }} />
                </div>
              </div>
              <div className="flex-shrink-0 w-36 h-28 flex items-center justify-center">
                {hero.images_logo
                  ? <img src={hero.images_logo} alt={hero.name} className="set-hero-logo group-hover:scale-105 transition-transform duration-300" />
                  : <div className="text-text-muted text-xs text-center">{hero.name}</div>
                }
              </div>
            </div>
          </div>
        )
      })()}

      {/* ─── SET GRID — big visual cards ──────────────────────────── */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="rounded-2xl overflow-hidden border border-border">
              <div className="skeleton h-32" />
              <div className="p-4 space-y-2">
                <div className="skeleton h-4 rounded w-2/3" />
                <div className="skeleton h-3 rounded w-1/3" />
                <div className="skeleton h-2 rounded w-full mt-3" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((set) => {
            const owned = set.owned_count ?? 0
            const total = set.total ?? 0
            const pct = total > 0 ? Math.round((owned / total) * 100) : 0
            const hpClass = pct >= 66 ? 'healthy' : pct >= 33 ? 'medium' : 'low'

            return (
              <div
                key={set.id}
                className="bg-bg-card border border-border rounded-2xl overflow-hidden cursor-pointer hover:border-brand-red/40 transition-all duration-200 hover:shadow-[0_4px_20px_rgba(0,0,0,0.4)] group relative"
                onClick={() => navigate(`/sets/${set.id}`)}
              >
                {set.is_new && (
                  <span className="absolute top-2 left-2 z-10 badge badge-red">{t('common.new')}</span>
                )}

                {/* Set logo area — big, centered with dot pattern */}
                <div className="h-28 sm:h-32 bg-bg-elevated flex items-center justify-center relative overflow-hidden">
                  {/* Dot grid background pattern */}
                  <div
                    className="absolute inset-0 opacity-5"
                    style={{
                      backgroundImage: 'radial-gradient(circle at 25% 25%, white 1px, transparent 0)',
                      backgroundSize: '24px 24px',
                    }}
                  />
                  {/* Subtle background symbol */}
                  {set.images_symbol && (
                    <img
                      src={set.images_symbol}
                      alt=""
                      className="absolute inset-0 w-full h-full object-contain opacity-[0.04] scale-150 pointer-events-none"
                    />
                  )}

                  {set.images_logo ? (
                    <img
                      src={set.images_logo}
                      alt={set.name}
                      className="max-h-[80%] max-w-[75%] object-contain group-hover:scale-105 transition-transform duration-300 relative z-10"
                      loading="lazy"
                    />
                  ) : set.images_symbol ? (
                    <img
                      src={set.images_symbol}
                      alt={set.name}
                      className="h-12 object-contain opacity-60 group-hover:scale-110 transition-transform duration-300 relative z-10"
                      loading="lazy"
                    />
                  ) : (
                    <img src="/pokeball.svg" className="w-12 h-12 opacity-20 relative z-10" alt="" />
                  )}

                  {pct === 100 && (
                    <span className="absolute top-2 right-2 z-10 bg-green/20 text-green text-[10px] font-black px-2 py-0.5 rounded-full border border-green/30">
                      ★ {t('sets.filterComplete')}
                    </span>
                  )}
                </div>

                {/* Set info */}
                <div className="p-3">
                  <div className="flex items-start gap-1.5 mb-0.5">
                    <p className="font-bold text-text-primary text-sm leading-tight truncate flex-1">{set.name}</p>
                    {/* Language badge — always "de" or "en", never "both" */}
                    {set.lang && (
                      <span className={`flex-shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded leading-none ${
                        set.lang === 'de'
                          ? 'bg-yellow/20 text-yellow border border-yellow/30'
                          : 'bg-blue/20 text-blue-400 border border-blue-400/30'
                      }`}>
                        {set.lang.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-text-muted mb-0.5">
                    {set.series}
                    {set.total ? ` · ${set.total} ${t('sets.cards')}` : ''}
                  </p>
                  {set.release_date && (() => {
                    const d = new Date(set.release_date)
                    const label = isNaN(d.getTime()) ? set.release_date :
                      d.toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })
                    return <p className="text-[10px] text-text-muted mb-2">{label}</p>
                  })()}
                  {!set.release_date && <div className="mb-2.5" />}

                  {/* HP-style progress bar */}
                  <div className="flex items-center justify-between text-[10px] mb-1.5">
                    <span className="text-text-muted">{owned}/{total}</span>
                    <span className={`font-bold ${pct === 100 ? 'text-green' : 'text-text-secondary'}`}>
                      {pct}%
                    </span>
                  </div>
                  <div className="hp-bar-track">
                    <div
                      className={`hp-bar-fill ${owned > 0 ? hpClass : ''}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-12 text-text-muted">{t('sets.noSetsFound')}</div>
      )}
    </div>
  )
}
