import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, Bell, BellOff, Edit2, Check, X, Heart, Filter, SortAsc, ChevronUp, ChevronDown } from 'lucide-react'
import { getWishlist, removeFromWishlist, updateWishlistItem, addToCollection } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import CardListItem from '../components/CardListItem'
import toast from 'react-hot-toast'
import { resolveCardImageUrl } from '../utils/imageUrl'

function AlertEditor({ item, onDone }) {
  const [above, setAbove] = useState(item.price_alert_above || '')
  const [below, setBelow] = useState(item.price_alert_below || '')
  const { t } = useSettings()
  const queryClient = useQueryClient()

  const updateMutation = useMutation({
    mutationFn: () => updateWishlistItem(item.id, {
      price_alert_above: above ? parseFloat(above) : null,
      price_alert_below: below ? parseFloat(below) : null,
    }),
    onSuccess: () => {
      toast.success(t('wishlist.alertUpdated'))
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
      onDone()
    },
  })

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        <span className="text-xs text-text-muted">↑</span>
        <input type="number" step="0.01" placeholder="Above €" value={above}
          onChange={(e) => setAbove(e.target.value)} className="input w-20 py-1 text-xs" />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-xs text-text-muted">↓</span>
        <input type="number" step="0.01" placeholder="Below €" value={below}
          onChange={(e) => setBelow(e.target.value)} className="input w-20 py-1 text-xs" />
      </div>
      <button onClick={() => updateMutation.mutate()} className="text-green hover:text-green/80">
        <Check size={14} />
      </button>
      <button onClick={onDone} className="text-text-muted hover:text-text-primary">
        <X size={14} />
      </button>
    </div>
  )
}

export default function Wishlist() {
  const { t, formatPrice } = useSettings()
  const [editingId, setEditingId] = useState(null)
  const [sortBy, setSortBy] = useState('created_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const [filterSet, setFilterSet] = useState('')
  const [filterRarity, setFilterRarity] = useState('')
  const [filterMinPrice, setFilterMinPrice] = useState('')
  const [filterMaxPrice, setFilterMaxPrice] = useState('')
  const [filterHasAlert, setFilterHasAlert] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const queryClient = useQueryClient()

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['wishlist'],
    queryFn: () => getWishlist().then(r => r.data),
  })

  const removeMutation = useMutation({
    mutationFn: (id) => removeFromWishlist(id),
    onSuccess: () => {
      toast.success(t('wishlist.removed'))
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
    },
  })

  const addToColMutation = useMutation({
    mutationFn: (cardId) => addToCollection({ card_id: cardId, quantity: 1, condition: 'NM' }),
    onSuccess: () => {
      toast.success(t('wishlist.addedToCollection'))
      queryClient.invalidateQueries({ queryKey: ['collection'] })
    },
  })

  const sets = useMemo(() => {
    const map = new Map()
    items.forEach(i => {
      const s = i.card?.set_ref
      if (s?.id) map.set(s.id, s.name)
    })
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [items])

  const rarities = useMemo(() => [...new Set(items.map(i => i.card?.rarity).filter(Boolean))].sort(), [items])

  const hasActiveFilters = filterSet || filterRarity || filterMinPrice || filterMaxPrice || filterHasAlert

  const filtered = useMemo(() => {
    let result = items.filter(item => {
      const price = item.card?.price_market
      if (filterSet && item.card?.set_ref?.id !== filterSet) return false
      if (filterRarity && item.card?.rarity !== filterRarity) return false
      if (filterMinPrice && (price == null || price < parseFloat(filterMinPrice))) return false
      if (filterMaxPrice && (price == null || price > parseFloat(filterMaxPrice))) return false
      if (filterHasAlert && !item.price_alert_above && !item.price_alert_below) return false
      return true
    })

    result = [...result].sort((a, b) => {
      let valA, valB
      switch (sortBy) {
        case 'price': valA = a.card?.price_market ?? -1; valB = b.card?.price_market ?? -1; break
        case 'name': valA = (a.card?.name || '').toLowerCase(); valB = (b.card?.name || '').toLowerCase(); break
        case 'created_at': valA = a.created_at || ''; valB = b.created_at || ''; break
        default: return 0
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })

    return result
  }, [items, filterSet, filterRarity, filterMinPrice, filterMaxPrice, filterHasAlert, sortBy, sortOrder])

  const resetFilters = () => {
    setFilterSet(''); setFilterRarity(''); setFilterMinPrice(''); setFilterMaxPrice(''); setFilterHasAlert(false)
  }

  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Heart size={24} className="text-brand-red" />
            {t('wishlist.title')}
          </h1>
          <p className="text-sm text-text-secondary mt-1">{t('wishlist.subtitle')}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-20 rounded-xl" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="card text-center py-20">
          <Heart size={48} className="mx-auto mb-4 text-text-muted" />
          <p className="text-text-muted">{t('wishlist.empty')}</p>
          <p className="text-xs text-text-muted mt-1">{t('wishlist.emptyHint')}</p>
        </div>
      ) : (
        <>
          {/* Sort & Filter Bar */}
          <div className="card space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <SortAsc size={14} className="text-text-muted" />
                <select className="select text-sm py-1.5 w-40" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="created_at">{t('wishlist.sortAdded')}</option>
                  <option value="price">{t('wishlist.sortPrice')}</option>
                  <option value="name">{t('wishlist.sortName')}</option>
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

              <span className="text-xs text-text-muted ml-auto">{filtered.length} / {items.length}</span>
            </div>

            {showFilters && (
              <div className="pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('wishlist.filterSet')}</label>
                  <select className="select text-sm py-1.5" value={filterSet} onChange={(e) => setFilterSet(e.target.value)}>
                    <option value="">{t('wishlist.allSets')}</option>
                    {sets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('wishlist.filterRarity')}</label>
                  <select className="select text-sm py-1.5" value={filterRarity} onChange={(e) => setFilterRarity(e.target.value)}>
                    <option value="">{t('wishlist.allRarities')}</option>
                    {rarities.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('wishlist.filterMinPrice')}</label>
                  <input type="number" min="0" step="0.01" placeholder="0" value={filterMinPrice}
                    onChange={(e) => setFilterMinPrice(e.target.value)} className="input text-sm py-1.5" />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('wishlist.filterMaxPrice')}</label>
                  <input type="number" min="0" step="0.01" placeholder="∞" value={filterMaxPrice}
                    onChange={(e) => setFilterMaxPrice(e.target.value)} className="input text-sm py-1.5" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 cursor-pointer mt-4">
                    <input type="checkbox" checked={filterHasAlert} onChange={(e) => setFilterHasAlert(e.target.checked)}
                      className="w-4 h-4 accent-brand-red" />
                    <span className="text-xs text-text-secondary">{t('wishlist.filterHasAlert')}</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-text-muted">{t('wishlist.noResults')}</p>
            </div>
          ) : (
            <div className="card p-0 overflow-hidden">
              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-bg/50">
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('wishlist.card')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.set')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('wishlist.marketPrice')}</th>
                      <th className="text-center px-4 py-3 text-text-muted font-medium">{t('wishlist.priceAlerts')}</th>
                      <th className="text-center px-4 py-3 text-text-muted font-medium">{t('wishlist.lastNotified')}</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => {
                      const card = item.card
                      const price = card?.price_market
                      const alertAbove = price && item.price_alert_above && price >= item.price_alert_above
                      const alertBelow = price && item.price_alert_below && price <= item.price_alert_below

                      return (
                        <tr key={item.id} className="border-b border-border/50 hover:bg-bg-elevated/50 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-10 flex-shrink-0 rounded overflow-hidden">
                                {resolveCardImageUrl(card) ? (
                                  <img src={resolveCardImageUrl(card)} alt={card?.name} className="w-full h-full object-cover" />
                                ) : (
                                  <div className="w-full h-full bg-border" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-text-primary">{card?.name}</p>
                                {card?.rarity && <p className="text-xs text-text-muted">{card.rarity}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-text-secondary text-xs">{card?.set_ref?.name || '-'}</td>
                          <td className="px-4 py-3 text-right">
                            {price ? (
                              <span className={`font-bold ${alertAbove ? 'text-yellow' : alertBelow ? 'text-blue' : 'text-green'}`}>
                                {formatPrice(price)}
                              </span>
                            ) : (
                              <span className="text-text-muted">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {editingId === item.id ? (
                              <AlertEditor item={item} onDone={() => setEditingId(null)} />
                            ) : (
                              <div className="flex items-center justify-center gap-3">
                                {item.price_alert_above && (
                                  <span className="badge badge-yellow text-xs">↑ {formatPrice(item.price_alert_above)}</span>
                                )}
                                {item.price_alert_below && (
                                  <span className="badge badge-blue text-xs">↓ {formatPrice(item.price_alert_below)}</span>
                                )}
                                {!item.price_alert_above && !item.price_alert_below && (
                                  <span className="text-text-muted text-xs">{t('wishlist.noAlerts')}</span>
                                )}
                                <button onClick={() => setEditingId(item.id)} className="text-text-muted hover:text-text-primary transition-colors">
                                  <Edit2 size={12} />
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center text-xs text-text-muted">
                            {item.notified_at
                              ? new Date(item.notified_at).toLocaleDateString()
                              : <span className="text-text-muted">{t('wishlist.never')}</span>
                            }
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => addToColMutation.mutate(item.card_id)}
                                className="text-text-muted hover:text-green transition-colors p-1" title={t('wishlist.addToCollection')}>
                                <Check size={14} />
                              </button>
                              <button onClick={() => {
                                if (confirm(`${card?.name} ${t('wishlist.removeConfirm')}`)) removeMutation.mutate(item.id)
                              }} className="text-text-muted hover:text-brand-red transition-colors p-1">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Card Layout */}
              <div className="md:hidden space-y-2 p-2">
                {filtered.map((item) => {
                  const card = item.card
                  const price = card?.price_market
                  const alertAbove = price && item.price_alert_above && price >= item.price_alert_above
                  const alertBelow = price && item.price_alert_below && price <= item.price_alert_below

                  if (editingId === item.id) {
                    return (
                      <div key={item.id} className="bg-bg-card border border-border rounded-lg p-3 space-y-2">
                        <p className="text-sm font-medium text-text-primary truncate">{card?.name}</p>
                        <AlertEditor item={item} onDone={() => setEditingId(null)} />
                      </div>
                    )
                  }

                  const badges = []
                  if (item.price_alert_above) badges.push({ label: `↑ ${formatPrice(item.price_alert_above)}`, variant: 'yellow' })
                  if (item.price_alert_below) badges.push({ label: `↓ ${formatPrice(item.price_alert_below)}`, variant: 'blue' })
                  if (card?.rarity) badges.push({ label: card.rarity, variant: 'gray' })

                  return (
                    <CardListItem
                      key={item.id}
                      image={resolveCardImageUrl(card)}
                      name={card?.name}
                      subtext={card?.set_ref?.name || '-'}
                      badges={badges}
                      value={price ? formatPrice(price) : '-'}
                      rightAction={
                        <div className="flex flex-col gap-1">
                          <button onClick={(e) => { e.stopPropagation(); setEditingId(item.id) }}
                            className="text-text-muted hover:text-text-primary transition-colors p-1">
                            <Edit2 size={12} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); addToColMutation.mutate(item.card_id) }}
                            className="text-text-muted hover:text-green transition-colors p-1" title={t('wishlist.addToCollection')}>
                            <Check size={12} />
                          </button>
                          <button onClick={(e) => {
                            e.stopPropagation()
                            if (confirm(`${card?.name} ${t('wishlist.removeConfirm')}`)) removeMutation.mutate(item.id)
                          }} className="text-text-muted hover:text-brand-red transition-colors p-1">
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
        </>
      )}
    </div>
  )
}
