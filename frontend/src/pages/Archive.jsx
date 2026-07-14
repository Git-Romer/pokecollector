import { useQuery } from '@tanstack/react-query'
import { Card, ProgressBar, Text } from '@fluentui/react-components'
import { Link } from 'react-router-dom'
import { getDashboard, getSets } from '../api/client'
import CardImage from '../components/CardImage'
import ArchiveNote from '../components/ArchiveNote'
import { deriveArchiveInsights } from '../utils/archiveInsights'

const setTotal = (set) => set.total || set.total_cards || 0

export default function Archive() {
  const dashboardQuery = useQuery({ queryKey: ['dashboard'], queryFn: () => getDashboard().then((r) => r.data) })
  const setsQuery = useQuery({ queryKey: ['sets'], queryFn: () => getSets().then((r) => r.data) })
  const data = dashboardQuery.data || {}
  const sets = Array.isArray(setsQuery.data) ? setsQuery.data : (setsQuery.data?.items || [])
  const recent = data.recent_additions || []
  const near = [...sets]
    .filter((set) => setTotal(set))
    .sort((a, b) => {
      const aRemaining = setTotal(a) - (a.owned_count || 0)
      const bRemaining = setTotal(b) - (b.owned_count || 0)
      return aRemaining - bRemaining
    })
    .slice(0, 3)
  const notes = deriveArchiveInsights({ recentAdditions: recent, totalCards: data.total_cards || 0, sets })
  const featured = recent[0]
  const loading = dashboardQuery.isLoading || setsQuery.isLoading

  return <section className="archive-card-reveal space-y-10">
    <header><p className="text-sm text-text-muted">John John’s PC</p><h1 className="text-3xl font-semibold text-text-primary">Collection Overview</h1><p className="mt-2 text-text-secondary">Everything you’ve chosen to keep, right where it belongs.</p></header>
    {loading && <div className="archive-loading" role="status" aria-live="polite"><span className="archive-loading-orbit" aria-hidden="true" /><span>John John is opening the collection.</span></div>}
    {featured && <Card className="archive-featured"><div className="h-44 w-28 shrink-0 overflow-hidden rounded-lg"><CardImage src={featured.image_url || featured.image} alt={featured.name} /></div><div><Text weight="semibold">Featured addition</Text><h2 className="mt-2 text-2xl font-semibold">{featured.name}</h2><p className="mt-2 text-text-secondary">Recently filed in your archive.</p><Link className="mt-4 inline-block" to="/collection">View collection</Link></div></Card>}
    <section><div className="section-header"><h2 className="section-title">Recent additions</h2><Link to="/collection">View collection</Link></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{recent.slice(0, 6).map((card) => <Link key={card.id || card.card_id} to="/collection" className="archive-recent-card"><div className="aspect-[2/3] overflow-hidden rounded-lg"><CardImage src={card.image_url || card.image} alt={card.name} /></div><span>{card.name}</span></Link>)}</div></section>
    <section><div className="section-header"><h2 className="section-title">Set shelf</h2><Link to="/sets">All sets</Link></div><div className="grid gap-3 lg:grid-cols-3">{near.map((set) => { const total = setTotal(set); const owned = set.owned_count || 0; return <Card key={set.id}><Text weight="semibold">{set.name}</Text><p className="my-2 text-sm text-text-secondary">{Math.max(total - owned, 0)} cards left</p><ProgressBar value={total ? owned / total : 0} /><p className="mt-2 text-xs text-text-muted">{owned} of {total} filed</p></Card> })}</div></section>
    {notes.length > 0 && <section><div className="section-header"><h2 className="section-title">John John’s Notes</h2><span className="text-sm text-text-muted">John John is keeping watch.</span></div><div className="grid gap-3 lg:grid-cols-3">{notes.map((note) => <ArchiveNote key={note.id} note={note} />)}</div></section>}
  </section>
}
