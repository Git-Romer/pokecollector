import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, AreaChart
} from 'recharts'
import { TrendingUp, TrendingDown, BarChart3, ShoppingBag, LayoutDashboard } from 'lucide-react'
import { getDashboard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { format, parseISO } from 'date-fns'
import PeriodSelector, { CARD_PERIODS, PERIOD_PRICE_FIELD } from '../components/PeriodSelector'
import TrainerCard from '../components/TrainerCard'
import PokeBallLoader from '../components/PokeBallLoader'
import TabNav from '../components/TabNav'
import { resolveCardImageUrl } from '../utils/imageUrl'

const CustomTooltip = ({ active, payload, label }) => {
  const { formatPrice } = useSettings()
  if (active && payload && payload.length) {
    return (
      <div className="bg-bg-surface border border-border rounded-lg p-3 text-sm shadow-xl">
        <p className="text-text-muted mb-1">{label}</p>
        {payload.map((entry, i) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {formatPrice(entry.value)}
          </p>
        ))}
      </div>
    )
  }
  return null
}

export default function Dashboard() {
  const { t, formatPrice } = useSettings()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [period, setPeriod] = useState('total')
  const ANALYTICS_TABS = [
    { to: '/analytics', label: t('nav.analytics'), icon: BarChart3 },
    { to: '/products', label: t('nav.products'), icon: ShoppingBag },
    { to: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
  ]

  const priceField = PERIOD_PRICE_FIELD[period] || 'price_trend'

  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', priceField],
    queryFn: () => getDashboard({ price_field: priceField }).then(r => r.data),
    refetchInterval: 60000,
  })

  if (isLoading) {
    return (
      <div className="space-y-5 animate-pulse pb-4">
        <TabNav tabs={ANALYTICS_TABS} />
        {/* Trainer card skeleton */}
        <div className="rounded-2xl overflow-hidden border-2 border-gold/20" style={{ background: 'linear-gradient(135deg, #1a2040, #0d1530)' }}>
          <div className="h-9 bg-brand-red/70" />
          <div className="p-4 space-y-3">
            <div className="flex gap-4">
              <div className="skeleton w-20 h-24 rounded-xl" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-6 w-32 rounded" />
                <div className="skeleton h-3 w-16 rounded" />
                <div className="skeleton h-3 w-full rounded mt-2" />
                <div className="skeleton h-3 w-full rounded" />
                <div className="skeleton h-3 w-full rounded" />
              </div>
            </div>
            <div className="skeleton h-2 rounded-full w-full mt-2" />
          </div>
        </div>
        <div className="skeleton h-36 rounded-2xl" />
        <div className="grid grid-cols-3 gap-2">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-20 rounded-xl" />)}
        </div>
        <div className="skeleton h-56 rounded-2xl" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-5 pb-2">
        <TabNav tabs={ANALYTICS_TABS} />
        <div className="card text-center py-12">
          <PokeBallLoader size={48} className="mb-4 opacity-40" />
          <p className="text-brand-red">{t('dashboard.backendError')}</p>
        </div>
      </div>
    )
  }

  const valueHistory = data?.value_history || []
  const chartData = valueHistory.map(item => ({
    date: format(parseISO(item.date), 'MMM d'),
    value: item.value,
    cost: item.cost,
  }))

  const pnl = data?.pnl || 0
  const pnlPct = data?.total_cost > 0 ? (pnl / data.total_cost * 100) : 0
  const totalValue = data?.total_value || 0
  const totalCards = data?.total_cards || 0
  const uniqueCards = data?.unique_cards || 0
  const ownedSets = data?.owned_sets || 0
  const totalSets = data?.total_sets || 0

  return (
    <div className="space-y-5 pb-2">
      <TabNav tabs={ANALYTICS_TABS} />

      {/* ─── 1. TRAINER CARD HERO ──────────────────────────────────── */}
      {data && (
        <TrainerCard
          trainerName={user?.username || "Trainer"}
          totalCards={totalCards}
          totalValue={totalValue}
          collectedSets={ownedSets}
          totalSets={totalSets}
          weeklyGain={data.weekly_additions || 0}
          gainLoss={pnl}
        />
      )}

      {/* ─── 2. RECENTLY ADDED CAROUSEL ────────────────────────────── */}
      {data?.recent_additions?.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-text-primary uppercase tracking-wider">
              {t('dashboard.recentAdditions')}
            </h2>
            <button
              onClick={() => navigate('/collection')}
              className="text-xs text-brand-red font-semibold hover:text-brand-red/80 transition-opacity"
            >
              Alle →
            </button>
          </div>
          <div className="flex gap-2.5 overflow-x-auto pb-2 no-scrollbar -mx-4 px-4">
            {data.recent_additions.slice(0, 12).map(card => (
              <div key={card.id} className="flex-shrink-0 w-20 group cursor-pointer">
                <div className="aspect-[2.5/3.5] rounded-lg overflow-hidden shadow-lg ring-1 ring-white/5 group-hover:ring-brand-red/50 group-hover:scale-[1.03] transition-all duration-150 transform-gpu origin-center">
                  {resolveCardImageUrl(card)
                    ? <img src={resolveCardImageUrl(card)} alt={card.name} className="w-full h-full object-cover" loading="lazy" />
                    : <div className="w-full h-full bg-bg-elevated flex items-center justify-center">
                        <span className="text-[9px] text-text-muted text-center p-1 leading-tight">{card.name}</span>
                      </div>
                  }
                </div>
                {card.price_market > 0 && (
                  <p className="text-[10px] font-bold text-gold mt-1 truncate">
                    {formatPrice(card.price_market)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── 3. STATS ROW ──────────────────────────────────────────── */}
      {data && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: t('dashboard.totalCards'), value: totalCards.toLocaleString() },
            { label: t('dashboard.collectionValue'), value: formatPrice(Number(totalValue)), gold: true },
            { label: t('dashboard.sets'), value: `${ownedSets}/${totalSets}` },
          ].map(stat => (
            <div key={stat.label} className="bg-bg-card border border-border rounded-xl p-3 text-center">
              <p className={`text-xl font-black leading-none ${stat.gold ? 'text-gold' : 'text-white'}`}>
                {stat.value}
              </p>
              <p className="text-[10px] text-text-muted uppercase tracking-wider mt-1">{stat.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ─── 4. TOP VALUABLE CARDS CAROUSEL ────────────────────────── */}
      {data?.top_cards?.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-text-primary uppercase tracking-wider">
              {t('dashboard.topValuable')}
            </h2>
            <div className="flex-shrink-0">
              <PeriodSelector value={period} onChange={setPeriod} periods={CARD_PERIODS} />
            </div>
          </div>
          <div className="flex gap-2.5 overflow-x-auto pb-2 no-scrollbar -mx-4 px-4">
            {data.top_cards.slice(0, 10).map((card, i) => (
              <div key={card.id} className="flex-shrink-0 w-24 group cursor-pointer">
                <div className="relative">
                  <div className="aspect-[2.5/3.5] rounded-lg overflow-hidden shadow-lg ring-1 ring-white/5 group-hover:scale-[1.03] transition-all duration-150 group-hover:ring-gold/40 transform-gpu origin-center">
                    {resolveCardImageUrl(card)
                      ? <img src={resolveCardImageUrl(card)} alt={card.name} className="w-full h-full object-cover" loading="lazy" />
                      : <div className="w-full h-full bg-bg-elevated" />
                    }
                  </div>
                  <span className="absolute top-1 left-1 bg-black/80 text-gold text-[9px] font-black rounded px-1 leading-4">
                    #{i + 1}
                  </span>
                </div>
                <p className="text-[10px] text-gold font-bold mt-1 truncate">
                  {formatPrice(Number(card.total_value || 0))}
                </p>
                {card.quantity > 1 && (
                  <p className="text-[9px] text-text-muted">{card.quantity}×</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ─── 5. P&L SUMMARY ────────────────────────────────────────── */}
      {data && (data.total_cost > 0 || pnl !== 0) && (
        <div className="bg-bg-card border border-border rounded-xl p-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">{t('dashboard.invested')}</p>
              <p className="text-lg font-black text-white">{formatPrice(data.total_cost || 0)}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">{t('dashboard.collectionValue')}</p>
              <p className="text-lg font-black text-gold">{formatPrice(Number(totalValue))}</p>
            </div>
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">P&amp;L</p>
              <p className={`text-lg font-black flex items-center gap-1 ${pnl >= 0 ? 'text-green' : 'text-brand-red'}`}>
                {pnl >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                {pnl >= 0 ? '+' : ''}{formatPrice(pnl)}
                <span className="text-[11px] font-normal opacity-70">
                  ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)
                </span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ─── 6. PORTFOLIO CHART ─────────────────────────────────────── */}
      <section>
        <div className="bg-bg-card border border-border rounded-2xl p-4">
          <h2 className="text-sm font-bold text-text-primary uppercase tracking-wider mb-4">
            {t('dashboard.portfolioHistory')}
          </h2>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="valueGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#EF1515" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#EF1515" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6b7280" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#6b7280" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                <XAxis dataKey="date" tick={{ fill: '#606078', fontSize: 11 }} />
                <YAxis tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={(v) => formatPrice(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type="monotone"
                  dataKey="cost"
                  name={t('dashboard.cost')}
                  stroke="#6b7280"
                  fill="url(#costGradient)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  name={t('dashboard.value')}
                  stroke="#EF1515"
                  fill="url(#valueGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-text-muted">
              <div className="text-center">
                <PokeBallLoader size={48} className="mb-3 opacity-30" />
                <p>{t('dashboard.noPriceHistory')}</p>
                <p className="text-xs mt-1">{t('dashboard.syncToStart')}</p>
              </div>
            </div>
          )}
        </div>
      </section>

    </div>
  )
}
