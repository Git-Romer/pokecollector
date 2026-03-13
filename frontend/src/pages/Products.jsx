import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts'
import { Plus, Trash2, Edit2, TrendingUp, TrendingDown, Package, Check, X, SortAsc, Filter, ChevronUp, ChevronDown, BarChart3, ShoppingBag, LayoutDashboard } from 'lucide-react'
import { getProducts, createProduct, updateProduct, deleteProduct, getProductsSummary } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import CardListItem from '../components/CardListItem'
import PeriodSelector, { PRODUCT_PERIODS, getPeriodCutoff } from '../components/PeriodSelector'
import TabNav from '../components/TabNav'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const PRODUCT_TYPES = ['Booster Pack', 'Booster Box', 'Elite Trainer Box', 'Tin', 'Bundle', 'Collection Box', 'Blister', 'Other']

function ProductForm({ initial = {}, onSubmit, onCancel, loading }) {
  const { t } = useSettings()
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState({
    product_name: initial.product_name || '',
    product_type: initial.product_type || 'Booster Pack',
    purchase_price: initial.purchase_price || '',
    current_value: initial.current_value || '',
    sold_price: initial.sold_price || '',
    purchase_date: initial.purchase_date || today,
    sold_date: initial.sold_date || '',
    notes: initial.notes || '',
  })

  const set = (key, val) => setForm(p => ({ ...p, [key]: val }))

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label className="text-xs text-text-muted mb-1 block">{t('products.productName')}</label>
        <input type="text" placeholder={t('products.productNamePlaceholder')}
          value={form.product_name} onChange={(e) => set('product_name', e.target.value)} className="input" />
      </div>
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('products.productType')}</label>
        <select className="select" value={form.product_type} onChange={(e) => set('product_type', e.target.value)}>
          {PRODUCT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
      </div>
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('products.purchaseDate')}</label>
        <input type="date" value={form.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} className="input" />
      </div>
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('products.purchasePrice')}</label>
        <input type="number" step="0.01" placeholder="0.00" value={form.purchase_price}
          onChange={(e) => set('purchase_price', e.target.value)} className="input" />
      </div>
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('products.currentValueLabel')}</label>
        <input type="number" step="0.01" placeholder="0.00" value={form.current_value}
          onChange={(e) => set('current_value', e.target.value)} className="input" />
      </div>
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('products.soldPrice')}</label>
        <input type="number" step="0.01" placeholder={t('products.soldPriceHint')} value={form.sold_price}
          onChange={(e) => set('sold_price', e.target.value)} className="input" />
      </div>
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('products.soldDate')}</label>
        <input type="date" value={form.sold_date} onChange={(e) => set('sold_date', e.target.value)} className="input" />
      </div>
      <div className="col-span-2">
        <label className="text-xs text-text-muted mb-1 block">{t('products.notes')}</label>
        <input type="text" placeholder={t('products.notesHint')} value={form.notes}
          onChange={(e) => set('notes', e.target.value)} className="input" />
      </div>
      <div className="col-span-2 flex gap-2">
        <button onClick={() => onSubmit({
          ...form,
          purchase_price: parseFloat(form.purchase_price),
          current_value: form.current_value ? parseFloat(form.current_value) : null,
          sold_price: form.sold_price ? parseFloat(form.sold_price) : null,
          sold_date: form.sold_date || null,
        })} disabled={!form.product_name || !form.purchase_price || loading} className="btn-primary flex-1">
          <Check size={14} /> {loading ? t('common.saving') : t('common.save')}
        </button>
        <button onClick={onCancel} className="btn-ghost">
          <X size={14} /> {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

export default function Products() {
  const { t } = useSettings()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [period, setPeriod] = useState('total')
  const [sortBy, setSortBy] = useState('purchase_date')
  const [sortOrder, setSortOrder] = useState('desc')
  const [filterType, setFilterType] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterPnl, setFilterPnl] = useState('all')
  const [showFilters, setShowFilters] = useState(false)
  const queryClient = useQueryClient()
  const ANALYTICS_TABS = [
    { to: '/analytics', label: t('nav.analytics'), icon: BarChart3 },
    { to: '/products', label: t('nav.products'), icon: ShoppingBag },
    { to: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
  ]

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['products'],
    queryFn: () => getProducts().then(r => r.data),
  })

  const { data: summary } = useQuery({
    queryKey: ['products-summary'],
    queryFn: () => getProductsSummary().then(r => r.data),
  })

  const createMutation = useMutation({
    mutationFn: createProduct,
    onSuccess: () => {
      toast.success(t('products.added'))
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
      setCreating(false)
    },
    onError: () => toast.error(t('products.addFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateProduct(id, data),
    onSuccess: () => {
      toast.success(t('products.updated'))
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
      setEditingId(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProduct,
    onSuccess: () => {
      toast.success(t('products.deleted'))
      queryClient.invalidateQueries({ queryKey: ['products'] })
      queryClient.invalidateQueries({ queryKey: ['products-summary'] })
    },
  })

  const hasActiveFilters = filterType || filterDateFrom || filterDateTo || filterPnl !== 'all'
  const periodCutoff = useMemo(() => getPeriodCutoff(period), [period])

  const periodStats = useMemo(() => {
    const cutoff = periodCutoff
    const periodProducts = products.filter(p => {
      if (cutoff && p.purchase_date < cutoff) return false
      return true
    })
    const totalInvested = periodProducts.reduce((s, p) => s + (p.purchase_price || 0), 0)
    const totalValue = periodProducts.reduce((s, p) => {
      const v = p.sold_price ?? p.current_value ?? p.purchase_price ?? 0
      return s + v
    }, 0)
    const totalPnl = totalValue - totalInvested
    const pnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0
    return { totalInvested, totalValue, totalPnl, pnlPct, count: periodProducts.length }
  }, [products, periodCutoff])

  const filteredAndSorted = useMemo(() => {
    let result = products.filter(p => {
      if (filterType && p.product_type !== filterType) return false
      if (filterDateFrom && p.purchase_date < filterDateFrom) return false
      if (filterDateTo && p.purchase_date > filterDateTo) return false
      if (filterPnl === 'profit' && (p.pnl == null || p.pnl < 0)) return false
      if (filterPnl === 'loss' && (p.pnl == null || p.pnl >= 0)) return false
      if (periodCutoff && p.purchase_date < periodCutoff) return false
      return true
    })

    result = [...result].sort((a, b) => {
      let valA, valB
      switch (sortBy) {
        case 'purchase_date': valA = a.purchase_date || ''; valB = b.purchase_date || ''; break
        case 'purchase_price': valA = a.purchase_price ?? 0; valB = b.purchase_price ?? 0; break
        case 'product_name': valA = (a.product_name || '').toLowerCase(); valB = (b.product_name || '').toLowerCase(); break
        case 'pnl': valA = a.pnl ?? -Infinity; valB = b.pnl ?? -Infinity; break
        default: return 0
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })

    return result
  }, [products, filterType, filterDateFrom, filterDateTo, filterPnl, sortBy, sortOrder, periodCutoff])

  const resetFilters = () => { setFilterType(''); setFilterDateFrom(''); setFilterDateTo(''); setFilterPnl('all') }

  const monthlyChartData = summary?.monthly?.map(m => ({
    month: m.month, invested: m.invested, current: m.current, pnl: m.pnl,
  })) || []

  return (
    <div className="space-y-4 pb-2">
      <TabNav tabs={ANALYTICS_TABS} />
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{t('products.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('products.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <PeriodSelector value={period} onChange={setPeriod} periods={PRODUCT_PERIODS} />
          <button onClick={() => setCreating(true)} className="btn-primary">
            <Plus size={16} /> {t('products.logPurchase')}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {products.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.totalInvested')}</p>
            <p className="stat-value">€{periodStats.totalInvested.toFixed(2)}</p>
            <p className="text-xs text-text-muted">{periodStats.count} {t('products.items')}</p>
          </div>
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.currentValue')}</p>
            <p className="stat-value">€{periodStats.totalValue.toFixed(2)}</p>
          </div>
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.totalPnl')}</p>
            <p className={clsx('text-xl font-bold', periodStats.totalPnl >= 0 ? 'text-green' : 'text-brand-red')}>
              {periodStats.totalPnl >= 0 ? '+' : ''}€{periodStats.totalPnl.toFixed(2)}
            </p>
          </div>
          <div className="stat-card">
            <p className="stat-label uppercase tracking-wide">{t('products.return')}</p>
            <div className={clsx('flex items-center gap-1 text-xl font-bold', periodStats.pnlPct >= 0 ? 'text-green' : 'text-brand-red')}>
              {periodStats.pnlPct >= 0 ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
              {periodStats.pnlPct >= 0 ? '+' : ''}{periodStats.pnlPct.toFixed(2)}%
            </div>
          </div>
        </div>
      )}

      {/* Monthly Chart */}
      {monthlyChartData.length > 0 && (
        <div className="card">
          <h3 className="text-base font-semibold text-text-primary mb-4">{t('products.monthlyPnl')}</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={monthlyChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
              <XAxis dataKey="month" tick={{ fill: '#606078', fontSize: 11 }} />
              <YAxis tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => `€${v}`} />
              <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #2a2a3d', borderRadius: '8px', color: '#fff' }}
                formatter={(val, name) => [`€${val.toFixed(2)}`, name]} />
              <Bar dataKey="invested" name={t('products.invested')} fill="#606078" radius={[4, 4, 0, 0]} />
              <Bar dataKey="current" name={t('products.currentValue')} fill="#EF1515" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Create Form */}
      {creating && (
        <div className="card border-brand-red/30">
          <h3 className="text-base font-semibold text-text-primary mb-4">{t('products.logNew')}</h3>
          <ProductForm onSubmit={(data) => createMutation.mutate(data)} onCancel={() => setCreating(false)} loading={createMutation.isPending} />
        </div>
      )}

      {/* Sort & Filter Bar */}
      {products.length > 0 && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <SortAsc size={14} className="text-text-muted" />
              <select className="select text-sm py-1.5 w-40" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="purchase_date">{t('products.sortDate')}</option>
                <option value="purchase_price">{t('products.sortPrice')}</option>
                <option value="product_name">{t('products.sortName')}</option>
                <option value="pnl">{t('products.sortPnl')}</option>
              </select>
              <button onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')} className="btn-ghost py-1.5 px-2">
                {sortOrder === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>

            <button onClick={() => setShowFilters(f => !f)}
              className={`btn-ghost text-sm py-1.5 ${showFilters || hasActiveFilters ? 'border-brand-red/30 text-brand-red' : ''}`}>
              <Filter size={14} /> {t('common.filter')}
              {hasActiveFilters && <span className="ml-1 bg-brand-red text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">!</span>}
            </button>

            {hasActiveFilters && (
              <button onClick={resetFilters} className="btn-ghost text-sm py-1.5">
                <X size={14} /> {t('common.clear')}
              </button>
            )}

            <div className="flex items-center gap-1 ml-auto">
              {[
                { value: 'all', label: t('products.filterAll') },
                { value: 'profit', label: t('products.filterOnlyProfit') },
                { value: 'loss', label: t('products.filterOnlyLoss') },
              ].map(opt => (
                <button key={opt.value} onClick={() => setFilterPnl(opt.value)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    filterPnl === opt.value
                      ? opt.value === 'profit' ? 'bg-green text-white'
                        : opt.value === 'loss' ? 'bg-brand-red text-white'
                        : 'bg-brand-red text-white'
                      : 'bg-bg-card text-text-secondary hover:text-text-primary border border-border'
                  }`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {showFilters && (
            <div className="pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('products.filterType')}</label>
                <select className="select text-sm py-1.5" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                  <option value="">{t('products.allTypes')}</option>
                  {PRODUCT_TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('products.filterDateFrom')}</label>
                <input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="input text-sm py-1.5" />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('products.filterDateTo')}</label>
                <input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} className="input text-sm py-1.5" />
              </div>
              <div className="flex items-end">
                <span className="text-xs text-text-muted">{filteredAndSorted.length} / {products.length} {t('products.items')}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Products List */}
      {isLoading ? (
        <div className="skeleton h-64 rounded-xl" />
      ) : products.length === 0 && !creating ? (
        <div className="card text-center py-20">
          <Package size={48} className="mx-auto mb-4 text-text-muted" />
          <p className="text-text-muted">{t('products.empty')}</p>
          <button onClick={() => setCreating(true)} className="btn-primary mt-4 mx-auto w-fit">
            <Plus size={16} /> {t('products.logFirst')}
          </button>
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-text-muted">{t('products.noResults')}</p>
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg/50">
                  <th className="text-left px-4 py-3 text-text-muted font-medium">{t('products.product')}</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">{t('products.productType')}</th>
                  <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.date')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.paidPrice')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.valueLabel')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.pnlLabel')}</th>
                  <th className="text-right px-4 py-3 text-text-muted font-medium">{t('products.pnlPct')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {filteredAndSorted.map((p) => (
                  <tr key={p.id} className="border-b border-border/50 hover:bg-bg-elevated/50">
                    {editingId === p.id ? (
                      <td colSpan={8} className="px-4 py-4">
                        <ProductForm initial={p} onSubmit={(data) => updateMutation.mutate({ id: p.id, data })}
                          onCancel={() => setEditingId(null)} loading={updateMutation.isPending} />
                      </td>
                    ) : (
                      <>
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-text-primary">{p.product_name}</p>
                          {p.notes && <p className="text-xs text-text-muted truncate max-w-[160px]">{p.notes}</p>}
                          {p.sold_date && <span className="badge badge-green text-xs">{t('common.sold')}</span>}
                        </td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{p.product_type || '-'}</td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{p.purchase_date}</td>
                        <td className="px-4 py-3 text-right font-medium text-text-primary">€{p.purchase_price?.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right text-text-primary">
                          {p.sold_price ? `€${p.sold_price.toFixed(2)}` : p.current_value ? `€${p.current_value.toFixed(2)}` : '-'}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {p.pnl !== null ? (
                            <span className={p.pnl >= 0 ? 'text-green' : 'text-brand-red'}>
                              {p.pnl >= 0 ? '+' : ''}€{p.pnl?.toFixed(2)}
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {p.pnl_percent !== null ? (
                            <span className={clsx('font-medium text-xs', p.pnl_percent >= 0 ? 'text-green' : 'text-brand-red')}>
                              {p.pnl_percent >= 0 ? '+' : ''}{p.pnl_percent?.toFixed(1)}%
                            </span>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            <button onClick={() => setEditingId(p.id)} className="text-text-muted hover:text-text-primary p-1 transition-colors">
                              <Edit2 size={14} />
                            </button>
                            <button onClick={() => {
                              if (confirm(`${t('products.deleteConfirm')} "${p.product_name}"?`)) deleteMutation.mutate(p.id)
                            }} className="text-text-muted hover:text-brand-red p-1 transition-colors">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Card Layout */}
          <div className="md:hidden space-y-2 p-2">
            {filteredAndSorted.map((p) => {
              if (editingId === p.id) {
                return (
                  <div key={p.id} className="bg-bg-card border border-border rounded-lg p-3 space-y-3">
                    <p className="text-sm font-medium text-text-primary truncate">{p.product_name}</p>
                    <ProductForm initial={p} onSubmit={(data) => updateMutation.mutate({ id: p.id, data })}
                      onCancel={() => setEditingId(null)} loading={updateMutation.isPending} />
                  </div>
                )
              }

              const badges = []
              if (p.product_type) badges.push({ label: p.product_type, variant: 'gray' })
              if (p.sold_date) badges.push({ label: t('common.sold'), variant: 'green' })

              return (
                <CardListItem
                  key={p.id}
                  name={p.product_name}
                  subtext={`${p.purchase_date} · €${p.purchase_price?.toFixed(2)}`}
                  badges={badges}
                  value={p.pnl !== null ? `${p.pnl >= 0 ? '+' : ''}€${p.pnl?.toFixed(2)}` : '-'}
                  valueSecondary={p.pnl_percent !== null ? `${p.pnl_percent >= 0 ? '+' : ''}${p.pnl_percent?.toFixed(1)}%` : undefined}
                  rightAction={
                    <div className="flex flex-col gap-1">
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(p.id) }}
                        className="text-text-muted hover:text-text-primary p-1 transition-colors">
                        <Edit2 size={12} />
                      </button>
                      <button onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`${t('products.deleteConfirm')} "${p.product_name}"?`)) deleteMutation.mutate(p.id)
                      }} className="text-text-muted hover:text-brand-red p-1 transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  }
                />
              )
            })}
          </div>
        </div>
      )}

      {/* By Type Breakdown */}
      {summary?.by_type?.length > 0 && (
        <div className="card">
          <h3 className="text-base font-semibold text-text-primary mb-4">{t('products.byType')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {summary.by_type.map((type) => (
              <div key={type.type} className="bg-bg-card border border-border rounded-lg p-3">
                <p className="text-xs text-text-muted mb-1">{type.type}</p>
                <p className="text-sm font-medium text-text-primary">{type.count} {t('products.items')}</p>
                <p className="text-xs text-text-secondary">{t('products.invested')}: €{type.invested.toFixed(2)}</p>
                <p className={clsx('text-sm font-bold mt-1', type.pnl >= 0 ? 'text-green' : 'text-brand-red')}>
                  {type.pnl >= 0 ? '+' : ''}€{type.pnl.toFixed(2)} ({type.pnl_pct >= 0 ? '+' : ''}{type.pnl_pct.toFixed(1)}%)
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
