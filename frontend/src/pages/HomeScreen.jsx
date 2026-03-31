import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  RefreshCw, TrendingUp, TrendingDown, Layers, Star, Wallet, LogOut,
  Search, Library, Grid2X2, BarChart3, Settings, Trophy,
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { getDashboard, triggerPriceSync, getSyncStatus, getInvestmentTracker } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import toast from 'react-hot-toast'
import { format, parseISO } from 'date-fns'
import { useTilt } from '../hooks/useTilt'
import { resolveCardImageUrl } from '../utils/imageUrl'
import CardImage from '../components/CardImage'

// Compact number formatter for mobile (1.2k, 3.4M, etc.)
function compactNum(n) {
  if (typeof n === 'string') return n // already formatted (e.g. price)
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return n.toLocaleString()
}

// ── Time-range definitions ────────────────────────────────────────────────────
const PERIODS = [
  { key: '1W',  label: '1W',   apiPeriod: '1w' },
  { key: '1M',  label: '1M',   apiPeriod: '1m' },
  { key: '1Y',  label: '1Y',   apiPeriod: '1y' },
  { key: 'MAX', label: 'Max',  apiPeriod: 'max' },
]

// ── Custom chart tooltip ──────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl px-3 py-2 text-xs shadow-xl"
      style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)' }}>
      <p className="text-text-muted mb-1">{label}</p>
      <p className="font-black" style={{ color: '#f5c842' }}>
        €{Number(payload[0].value).toFixed(2)}
      </p>
    </div>
  )
}

// ── Card thumbnail ────────────────────────────────────────────────────────────
function CardThumb({ card, onClick }) {
  const img = resolveCardImageUrl(card)
  const { ref, onMouseMove, onMouseEnter, onMouseLeave } = useTilt(8)
  return (
    <div ref={ref} className="flex-shrink-0 w-[110px] cursor-pointer group" onClick={onClick} onMouseMove={onMouseMove} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="aspect-[2.5/3.5] rounded-xl overflow-hidden shadow-lg transition-all duration-150
        group-hover:shadow-brand-red/20"
        style={{ border: '1px solid rgba(255,255,255,0.07)', boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}>
        <CardImage src={img} alt={card.name} className="w-full h-full object-cover" />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { formatPrice, t } = useSettings()
  const { user, logout, multiUser } = useAuth()
  const [chartPeriod, setChartPeriod] = useState('1M')

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => getDashboard().then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: syncStatus } = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus().then(r => r.data),
    refetchInterval: 15000,
  })

  // Portfolio history for chart — uses analytics/investment-tracker
  const activePeriod = PERIODS.find(p => p.key === chartPeriod)
  const { data: investmentData = [] } = useQuery({
    queryKey: ['investment-tracker', chartPeriod],
    queryFn: () => getInvestmentTracker({ period: activePeriod?.apiPeriod ?? 'max' }).then(r => r.data),
    refetchInterval: 120000,
  })

  const trainerName = user?.username || 'Trainer'

  const syncMutation = useMutation({
    mutationFn: triggerPriceSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 3000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  const isRunning = syncStatus?.is_running || syncStatus?.is_price_sync_running || syncMutation.isPending

  const totalValue = Number(data?.total_value ?? 0)
  const totalCost = Number(data?.total_cost ?? 0)
  const pnl = Number(data?.pnl ?? 0)
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0
  const pnlPositive = pnl >= 0
  const productsRealizedPnl = Number(data?.products_realized_pnl ?? 0)
  const productsSoldRevenue = Number(data?.products_sold_revenue ?? 0)
  const productsSoldCost = Number(data?.products_sold_cost ?? 0)
  // Net invested = cards cost + unsold products cost — i.e. money currently deployed
  const netInvested = totalCost

  const recentCards = data?.recent_additions?.slice(0, 12) ?? []
  const topCards = data?.top_cards?.slice(0, 8) ?? []

  // Map chart data — backend already filters and downsamples
  const chartData = useMemo(() => {
    const fmtMap = { '1W': 'EEE dd.MM', '1Y': 'MMM yy', 'MAX': 'MMM yy' }
    const dateFmt = fmtMap[chartPeriod] ?? 'dd.MM.'
    return (investmentData || []).map(d => ({
      date: format(parseISO(d.date), dateFmt),
      value: d.value,
    }))
  }, [investmentData, chartPeriod])

  // Determine chart color based on trend
  const chartColor = useMemo(() => {
    if (chartData.length < 2) return '#f5c842'
    const first = chartData[0]?.value ?? 0
    const last = chartData[chartData.length - 1]?.value ?? 0
    return last >= first ? '#66bb6a' : '#e3000b'
  }, [chartData])

  // Portal navigation items — defined inside component so t() works
  const PORTAL_ITEMS = [
    { to: '/collection', icon: Library,    label: t('nav.collection'),  color: '#4fc3f7' },
    { to: '/search',     icon: Search,     label: t('nav.cardSearch'),  color: '#ce93d8' },
    { to: '/sets',       icon: Grid2X2,    label: t('nav.sets'),        color: '#81c784' },
    { to: '/analytics',  icon: BarChart3,  label: t('nav.analytics'),   color: '#f5c842' },
    ...(multiUser ? [{ to: '/leaderboard', icon: Trophy, label: t('nav.leaderboard'), color: '#ffd54f' }] : []),
    { to: '/settings',   icon: Settings,   label: t('nav.settings'),    color: '#b0bec5' },
  ]

  const STAT_CARDS = [
    {
      icon: <Layers size={16} />,
      value: compactNum(data?.total_cards ?? 0),
      label: t('home.cardsTotal'),
      color: '#4fc3f7',
    },
    {
      icon: <Grid2X2 size={16} />,
      value: compactNum(data?.owned_sets ?? 0),
      label: t('home.sets'),
      color: '#ce93d8',
    },
    {
      icon: <Star size={16} />,
      value: compactNum(data?.unique_cards ?? 0),
      label: t('home.unique'),
      color: '#81c784',
    },
    {
      icon: <Wallet size={16} />,
      value: formatPrice(netInvested),
      label: t('home.invested'),
      color: '#f5c842',
    },
  ]

  return (
    <div className="min-h-dvh flex flex-col relative overflow-x-hidden">

      {/* Ambient orbs */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div style={{ position:'absolute', top:'3%', left:'8%', width:300, height:300, borderRadius:'50%',
          background:'radial-gradient(circle, rgba(227,0,11,0.07) 0%, transparent 70%)',
          animation:'float-orb 9s ease-in-out infinite' }} />
        <div style={{ position:'absolute', bottom:'12%', right:'4%', width:240, height:240, borderRadius:'50%',
          background:'radial-gradient(circle, rgba(79,195,247,0.06) 0%, transparent 70%)',
          animation:'float-orb 12s ease-in-out infinite reverse' }} />
      </div>

      <div className="relative z-10 flex flex-col gap-6 px-4 pt-6 pb-10">

        {/* ── TOP BAR: Logout + Sync ── */}
        <div className="flex items-center justify-between">
          {multiUser ? (
            <button
              onClick={() => { logout(); navigate('/login') }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-text-muted hover:text-brand-red transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <LogOut size={12} />
              {t('auth.logout')}
            </button>
          ) : (
            <div />
          )}
          {user?.role === 'admin' && (
          <button
            onClick={() => syncMutation.mutate()}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all"
            style={{
              background: isRunning ? 'rgba(255,255,255,0.05)' : 'rgba(227,0,11,0.12)',
              color: isRunning ? '#888' : '#e3000b',
              border: isRunning ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(227,0,11,0.25)',
            }}
          >
            <RefreshCw size={12} className={isRunning ? 'animate-spin' : ''} />
            {isRunning ? t('home.syncing') : t('home.sync')}
          </button>
          )}
        </div>

        {/* ── PORTFOLIO VALUE (large, prominent) ── */}
        <div className="text-center -mt-2">
          {/* Trainer greeting */}
          <div className="mb-1 flex items-center justify-center gap-2 truncate max-w-[90vw] mx-auto">
            {user?.avatar_id ? (
              <img
                src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${user.avatar_id}.gif`}
                alt={`${trainerName} avatar`}
                className="h-6 w-6 pixelated"
              />
            ) : null}
            <p className="text-sm font-semibold truncate" style={{ color: 'rgba(255,255,255,0.55)' }}>
              {t('home.hello')}, <span className="font-black" style={{ color: '#f5c842' }}>{trainerName}</span>! 👋
            </p>
          </div>
          <p className="text-[11px] text-text-muted uppercase tracking-[0.2em] mb-2">{t('home.portfolioValue')}</p>
          {isLoading ? (
            <div className="skeleton h-14 w-48 mx-auto rounded-xl" />
          ) : (
            <p className="text-4xl sm:text-5xl font-black tracking-tight"
              style={{ color: '#f5c842', textShadow: '0 0 40px rgba(245,200,66,0.25)' }}>
              {formatPrice(totalValue)}
            </p>
          )}

          {/* ── G&V ── */}
          {!isLoading && (
            <div className="flex flex-col items-center gap-1.5 mt-3">
              <div className="flex items-center gap-2">
                <div
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-black"
                  style={{
                    background: pnlPositive ? 'rgba(102,187,106,0.12)' : 'rgba(227,0,11,0.12)',
                    border: `1px solid ${pnlPositive ? 'rgba(102,187,106,0.3)' : 'rgba(227,0,11,0.3)'}`,
                    color: pnlPositive ? '#66bb6a' : '#e3000b',
                  }}
                >
                  {pnlPositive
                    ? <TrendingUp size={15} />
                    : <TrendingDown size={15} />
                  }
                  <span>
                    {pnlPositive ? '+' : ''}{formatPrice(pnl)}
                  </span>
                  {totalCost > 0 && (
                    <span className="opacity-75">
                      ({pnlPositive ? '+' : ''}{pnlPct.toFixed(1)}%)
                    </span>
                  )}
                </div>
              </div>
              {/* Realized P&L badge from sold products */}
              {productsSoldRevenue > 0 && (
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[10px] font-semibold px-2.5 py-1 rounded-full"
                    style={{
                      background: productsRealizedPnl >= 0 ? 'rgba(102,187,106,0.1)' : 'rgba(227,0,11,0.1)',
                      border: `1px solid ${productsRealizedPnl >= 0 ? 'rgba(102,187,106,0.25)' : 'rgba(227,0,11,0.25)'}`,
                      color: productsRealizedPnl >= 0 ? '#66bb6a' : '#e3000b',
                    }}
                  >
                    {t('common.sold')}: {formatPrice(productsSoldRevenue)} ({productsRealizedPnl >= 0 ? '+' : ''}{formatPrice(productsRealizedPnl)})
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="h-px bg-gradient-to-r from-transparent via-brand-red/30 to-transparent" />

        {/* ── STAT CARDS ROW ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {STAT_CARDS.map(stat => (
            <div
              key={stat.label}
              className="rounded-2xl p-3 flex flex-col items-center text-center gap-1.5"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.07)',
              }}
            >
              <span style={{ color: stat.color }}>{stat.icon}</span>
              <p className="text-sm sm:text-base font-black leading-none truncate max-w-full" style={{ color: stat.color }}>
                {isLoading ? '—' : stat.value}
              </p>
              <p className="text-[10px] text-text-muted leading-tight">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* ── PORTFOLIO CHART ── */}
        <div className="rounded-2xl p-4"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>

          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold text-white uppercase tracking-wider">{t('home.portfolioHistory')}</p>
            <div className="flex gap-1">
              {PERIODS.map(p => (
                <button
                  key={p.key}
                  onClick={() => setChartPeriod(p.key)}
                  className="px-2 py-1 rounded-lg text-[10px] font-bold transition-all"
                  style={{
                    background: chartPeriod === p.key ? 'rgba(245,200,66,0.15)' : 'rgba(255,255,255,0.04)',
                    color: chartPeriod === p.key ? '#f5c842' : '#666',
                    border: chartPeriod === p.key ? '1px solid rgba(245,200,66,0.3)' : '1px solid transparent',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Chart area */}
          {chartData.length < 2 ? (
            <div className="flex flex-col items-center justify-center h-24 gap-2">
              <BarChart3 size={24} style={{ color: 'rgba(255,255,255,0.15)' }} />
              <p className="text-[11px] text-text-muted">{t('home.noData')}</p>
              <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
                {t('home.startSyncHint')}
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColor} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: 'rgba(255,255,255,0.12)', strokeWidth: 1 }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={chartColor}
                  strokeWidth={2}
                  fill="url(#chartGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: chartColor, stroke: 'none' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── NAVIGATION PORTAL GRID ── */}
        <div>
          <p className="text-xs font-bold text-white uppercase tracking-wider mb-3">{t('home.navigation')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {PORTAL_ITEMS.map(({ to, icon: Icon, label, color }) => (
              <button
                key={to}
                onClick={() => navigate(to)}
                className="flex flex-col items-center gap-2 py-4 px-2 rounded-2xl transition-all
                  active:scale-95 group"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.07)',
                }}
              >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center transition-all
                  group-hover:scale-110"
                  style={{
                    background: `${color}18`,
                    border: `1px solid ${color}30`,
                  }}>
                  <Icon size={18} style={{ color }} />
                </div>
                <span className="text-[10px] font-semibold text-center leading-tight"
                  style={{ color: 'rgba(255,255,255,0.65)' }}>
                  {label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ── RECENTLY ADDED ── */}
        {recentCards.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-bold text-white uppercase tracking-wider">{t('home.recentlyAdded')}</p>
              <button onClick={() => navigate('/collection')}
                className="text-[11px] font-semibold hover:opacity-80 transition-opacity"
                style={{ color:'#e3000b' }}>{t('home.viewAll')} →</button>
            </div>
            <div className="flex gap-2.5 overflow-x-auto pb-1 no-scrollbar -mx-4 px-4">
              {recentCards.map(card => (
                <CardThumb key={card.id} card={card} onClick={() => navigate('/collection')} />
              ))}
            </div>
          </div>
        )}

        {/* ── TOP VALUABLE CARDS ── */}
        {topCards.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-bold text-white uppercase tracking-wider">{t('home.topCards')}</p>
              <button onClick={() => navigate('/analytics')}
                className="text-[11px] font-semibold hover:opacity-80 transition-opacity"
                style={{ color:'#f5c842' }}>{t('home.details')} →</button>
            </div>
            <div className="flex gap-2.5 overflow-x-auto pb-1 no-scrollbar -mx-4 px-4">
              {topCards.map((card, i) => (
                <div key={card.id} className="flex-shrink-0 w-[110px] cursor-pointer group"
                  onClick={() => navigate('/collection')}>
                  <div className="relative">
                    <div className="aspect-[2.5/3.5] rounded-xl overflow-hidden shadow-lg transition-all duration-150
                      group-hover:scale-[1.03]"
                      style={{ border:'1px solid rgba(245,200,66,0.2)', boxShadow:'0 4px 16px rgba(0,0,0,0.5)' }}>
                      <CardImage src={resolveCardImageUrl(card)} alt={card.name} className="w-full h-full object-cover" />
                    </div>
                    <span className="absolute top-1 left-1 text-[9px] font-black px-1 rounded leading-4"
                      style={{ background:'rgba(0,0,0,0.85)', color:'#f5c842' }}>#{i+1}</span>
                  </div>
                  <p className="text-[10px] font-bold mt-1 truncate" style={{ color:'#f5c842' }}>
                    {formatPrice(Number(card.total_value ?? 0))}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
