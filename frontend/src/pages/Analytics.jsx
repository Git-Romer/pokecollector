import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area
} from 'recharts'
import { TrendingUp, TrendingDown, Copy, BarChart3, Activity, Plus, X, ShoppingCart } from 'lucide-react'
import {
  getDuplicates, getTopMovers, getRarityStats,
  getInvestmentTracker, getAnalyticsNewSets, getProducts, createProduct
} from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import CardListItem from '../components/CardListItem'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'
import PeriodSelector, { CARD_PERIODS, PERIOD_DAYS } from '../components/PeriodSelector'
import toast from 'react-hot-toast'

const RARITY_COLORS = [
  '#EF1515', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

const PRODUCT_TYPES = ['Booster Pack', 'Booster Box', 'Elite Trainer Box', 'Tin', 'Bundle', 'Collection Box', 'Blister', 'Other']

function CustomTooltip({ active, payload, label }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-bg-surface border border-border rounded-lg p-3 text-sm shadow-xl">
        <p className="text-text-muted mb-1">{label}</p>
        {payload.map((entry, i) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {typeof entry.value === 'number'
              ? (entry.name.includes('€') || ['Value', 'Cost', 'P&L', 'Wert', 'Kosten', 'G&V'].includes(entry.name)
                ? `€${entry.value.toFixed(2)}`
                : entry.value)
              : entry.value}
          </p>
        ))}
      </div>
    )
  }
  return null
}

function AddExpenseModal({ onClose, onSuccess }) {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [productType, setProductType] = useState('Booster Pack')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const queryClient = useQueryClient()

  const { t } = useSettings()
  const mutation = useMutation({
    mutationFn: (data) => createProduct(data),
    onSuccess: () => {
      toast.success(t('analytics.expenseSaved'))
      queryClient.invalidateQueries({ queryKey: ['investment-tracker'] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
      onSuccess && onSuccess()
      onClose()
    },
    onError: () => toast.error(t('analytics.expenseSaveError')),
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!amount || parseFloat(amount) <= 0) return
    mutation.mutate({
      product_name: description.trim() || productType,
      product_type: productType,
      purchase_price: parseFloat(amount),
      purchase_date: date,
      notes: description.trim() || null,
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center md:bg-black/80 md:backdrop-blur-sm"
      onClick={onClose}>
      <div className={[
        'w-full rounded-t-2xl max-h-[90dvh] overflow-y-auto',
        'bg-bg-surface border-t border-border',
        'md:rounded-2xl md:border md:max-w-md md:max-h-[80vh]',
      ].join(' ')} onClick={e => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <ShoppingCart size={18} className="text-brand-red" />
              <h2 className="text-lg font-bold text-text-primary">{t('analytics.logExpense')}</h2>
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
              <X size={20} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">
                {t('analytics.amountLabel')} <span className="text-brand-red">*</span>
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                placeholder="z.B. 4.99"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">{t('products.productType')}</label>
              <select value={productType} onChange={e => setProductType(e.target.value)} className="select">
                {PRODUCT_TYPES.map(pt => <option key={pt} value={pt}>{pt}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">{t('common.date')}</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">{t('analytics.descriptionOptional')}</label>
              <input
                type="text"
                placeholder="z.B. 10x Booster Scarlet & Violet"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="input"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={mutation.isPending || !amount} className="btn-primary flex-1">
                <Plus size={16} /> {mutation.isPending ? t('analytics.saving') : t('analytics.saveExpense')}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

export default function Analytics() {
  const { t, formatPrice } = useSettings()
  const [moversPeriod, setMoversPeriod] = useState('7d')
  const [activeTab, setActiveTab] = useState('duplicates')
  const [showExpenseModal, setShowExpenseModal] = useState(false)
  const queryClient = useQueryClient()

  const { data: duplicates = [], isLoading: dupLoading } = useQuery({
    queryKey: ['duplicates'],
    queryFn: () => getDuplicates().then(r => r.data),
  })

  const moversDay = PERIOD_DAYS[moversPeriod] || 7
  const { data: topMovers = [], isLoading: moversLoading } = useQuery({
    queryKey: ['top-movers', moversDay],
    queryFn: () => getTopMovers(moversDay).then(r => r.data),
  })

  const { data: rarityStats = [], isLoading: rarityLoading } = useQuery({
    queryKey: ['rarity-stats'],
    queryFn: () => getRarityStats().then(r => r.data),
  })

  const { data: investmentData = [], isLoading: investLoading } = useQuery({
    queryKey: ['investment-tracker'],
    queryFn: () => getInvestmentTracker().then(r => r.data),
  })

  const { data: products = [] } = useQuery({
    queryKey: ['products'],
    queryFn: () => getProducts().then(r => r.data),
  })

  const { data: newSets = [] } = useQuery({
    queryKey: ['analytics-new-sets'],
    queryFn: () => getAnalyticsNewSets().then(r => r.data),
  })

  const tabs = [
    { key: 'duplicates', label: t('analytics.duplicates'), icon: Copy },
    { key: 'movers', label: t('analytics.topMovers'), icon: TrendingUp },
    { key: 'rarity', label: t('analytics.rarityStats'), icon: BarChart3 },
    { key: 'investment', label: t('analytics.investment'), icon: Activity },
  ]

  const chartData = investmentData.map(s => ({
    date: format(parseISO(s.date), 'MMM d'),
    value: s.value,
    cost: s.cost,
    pnl: s.pnl,
  }))

  // Investment summary
  const latestSnapshot = investmentData.length > 0 ? investmentData[investmentData.length - 1] : null
  const soldProducts = products.filter(p => p.sold_price != null)
  const unsoldProducts = products.filter(p => p.sold_price == null)
  const totalProductsCost = unsoldProducts.reduce((sum, p) => sum + (p.purchase_price || 0), 0)
  const totalSoldRevenue = soldProducts.reduce((sum, p) => sum + (p.sold_price || 0), 0)
  const totalSoldCost = soldProducts.reduce((sum, p) => sum + (p.purchase_price || 0), 0)
  const realizedPnl = totalSoldRevenue - totalSoldCost
  const unrealizedPnl = (latestSnapshot?.value ?? 0) - (latestSnapshot?.cost ?? 0)

  return (
    <div className="space-y-4 pb-2">
      <div>
        <h1 className="text-xl font-bold text-text-primary">{t('analytics.title')}</h1>
        <p className="text-sm text-text-secondary mt-1">{t('analytics.subtitle')}</p>
      </div>

      {newSets.length > 0 && (
        <div className="card border-yellow/30 bg-yellow/5">
          <p className="text-sm font-medium text-yellow">
            🆕 {newSets.length} {newSets.length === 1 ? t('analytics.newSet') : t('analytics.newSets')} {t('analytics.newSetsDetected')}: {newSets.map(s => s.name).join(', ')}
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="overflow-x-auto border-b border-border pb-1 -mx-1 px-1">
        <div className="flex gap-2 min-w-max">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-t-lg text-sm font-medium transition-all',
                activeTab === key
                  ? 'bg-brand-red/20 text-brand-red border-b-2 border-brand-red'
                  : 'text-text-secondary hover:text-text-primary'
              )}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* Duplicates Tab */}
      {activeTab === 'duplicates' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">{t('analytics.duplicatesDesc')}</p>
          {dupLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : duplicates.length === 0 ? (
            <div className="card text-center py-12 text-text-muted">{t('analytics.noDuplicates')}</div>
          ) : (
            <div className="card p-0 overflow-hidden">
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-bg/50">
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('analytics.card')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.set')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.rarity')}</th>
                      <th className="text-center px-4 py-3 text-text-muted font-medium">{t('analytics.qty')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('analytics.market')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('analytics.totalValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicates.map((item) => (
                      <tr key={item.id} className="border-b border-border/50 hover:bg-bg-elevated/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            {item.images_small && (
                              <img src={item.images_small} alt={item.name} className="w-8 h-10 object-cover rounded flex-shrink-0" loading="lazy" />
                            )}
                            <span className="text-sm font-medium text-text-primary">{item.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{item.set_name || '-'}</td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{item.rarity || '-'}</td>
                        <td className="px-4 py-3 text-center font-bold text-brand-red">{item.quantity}x</td>
                        <td className="px-4 py-3 text-right text-text-primary">€{item.price_market?.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right font-bold text-green">€{item.total_value?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden space-y-2 p-2">
                {duplicates.map((item) => (
                  <CardListItem
                    key={item.id}
                    image={item.images_small}
                    name={item.name}
                    subtext={item.set_name || '-'}
                    badges={[
                      { label: `${item.quantity}x`, variant: 'red' },
                      ...(item.rarity ? [{ label: item.rarity, variant: 'gray' }] : []),
                    ]}
                    value={`€${item.total_value?.toFixed(2)}`}
                    valueSecondary={`€${item.price_market?.toFixed(2)}`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Top Movers Tab */}
      {activeTab === 'movers' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-sm text-text-secondary">{t('analytics.moversDesc')} {moversDay} {t('analytics.days')}</p>
            <PeriodSelector value={moversPeriod} onChange={setMoversPeriod} periods={CARD_PERIODS} />
          </div>
          {moversLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : topMovers.length === 0 ? (
            <div className="card text-center py-12 text-text-muted">{t('analytics.noMovers')}</div>
          ) : (
            <div className="space-y-2">
              {topMovers.map((card) => (
                <div key={card.card_id} className="card flex items-center gap-4">
                  {card.images_small && (
                    <img src={card.images_small} alt={card.name} className="w-10 h-14 object-cover rounded flex-shrink-0" loading="lazy" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{card.name}</p>
                    <p className="text-xs text-text-muted">{card.rarity}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm text-text-secondary">€{card.old_price?.toFixed(2)} → €{card.current_price?.toFixed(2)}</p>
                    <div className={clsx(
                      'flex items-center justify-end gap-1 font-bold',
                      card.change_pct >= 0 ? 'text-green' : 'text-brand-red'
                    )}>
                      {card.change_pct >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      {card.change_pct >= 0 ? '+' : ''}{card.change_pct}%
                      <span className="text-xs font-normal ml-1">
                        ({card.change_abs >= 0 ? '+' : ''}€{card.change_abs?.toFixed(2)})
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rarity Stats Tab */}
      {activeTab === 'rarity' && (
        <div className="space-y-4">
          {rarityLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : rarityStats.length === 0 ? (
            <div className="card text-center py-12 text-text-muted">{t('analytics.noRarityStats')}</div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.byCount')}</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={rarityStats} dataKey="count" nameKey="rarity" cx="50%" cy="50%" outerRadius={100}
                      label={({ rarity, percentage }) => `${percentage}%`}>
                      {rarityStats.map((_, i) => <Cell key={i} fill={RARITY_COLORS[i % RARITY_COLORS.length]} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: '#1e1e2e', border: '1px solid #2a2a3d', borderRadius: '8px', color: '#fff' }}
                      labelStyle={{ color: '#fff' }}
                      itemStyle={{ color: '#fff' }}
                      formatter={(val, name) => [val, t('analytics.count')]}
                    />
                    <Legend wrapperStyle={{ color: '#a0a0b8' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.byValue')}</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={rarityStats} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => `€${v}`} />
                    <YAxis dataKey="rarity" type="category" tick={{ fill: '#606078', fontSize: 10 }} width={100} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="total_value" name={t('analytics.value')} radius={[0, 4, 4, 0]}>
                      {rarityStats.map((_, i) => <Cell key={i} fill={RARITY_COLORS[i % RARITY_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Table */}
              <div className="card lg:col-span-2">
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 text-text-muted">{t('common.rarity')}</th>
                        <th className="text-right py-2 text-text-muted">{t('analytics.count')}</th>
                        <th className="text-right py-2 text-text-muted">{t('analytics.percentage')}</th>
                        <th className="text-right py-2 text-text-muted">{t('analytics.totalValue')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rarityStats.map((r, i) => (
                        <tr key={r.rarity} className="border-b border-border/30 hover:bg-bg-elevated/50">
                          <td className="py-2 flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: RARITY_COLORS[i % RARITY_COLORS.length] }} />
                            <span className="text-text-primary">{r.rarity}</span>
                          </td>
                          <td className="py-2 text-right text-text-secondary">{r.count}</td>
                          <td className="py-2 text-right text-text-secondary">{r.percentage}%</td>
                          <td className="py-2 text-right text-green font-medium">€{r.total_value?.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sm:hidden space-y-2">
                  {rarityStats.map((r, i) => (
                    <div key={r.rarity} className="flex items-center gap-3 py-2 border-b border-border/30">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: RARITY_COLORS[i % RARITY_COLORS.length] }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">{r.rarity}</p>
                        <p className="text-xs text-text-secondary">{r.count} · {r.percentage}%</p>
                      </div>
                      <p className="text-green font-medium text-sm flex-shrink-0">€{r.total_value?.toFixed(2)}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Investment Tracker Tab */}
      {activeTab === 'investment' && (
        <div className="space-y-4">
          {/* Header with expense button */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm text-text-secondary">{t('analytics.portfolioDesc')}</p>
              {latestSnapshot && (
                <p className="text-xs text-text-muted mt-0.5">
                  {t('analytics.current')}: <span className="text-green font-bold">{formatPrice(latestSnapshot.value)}</span>
                  {' · '}{t('dashboard.invested')}: <span className="text-text-primary font-medium">{formatPrice(latestSnapshot.cost)}</span>
                  {totalProductsCost > 0 && (
                    <> · {t('analytics.products')}: <span className="text-yellow font-medium">{formatPrice(totalProductsCost)}</span></>
                  )}
                </p>
              )}
            </div>
            <button
              onClick={() => setShowExpenseModal(true)}
              className="btn-ghost text-sm py-1.5 border-green/30 text-green hover:bg-green/10"
            >
              <ShoppingCart size={14} /> {t('analytics.logExpense')}
            </button>
          </div>

          {/* Summary stats — Gesamt-Investiert, Verkaufserlöse, Realisierter G&V, Unrealisierter G&V */}
          {(products.length > 0 || latestSnapshot) && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: t('analytics.totalInvested'), value: formatPrice((latestSnapshot?.cost ?? 0) + totalSoldCost), color: '#90a4ae' },
                { label: t('analytics.totalSoldRevenue'), value: formatPrice(totalSoldRevenue), color: '#66bb6a' },
                { label: t('analytics.realizedPnl'), value: formatPrice(realizedPnl), color: realizedPnl >= 0 ? '#66bb6a' : '#e3000b' },
                { label: t('analytics.unrealizedPnl'), value: formatPrice(unrealizedPnl), color: unrealizedPnl >= 0 ? '#66bb6a' : '#e3000b' },
              ].map(stat => (
                <div key={stat.label} className="rounded-xl p-3 text-center"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <p className="text-xs text-text-muted mb-1 leading-tight">{stat.label}</p>
                  <p className="text-sm font-black" style={{ color: stat.color }}>{stat.value}</p>
                </div>
              ))}
            </div>
          )}

          {investLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : chartData.length === 0 ? (
            <div className="card text-center py-12 space-y-3">
              <p className="text-text-muted">{t('analytics.noInvestmentData')}</p>
              <button onClick={() => setShowExpenseModal(true)} className="btn-ghost text-green border-green/30 hover:bg-green/10 mx-auto text-sm">
                <ShoppingCart size={14} /> {t('analytics.logFirst')}
              </button>
            </div>
          ) : (
            <>
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.portfolioValue')}</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="valueGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#EF1515" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#EF1515" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#606078" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#606078" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                    <XAxis dataKey="date" tick={{ fill: '#606078', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => `€${v}`} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Area type="monotone" dataKey="cost" name={t('analytics.cost')} stroke="#606078" fill="url(#costGrad)" strokeWidth={1.5} strokeDasharray="4 4" />
                    <Area type="monotone" dataKey="value" name={t('analytics.value')} stroke="#EF1515" fill="url(#valueGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.pnlOverTime')}</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                    <XAxis dataKey="date" tick={{ fill: '#606078', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => `€${v}`} />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="pnl" name={t('analytics.pnl')} radius={[4, 4, 0, 0]}>
                      {chartData.map((entry, i) => (
                        <Cell key={i} fill={entry.pnl >= 0 ? '#22c55e' : '#EF1515'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Product purchases list */}
              {products.length > 0 && (
                <div className="card">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-text-primary">{t('analytics.loggedExpenses')}</h3>
                    <button onClick={() => setShowExpenseModal(true)} className="btn-ghost text-xs py-1 px-2 text-green border-green/30">
                      <Plus size={12} /> {t('common.new')}
                    </button>
                  </div>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {products.sort((a,b) => new Date(b.purchase_date) - new Date(a.purchase_date)).map(p => {
                      const isSold = p.sold_price != null
                      const pnl = isSold ? (p.sold_price - p.purchase_price) : ((p.current_value || 0) - p.purchase_price)
                      const pnlPositive = pnl >= 0

                      return (
                        <div key={p.id} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary truncate">{p.product_name}</p>
                            <p className="text-xs text-text-muted">
                              {p.product_type} · {p.purchase_date}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                            {isSold ? (
                              <span className="text-xs bg-green/20 text-green px-1.5 py-0.5 rounded">{t('analytics.statusSold')}</span>
                            ) : (
                              <span className="text-xs bg-blue/20 text-blue-400 px-1.5 py-0.5 rounded">{t('analytics.statusOwned')}</span>
                            )}
                            {isSold ? (
                              <span className="text-sm text-text-secondary">{t('analytics.soldFor')} {formatPrice(p.sold_price)}</span>
                            ) : (
                              <span className="text-sm text-text-secondary">{t('products.currentValueLabel')} {formatPrice(p.current_value || 0)}</span>
                            )}
                            {pnl != 0 && (
                              <span className={clsx(
                                'text-xs px-1.5 py-0.5 rounded',
                                pnlPositive ? 'bg-green/20 text-green' : 'bg-brand-red/20 text-brand-red'
                              )}>
                                {pnlPositive ? '+' : ''}{formatPrice(pnl)} {pnlPositive ? t('analytics.profit') : t('common.loss')}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="border-t border-border pt-2 mt-2 flex justify-between text-sm">
                    <span className="text-text-muted">{t('analytics.totalInvestedProducts')}</span>
                    <span className="font-bold text-brand-red">{formatPrice(totalProductsCost + totalSoldCost)}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showExpenseModal && (
        <AddExpenseModal
          onClose={() => setShowExpenseModal(false)}
          onSuccess={() => queryClient.invalidateQueries({ queryKey: ['investment-tracker'] })}
        />
      )}
    </div>
  )
}
