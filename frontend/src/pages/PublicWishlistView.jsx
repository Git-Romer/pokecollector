import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { getPublicProfile, getPublicWishlist } from '../api/publicClient'
import CardListGallery from '../components/card-lists/CardListGallery'
import PublicProfileShell from '../components/public/PublicProfileShell'
import { useSettings } from '../contexts/SettingsContext'
import { useDebouncedValue } from '../hooks/useDebouncedValue'

export default function PublicWishlistView() {
  const { handle } = useParams()
  const { t, formatPrice, language } = useSettings()
  const [profile, setProfile] = useState(null)
  const [wishlist, setWishlist] = useState(null)
  const [profileError, setProfileError] = useState(false)
  const [wishlistError, setWishlistError] = useState(false)
  const [search, setSearch] = useState('')
  const [setId, setSetId] = useState('')
  const [rarity, setRarity] = useState('')
  const [sort, setSort] = useState('date_added')
  const [order, setOrder] = useState('desc')
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebouncedValue(search.trim(), 300)

  useEffect(() => {
    let cancelled = false
    setProfile(null)
    setProfileError(false)
    getPublicProfile(handle)
      .then(data => { if (!cancelled) setProfile(data) })
      .catch(() => { if (!cancelled) setProfileError(true) })
    return () => { cancelled = true }
  }, [handle])

  useEffect(() => {
    let cancelled = false
    setWishlistError(false)
    getPublicWishlist(handle, { search: debouncedSearch || undefined, set_id: setId || undefined, rarity: rarity || undefined, sort, order, page, page_size: 48 })
      .then(data => { if (!cancelled) setWishlist(data) })
      .catch(() => { if (!cancelled) setWishlistError(true) })
    return () => { cancelled = true }
  }, [handle, debouncedSearch, setId, rarity, sort, order, page])

  if (profileError || wishlistError) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('publicProfiles.wishlistUnavailable')}</div>
  const requestedHandle = (handle || '').toLowerCase()
  if (
    !profile
    || !wishlist
    || (profile.handle || '').toLowerCase() !== requestedHandle
    || (wishlist.handle || '').toLowerCase() !== requestedHandle
  ) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('common.loading')}</div>

  const pages = Math.max(1, Math.ceil(wishlist.total / wishlist.page_size))
  const changeFilter = setter => value => { setter(value); setPage(1) }
  const publicWishlistDate = entry => {
    if (!entry.date_added) return null
    const date = new Intl.DateTimeFormat(language || 'en', { dateStyle: 'medium' }).format(new Date(entry.date_added))
    return t('publicProfiles.addedOn').replace('{date}', date)
  }

  return (
    <PublicProfileShell profile={profile} handle={handle} activeSection="wishlist" t={t}>
      <div className="mb-4 rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm">
        <div className="mb-4"><h2 className="text-xl font-bold">{t('publicProfiles.wishlist')}</h2><p className="text-sm text-text-secondary">{t('publicProfiles.wishlistCount').replace('{count}', wishlist.total)}</p></div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="relative lg:col-span-2"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" /><input className="input pl-9" value={search} onChange={event => changeFilter(setSearch)(event.target.value)} placeholder={t('publicProfiles.searchWishlist')} /></label>
          <select className="select" value={setId} onChange={event => changeFilter(setSetId)(event.target.value)}><option value="">{t('publicProfiles.allSets')}</option>{wishlist.sets.map(set => <option key={set.id} value={set.id}>{set.name}</option>)}</select>
          <select className="select" value={rarity} onChange={event => changeFilter(setRarity)(event.target.value)}><option value="">{t('publicProfiles.allRarities')}</option>{wishlist.rarities.map(value => <option key={value} value={value}>{value}</option>)}</select>
          <select className="select" value={`${sort}:${order}`} onChange={event => { const [nextSort, nextOrder] = event.target.value.split(':'); setSort(nextSort); setOrder(nextOrder); setPage(1) }}>
            <option value="date_added:desc">{t('publicProfiles.newest')}</option><option value="date_added:asc">{t('publicProfiles.oldest')}</option><option value="name:asc">{t('publicProfiles.nameAsc')}</option><option value="set:asc">{t('publicProfiles.setOrder')}</option><option value="rarity:asc">{t('publicProfiles.rarityOrder')}</option>{wishlist.show_values && <><option value="price:desc">{t('publicProfiles.priceHigh')}</option><option value="price:asc">{t('publicProfiles.priceLow')}</option></>}
          </select>
        </div>
      </div>
      {wishlist.cards.length ? <CardListGallery entries={wishlist.cards} mode="public" t={t} formatPrice={formatPrice} publicQuantityLabel={quantity => t('publicProfiles.wantedQuantity').replace('{count}', quantity)} publicDetailLabel={publicWishlistDate} /> : <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-text-secondary">{t('publicProfiles.noWishlistCards')}</div>}
      {pages > 1 && <div className="mt-5 flex items-center justify-center gap-3"><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /> {t('publicProfiles.previous')}</button><span className="text-sm text-text-secondary">{page} / {pages}</span><button className="btn-ghost" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>{t('publicProfiles.next')} <ChevronRight size={16} /></button></div>}
    </PublicProfileShell>
  )
}
