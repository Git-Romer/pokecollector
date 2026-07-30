import SplitText from '../components/reactbits/SplitText'
import {useState} from 'react'
import {createPortal} from 'react-dom'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Legend,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from 'recharts'
import {
    Activity,
    BarChart3,
    Copy,
    LayoutDashboard,
    Plus,
    ShoppingBag,
    ShoppingCart,
    TrendingDown,
    TrendingUp,
    X
} from 'lucide-react'
import {
    createProduct,
    getAnalyticsNewSets,
    getDuplicates,
    getInvestmentTracker,
    getPortfolioSummary,
    getSets,
    getProducts,
    getRarityStats,
    getTopMovers
} from '../api/client'
import {useSettings} from '../contexts/SettingsContext'
import CardListItem from '../components/CardListItem'
import {format, parseISO} from 'date-fns'
import clsx from 'clsx'
import PeriodSelector, {CARD_PERIODS, PERIOD_DAYS} from '../components/PeriodSelector'
import toast from 'react-hot-toast'
import {resolveCardImageUrl} from '../utils/imageUrl'
import MoneyInput from '../components/MoneyInput'
import {parseMoneyInputValue} from '../utils/moneyInput'

const RARITY_COLORS = [
    '#EF1515', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6',
    '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

const PRODUCT_TYPES = ['Booster Pack', 'Booster Box', 'Elite Trainer Box', 'Tin', 'Bundle', 'Collection Box', 'Blister', 'Other']

function formatPortfolioCounts(segment) {
    const counts = []
    if (segment.cards > 0) counts.push(`${segment.cards} ${segment.cards === 1 ? 'card' : 'cards'}`)
    if (segment.sealed_products > 0) counts.push(`${segment.sealed_products} sealed ${segment.sealed_products === 1 ? 'product' : 'products'}`)
    return counts.length > 0 ? counts.join(' · ') : 'No items'
}

function formatCostBasisNeeded(segment) {
    const needed = segment.cost_basis_needed || {}
    const counts = []
    if (needed.cards > 0) counts.push(`${needed.cards} ${needed.cards === 1 ? 'card' : 'cards'}`)
    if (needed.sealed_products > 0) counts.push(`${needed.sealed_products} sealed ${needed.sealed_products === 1 ? 'product' : 'products'}`)
    return counts.length > 0 ? counts.join(' · ') : null
}

function CustomTooltip({active, payload, label, formatPrice}) {
    if (active && payload && payload.length) {
        return (
            <div className="bg-bg-surface border border-border rounded-lg p-3 text-sm shadow-xl">
                <p className="text-text-muted mb-1">{label}</p>
                {payload.map((entry, i) => (
                    <p key={i} style={{color: entry.color}} className="font-medium">
                        {entry.name}: {typeof entry.value === 'number' ? formatPrice(entry.value) : entry.value}
                    </p>
                ))}
            </div>
        )
    }
    return null
}

function AddExpenseModal({onClose, onSuccess}) {
    const [amount, setAmount] = useState('')
    const [description, setDescription] = useState('')
    const [productType, setProductType] = useState('Booster Pack')
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
    const queryClient = useQueryClient()

    const {t, exchangeRate, exchangeRateReady} = useSettings()
    const mutation = useMutation({
        mutationFn: (data) => createProduct(data),
        onSuccess: () => {
            toast.success(t('analytics.expenseSaved'))
            queryClient.invalidateQueries({queryKey: ['investment-tracker']})
            queryClient.invalidateQueries({queryKey: ['products']})
            onSuccess && onSuccess()
            onClose()
        },
        onError: () => toast.error(t('analytics.expenseSaveError')),
    })

    const handleSubmit = (e) => {
        e.preventDefault()
        if (!exchangeRateReady || !amount || parseFloat(amount) <= 0) return
        mutation.mutate({
            product_name: description.trim() || productType,
            product_type: productType,
            purchase_price: parseMoneyInputValue(amount, exchangeRate),
            purchase_date: date,
            notes: description.trim() || null,
        })
    }

    return createPortal(
        <div
            className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center md:bg-black/80 md:backdrop-blur-sm"
            onClick={onClose}>
            <div className={[
                'w-full rounded-t-2xl max-h-[90dvh] overflow-y-auto',
                'bg-bg-surface border-t border-border',
                'md:rounded-2xl md:border md:max-w-md md:max-h-[80vh]',
            ].join(' ')} onClick={e => e.stopPropagation()}>
                <div className="flex justify-center pt-3 pb-1 md:hidden">
                    <div className="w-10 h-1 bg-border rounded-full"/>
                </div>
                <div className="p-6">
                    <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2">
                            <ShoppingCart size={18} className="text-brand-red"/>
                            <h2 className="text-lg font-bold text-text-primary">{t('analytics.logExpense')}</h2>
                        </div>
                        <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
                            <X size={20}/>
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="text-xs text-text-secondary mb-1 block font-medium">
                                {t('analytics.amountLabel')} <span className="text-brand-red">*</span>
                            </label>
                            <MoneyInput
                                min="0.01"
                                required
                                placeholder={t('analytics.amountPlaceholder')}
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                            />
                        </div>
                        <div>
                            <label
                                className="text-xs text-text-secondary mb-1 block font-medium">{t('products.productType')}</label>
                            <select value={productType} onChange={e => setProductType(e.target.value)}
                                    className="select">
                                {PRODUCT_TYPES.map(pt => <option key={pt} value={pt}>{pt}</option>)}
                            </select>
                        </div>
                        <div>
                            <label
                                className="text-xs text-text-secondary mb-1 block font-medium">{t('common.date')}</label>
                            <input
                                type="date"
                                value={date}
                                onChange={e => setDate(e.target.value)}
                                className="input"
                            />
                        </div>
                        <div>
                            <label
                                className="text-xs text-text-secondary mb-1 block font-medium">{t('analytics.descriptionOptional')}</label>
                            <input
                                type="text"
                                placeholder={t('analytics.descriptionPlaceholder')}
                                value={description}
                                onChange={e => setDescription(e.target.value)}
                                className="input"
                            />
                        </div>
                        <div className="flex gap-3 pt-2">
                            <button type="submit" disabled={mutation.isPending || !amount || !exchangeRateReady}
                                    className="btn-primary flex-1">
                                <Plus
                                    size={16}/> {mutation.isPending ? t('analytics.saving') : t('analytics.saveExpense')}
                            </button>
                            <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>,
        document.body
    )
}

export default function Analytics() {
    const {t, formatPrice, pricePrimaryField, currencySymbol} = useSettings()
    const [moversPeriod, setMoversPeriod] = useState('7d')
    const [moversSort, setMoversSort] = useState('percentage')
    const [activeTab, setActiveTab] = useState('visualize')
    const [showExpenseModal, setShowExpenseModal] = useState(false)
    const queryClient = useQueryClient()

    const {data: duplicates = [], isLoading: dupLoading} = useQuery({
        queryKey: ['duplicates', pricePrimaryField],
        queryFn: () => getDuplicates({price_field: pricePrimaryField}).then(r => r.data),
    })

    const moversDay = PERIOD_DAYS[moversPeriod] || 7
    const {data: topMovers = [], isLoading: moversLoading} = useQuery({
        queryKey: ['top-movers', moversDay, pricePrimaryField, moversSort],
        queryFn: () => getTopMovers(moversDay, {price_field: pricePrimaryField, sort_by: moversSort}).then(r => r.data),
    })

    const {data: rarityStats = [], isLoading: rarityLoading} = useQuery({
        queryKey: ['rarity-stats', pricePrimaryField],
        queryFn: () => getRarityStats({price_field: pricePrimaryField}).then(r => r.data),
    })

    const {data: investmentData = [], isLoading: investLoading} = useQuery({
        queryKey: ['investment-tracker', pricePrimaryField],
        queryFn: () => getInvestmentTracker({price_field: pricePrimaryField}).then(r => r.data),
    })

    const {data: products = []} = useQuery({
        queryKey: ['products', pricePrimaryField],
        queryFn: () => getProducts({price_field: pricePrimaryField}).then(r => r.data),
    })

    const {data: newSets = []} = useQuery({
        queryKey: ['analytics-new-sets'],
        queryFn: () => getAnalyticsNewSets().then(r => r.data),
    })

    const {data: sets = []} = useQuery({
        queryKey: ['sets'],
        queryFn: () => getSets().then(r => r.data),
    })

    const {data: portfolioSummary, isLoading: portfolioSummaryLoading} = useQuery({
        queryKey: ['portfolio-summary', pricePrimaryField],
        queryFn: () => getPortfolioSummary({price_field: pricePrimaryField}).then(r => r.data),
    })

    const tabs = [
        {key: 'visualize', label: 'Visualize', icon: Activity},
        {key: 'discover', label: 'Discover', icon: TrendingUp},
        {key: 'master_set', label: 'Master Set', icon: BarChart3},
        {key: 'portfolio', label: 'Portfolio Performance', icon: Activity},
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
    const productCardRealizedGains = products.reduce((sum, p) => sum + (p.realized_gains || 0), 0)
    const realizedPnl = totalSoldRevenue - totalSoldCost + productCardRealizedGains
    const unrealizedPnl = (latestSnapshot?.value ?? 0) - (latestSnapshot?.cost ?? 0)

    return (
        <div className="space-y-4 pb-2">
            <div>
                <h1 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none mt-2"><SplitText
                    text={'Trends & Insights'} delay={40}/></h1>
                <p className="text-sm text-text-secondary mt-1">Visualize, Discover, Master Set, and Portfolio Performance.</p>
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
                    {tabs.map(({key, label, icon: Icon}) => (
                        <button key={key} onClick={() => setActiveTab(key)}
                                className={clsx(
                                    'flex items-center gap-2 px-4 py-2 rounded-t-lg text-sm font-medium transition-all',
                                    activeTab === key
                                        ? 'bg-brand-red/20 text-brand-red border-b-2 border-brand-red'
                                        : 'text-text-secondary hover:text-text-primary'
                                )}>
                            <Icon size={14}/> {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Duplicates Tab */}
            {activeTab === 'visualize' && (
                <div className="space-y-4">
                    <p className="text-sm text-text-secondary">{t('analytics.duplicatesDesc')}</p>
                    {dupLoading ? (
                        <div className="skeleton h-64 rounded-xl"/>
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
                                                    {resolveCardImageUrl(item) && (
                                                        <img src={resolveCardImageUrl(item)} alt={item.name}
                                                             className="w-8 h-10 object-cover rounded flex-shrink-0"
                                                             loading="lazy"/>
                                                    )}
                                                    <span
                                                        className="text-sm font-medium text-text-primary">{item.name}</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-text-secondary text-xs">{item.set_name || '-'}</td>
                                            <td className="px-4 py-3 text-text-secondary text-xs">{item.rarity || '-'}</td>
                                            <td className="px-4 py-3 text-center font-bold text-brand-red">{item.quantity}x</td>
                                            <td className="px-4 py-3 text-right text-text-primary">{formatPrice(item.price_market)}</td>
                                            <td className="px-4 py-3 text-right font-bold text-green">{formatPrice(item.total_value)}</td>
                                        </tr>
                                    ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="md:hidden space-y-2 p-2">
                                {duplicates.map((item) => (
                                    <CardListItem
                                        key={item.id}
                                        image={resolveCardImageUrl(item)}
                                        name={item.name}
                                        subtext={item.set_name || '-'}
                                        badges={[
                                            {label: `${item.quantity}x`, variant: 'red'},
                                            ...(item.rarity ? [{label: item.rarity, variant: 'gray'}] : []),
                                        ]}
                                        value={formatPrice(item.total_value)}
                                        valueSecondary={formatPrice(item.price_market)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Top Movers Tab */}
            {activeTab === 'discover' && (
                <div className="space-y-4">
                    <div className="flex items-center gap-3 flex-wrap">
                        <p className="text-sm text-text-secondary">{t('analytics.moversDesc')} {moversDay} {t('analytics.days')}</p>
                        <PeriodSelector value={moversPeriod} onChange={setMoversPeriod} periods={CARD_PERIODS}/>
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-text-muted">{t('analytics.sortBy')}</span>
                            <div className="flex rounded-lg border border-border bg-bg-surface p-0.5">
                                {[
                                    {value: 'percentage', label: t('analytics.sortPercentage')},
                                    {value: 'absolute', label: currencySymbol},
                                ].map(option => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        onClick={() => setMoversSort(option.value)}
                                        aria-pressed={moversSort === option.value}
                                        className={clsx(
                                            'min-w-10 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors',
                                            moversSort === option.value
                                                ? 'bg-brand-red text-white'
                                                : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                                        )}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    {moversLoading ? (
                        <div className="skeleton h-64 rounded-xl"/>
                    ) : topMovers.length === 0 ? (
                        <div className="card text-center py-12 text-text-muted">{t('analytics.noMovers')}</div>
                    ) : (
                        <div className="space-y-2">
                            {topMovers.map((card) => (
                                <div key={card.card_id} className="card flex items-center gap-4">
                                    {resolveCardImageUrl(card) && (
                                        <img src={resolveCardImageUrl(card)} alt={card.name}
                                             className="w-10 h-14 object-cover rounded flex-shrink-0" loading="lazy"/>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-text-primary truncate">{card.name}</p>
                                        <p className="text-xs text-text-muted">{card.rarity}</p>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                        <p className="text-sm text-text-secondary">{formatPrice(card.old_price)} → {formatPrice(card.current_price)}</p>
                                        <div className={clsx(
                                            'flex items-center justify-end gap-1 font-bold',
                                            card.change_pct >= 0 ? 'text-green' : 'text-brand-red'
                                        )}>
                                            {card.change_pct >= 0 ? <TrendingUp size={14}/> : <TrendingDown size={14}/>}
                                            {card.change_pct >= 0 ? '+' : ''}{card.change_pct}%
                                            <span className="text-xs font-normal ml-1">
                        ({card.change_abs >= 0 ? '+' : ''}{formatPrice(card.change_abs)})
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
            {activeTab === 'master_set' && (
                <div className="space-y-4">
                    <div className="card">
                        <div className="flex items-start justify-between gap-4 mb-4">
                            <div><p className="text-xs uppercase tracking-[0.16em] text-text-muted font-semibold">Master Set</p><h2 className="text-lg font-bold text-text-primary mt-1">Closest to completion</h2></div>
                            <p className="text-xs text-text-muted">Exact numbered cards</p>
                        </div>
                        <div className="space-y-3">
                            {[...sets].filter(set => set.total > 0).sort((a, b) => ((b.owned_count || 0) / b.total) - ((a.owned_count || 0) / a.total)).slice(0, 5).map(set => {
                                const owned = set.owned_count || 0
                                const pct = Math.round(owned / set.total * 100)
                                return <div key={set.id}><div className="flex justify-between gap-3 text-sm"><span className="truncate text-text-primary font-medium">{set.name}</span><span className="shrink-0 text-text-secondary">{owned}/{set.total} · {pct}%</span></div><div className="mt-1.5 h-1.5 rounded-full bg-white/10 overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-red via-yellow to-light-blue" style={{width: pct + "%"}}/></div></div>
                            })}
                            {sets.length === 0 && <p className="text-sm text-text-muted">Your set catalog will appear after the next card sync.</p>}
                        </div>
                    </div>
                    {rarityLoading ? (
                        <div className="skeleton h-64 rounded-xl"/>
                    ) : rarityStats.length === 0 ? (
                        <div className="card text-center py-12 text-text-muted">{t('analytics.noRarityStats')}</div>
                    ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div className="card">
                                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.byCount')}</h3>
                                <ResponsiveContainer width="100%" height={300}>
                                    <PieChart>
                                        <Pie data={rarityStats} dataKey="count" nameKey="rarity" cx="50%" cy="50%"
                                             outerRadius={100}
                                             label={({rarity, percentage}) => `${percentage}%`}>
                                            {rarityStats.map((_, i) => <Cell key={i}
                                                                             fill={RARITY_COLORS[i % RARITY_COLORS.length]}/>)}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{
                                                background: '#1e1e2e',
                                                border: '1px solid #2a2a3d',
                                                borderRadius: '8px',
                                                color: '#fff'
                                            }}
                                            labelStyle={{color: '#fff'}}
                                            itemStyle={{color: '#fff'}}
                                            formatter={(val, name) => [val, t('analytics.count')]}
                                        />
                                        <Legend wrapperStyle={{color: '#a0a0b8'}}/>
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                            <div className="card">
                                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.byValue')}</h3>
                                <ResponsiveContainer width="100%" height={300}>
                                    <BarChart data={rarityStats} layout="vertical">
                                        <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" horizontal={false}/>
                                        <XAxis type="number" tick={{fill: '#606078', fontSize: 11}}
                                               tickFormatter={v => formatPrice(v)}/>
                                        <YAxis dataKey="rarity" type="category" tick={{fill: '#606078', fontSize: 10}}
                                               width={100}/>
                                        <Tooltip content={<CustomTooltip formatPrice={formatPrice}/>}
                                                 cursor={{fill: 'rgba(255,255,255,0.04)'}}/>
                                        <Bar dataKey="total_value" name={t('analytics.value')} radius={[0, 4, 4, 0]}>
                                            {rarityStats.map((_, i) => <Cell key={i}
                                                                             fill={RARITY_COLORS[i % RARITY_COLORS.length]}/>)}
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
                                            <tr key={r.rarity}
                                                className="border-b border-border/30 hover:bg-bg-elevated/50">
                                                <td className="py-2 flex items-center gap-2">
                                                    <div className="w-3 h-3 rounded-full flex-shrink-0"
                                                         style={{backgroundColor: RARITY_COLORS[i % RARITY_COLORS.length]}}/>
                                                    <span className="text-text-primary">{r.rarity}</span>
                                                </td>
                                                <td className="py-2 text-right text-text-secondary">{r.count}</td>
                                                <td className="py-2 text-right text-text-secondary">{r.percentage}%</td>
                                                <td className="py-2 text-right text-green font-medium">{formatPrice(r.total_value)}</td>
                                            </tr>
                                        ))}
                                        </tbody>
                                    </table>
                                </div>
                                <div className="sm:hidden space-y-2">
                                    {rarityStats.map((r, i) => (
                                        <div key={r.rarity}
                                             className="flex items-center gap-3 py-2 border-b border-border/30">
                                            <div className="w-3 h-3 rounded-full flex-shrink-0"
                                                 style={{backgroundColor: RARITY_COLORS[i % RARITY_COLORS.length]}}/>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium text-text-primary truncate">{r.rarity}</p>
                                                <p className="text-xs text-text-secondary">{r.count} · {r.percentage}%</p>
                                            </div>
                                            <p className="text-green font-medium text-sm flex-shrink-0">{formatPrice(r.total_value)}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Portfolio Performance */}
            {activeTab === 'portfolio' && (
                <div className="space-y-4">
                    {portfolioSummary?.segments && (
                        <>
                            <div className="card border-brand-red/20 bg-brand-red/5">
                                <p className="text-sm font-semibold text-text-primary">Portfolio scope</p>
                                <p className="mt-1 text-sm text-text-secondary">
                                    Vault, PC, and the highest-value 10% of Main Collection by market value.
                                    Sealed product is included when it is marked Vault or PC.
                                </p>
                            </div>
                            <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                                {[['vault', 'Vault'], ['pc', 'PC'], ['main_collection', 'Main Collection · Highest-value 10%']].map(([scope, label]) => {
                                    const segment = portfolioSummary.segments[scope]
                                    const costBasisNeeded = formatCostBasisNeeded(segment)
                                    return <div key={scope} className="card border-white/10">
                                        <p className="text-xs uppercase tracking-[0.16em] text-text-muted font-semibold">{label}</p>
                                        <p className="mt-2 text-2xl font-black text-text-primary">{formatPrice(segment.market_value)}</p>
                                        <p className="mt-1 text-xs text-text-secondary">{formatPortfolioCounts(segment)}</p>
                                        <div className="mt-3 space-y-1 text-xs">
                                            <div className="flex justify-between gap-3">
                                                <span className="text-text-muted">Cost basis</span>
                                                <span className="font-medium text-text-primary">{formatPrice(segment.cost_basis)}</span>
                                            </div>
                                            <div className="flex justify-between gap-3">
                                                <span className="text-text-muted">Profit / loss</span>
                                                <span className={clsx('font-bold', segment.profit_loss >= 0 ? 'text-green' : 'text-brand-red')}>{formatPrice(segment.profit_loss)}</span>
                                            </div>
                                            <div className="flex justify-between gap-3">
                                                <span className="text-text-muted">Return</span>
                                                <span className="font-medium text-text-primary">{segment.return_percentage == null ? '—' : `${segment.return_percentage}%`}</span>
                                            </div>
                                        </div>
                                        {costBasisNeeded && (
                                            <p className="mt-3 border-t border-border/50 pt-2 text-xs text-yellow">
                                                <span className="font-semibold">Cost Basis Needed:</span> {costBasisNeeded}. Included in market value; excluded from profit/loss.
                                            </p>
                                        )}
                                    </div>
                                })}
                            </div>
                        </>
                    )}
                    {/* Header with expense button */}
                    <div className="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <p className="text-sm text-text-secondary">{t('analytics.portfolioDesc')}</p>
                            {latestSnapshot && (
                                <p className="text-xs text-text-muted mt-0.5">
                                    {t('analytics.current')}: <span
                                    className="text-green font-bold">{formatPrice(latestSnapshot.value)}</span>
                                    {' · '}{t('dashboard.invested')}: <span
                                    className="text-text-primary font-medium">{formatPrice(latestSnapshot.cost)}</span>
                                    {totalProductsCost > 0 && (
                                        <> · {t('analytics.products')}: <span
                                            className="text-yellow font-medium">{formatPrice(totalProductsCost)}</span></>
                                    )}
                                </p>
                            )}
                        </div>
                        <button
                            onClick={() => setShowExpenseModal(true)}
                            className="btn-ghost text-sm py-1.5 border-green/30 text-green hover:bg-green/10"
                        >
                            <ShoppingCart size={14}/> {t('analytics.logExpense')}
                        </button>
                    </div>

                    {/* Summary stats — Gesamt-Investiert, Verkaufserlöse, Realisierter G&V, Unrealisierter G&V */}
                    {(products.length > 0 || latestSnapshot) && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {[
                                {
                                    label: t('analytics.totalInvested'),
                                    value: formatPrice((latestSnapshot?.cost ?? 0) + totalSoldCost),
                                    color: '#90a4ae'
                                },
                                {
                                    label: t('analytics.totalSoldRevenue'),
                                    value: formatPrice(totalSoldRevenue),
                                    color: '#66bb6a'
                                },
                                {
                                    label: t('analytics.realizedPnl'),
                                    value: formatPrice(realizedPnl),
                                    color: realizedPnl >= 0 ? '#66bb6a' : '#e3000b'
                                },
                                {
                                    label: t('analytics.unrealizedPnl'),
                                    value: formatPrice(unrealizedPnl),
                                    color: unrealizedPnl >= 0 ? '#66bb6a' : '#e3000b'
                                },
                            ].map(stat => (
                                <div key={stat.label} className="rounded-xl p-3 text-center"
                                     style={{
                                         background: 'rgba(255,255,255,0.04)',
                                         border: '1px solid rgba(255,255,255,0.07)'
                                     }}>
                                    <p className="text-xs text-text-muted mb-1 leading-tight">{stat.label}</p>
                                    <p className="text-sm font-black" style={{color: stat.color}}>{stat.value}</p>
                                </div>
                            ))}
                        </div>
                    )}

                    {investLoading ? (
                        <div className="skeleton h-64 rounded-xl"/>
                    ) : chartData.length === 0 ? (
                        <div className="card text-center py-12 space-y-3">
                            <p className="text-text-muted">{t('analytics.noInvestmentData')}</p>
                            <button onClick={() => setShowExpenseModal(true)}
                                    className="btn-ghost text-green border-green/30 hover:bg-green/10 mx-auto text-sm">
                                <ShoppingCart size={14}/> {t('analytics.logFirst')}
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
                                                <stop offset="5%" stopColor="#EF1515" stopOpacity={0.3}/>
                                                <stop offset="95%" stopColor="#EF1515" stopOpacity={0}/>
                                            </linearGradient>
                                            <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#606078" stopOpacity={0.2}/>
                                                <stop offset="95%" stopColor="#606078" stopOpacity={0}/>
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d"/>
                                        <XAxis dataKey="date" tick={{fill: '#606078', fontSize: 11}}/>
                                        <YAxis tick={{fill: '#606078', fontSize: 11}}
                                               tickFormatter={v => formatPrice(v)}/>
                                        <Tooltip content={<CustomTooltip formatPrice={formatPrice}/>}
                                                 cursor={{fill: 'rgba(255,255,255,0.04)'}}/>
                                        <Area type="monotone" dataKey="cost" name={t('analytics.cost')} stroke="#606078"
                                              fill="url(#costGrad)" strokeWidth={1.5} strokeDasharray="4 4"/>
                                        <Area type="monotone" dataKey="value" name={t('analytics.value')}
                                              stroke="#EF1515" fill="url(#valueGrad)" strokeWidth={2}/>
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                            <div className="card">
                                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.pnlOverTime')}</h3>
                                <ResponsiveContainer width="100%" height={200}>
                                    <BarChart data={chartData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d"/>
                                        <XAxis dataKey="date" tick={{fill: '#606078', fontSize: 11}}/>
                                        <YAxis tick={{fill: '#606078', fontSize: 11}}
                                               tickFormatter={v => formatPrice(v)}/>
                                        <Tooltip content={<CustomTooltip formatPrice={formatPrice}/>}
                                                 cursor={{fill: 'rgba(255,255,255,0.04)'}}/>
                                        <Bar dataKey="pnl" name={t('analytics.pnl')} radius={[4, 4, 0, 0]}>
                                            {chartData.map((entry, i) => (
                                                <Cell key={i} fill={entry.pnl >= 0 ? '#22c55e' : '#EF1515'}/>
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
                                        <button onClick={() => setShowExpenseModal(true)}
                                                className="btn-ghost text-xs py-1 px-2 text-green border-green/30">
                                            <Plus size={12}/> {t('common.new')}
                                        </button>
                                    </div>
                                    <div className="space-y-2 max-h-60 overflow-y-auto">
                                        {[...products].sort((a, b) => new Date(b.purchase_date) - new Date(a.purchase_date)).map(p => {
                                            const isSold = p.sold_price != null
                                            const currentValue = p.computed_current_value ?? p.current_value ?? 0
                                            const pnl = isSold ? (p.sold_price - p.purchase_price) : (currentValue - p.purchase_price)
                                            const pnlPositive = pnl >= 0

                                            return (
                                                <div key={p.id}
                                                     className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-text-primary truncate">{p.product_name}</p>
                                                        <p className="text-xs text-text-muted">
                                                            {p.product_type} · {p.purchase_date}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                                        {isSold ? (
                                                            <span
                                                                className="text-xs bg-green/20 text-green px-1.5 py-0.5 rounded">{t('analytics.statusSold')}</span>
                                                        ) : (
                                                            <span
                                                                className="text-xs bg-blue/20 text-blue-400 px-1.5 py-0.5 rounded">{t('analytics.statusOwned')}</span>
                                                        )}
                                                        {isSold ? (
                                                            <span
                                                                className="text-sm text-text-secondary">{t('analytics.soldFor')} {formatPrice(p.sold_price)}</span>
                                                        ) : (
                                                            <span
                                                                className="text-sm text-text-secondary">{t('products.currentValueLabel')} {formatPrice(currentValue)}</span>
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
                                        <span
                                            className="font-bold text-brand-red">{formatPrice(totalProductsCost + totalSoldCost)}</span>
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
                    onSuccess={() => queryClient.invalidateQueries({queryKey: ['investment-tracker']})}
                />
            )}
        </div>
    )
}
