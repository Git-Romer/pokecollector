import SplitText from '../components/reactbits/SplitText'
import { useQuery } from '@tanstack/react-query'
import { Card, ProgressBar, Text } from '@fluentui/react-components'
import { Link } from 'react-router-dom'
import { getDashboard, getSets } from '../api/client'

import CardImage from '../components/CardImage'
import ArchiveNote from '../components/ArchiveNote'
import AnimatedCard from '../components/reactbits/AnimatedCard'
import OrbitImages from '../components/reactbits/OrbitImages'
import ColorBends from '../components/reactbits/ColorBends'

export const COLLECTION_OVERVIEW_COPY = {
  kicker: 'COLLECTION OVERVIEW',
  title: 'Collection Overview',
  subtitle: 'Everything you’ve chosen to keep, right where it belongs.',
  notesTitle: 'John John’s Notes',
}

const setTotal = (set) => set.total || set.total_cards || 0

export default function Home() {
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

  const { data: agentNotes } = useQuery({
    queryKey: ['agent-notes'],
    queryFn: () => fetch('/api/agent/notes').then(r => r.json()),
  })
  const notes = agentNotes || []

  const featured = recent[0]
  const loading = dashboardQuery.isLoading || setsQuery.isLoading

  return <section className="archive-card-reveal space-y-10">
    <header><span className="mag-issue">{COLLECTION_OVERVIEW_COPY.kicker}</span><h1 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none mt-2"><SplitText text={COLLECTION_OVERVIEW_COPY.title} delay={40} /></h1><p className="mt-2 text-text-secondary">{COLLECTION_OVERVIEW_COPY.subtitle}</p></header>
    {loading && <div className="archive-loading" role="status" aria-live="polite"><span className="archive-loading-orbit" aria-hidden="true" /><SplitText text="John John is opening the collection..." delay={30} /></div>}
    
{recent.length > 0 && (
  <div className="archive-featured">
    <div className="archive-featured-copy">
      <span className="mag-issue">VOL. 01 · THE LATEST DROPS</span>
      <h2 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none mt-2">
        <SplitText text="THE LATEST DROPS" delay={40} />
      </h2>
      <p className="archive-featured-note">
        Fresh ink. New arrivals straight to the archive.
      </p>
      {featured?.name && <p className="archive-featured-card">John John filed <strong>{featured.name}</strong> first.</p>}
      <Link className="archive-featured-action" to="/collection">
        Access Full Archive
      </Link>
    </div>
    <ColorBends className="archive-featured-orbit" opacity={0.6}>
      <div className="mag-barcode">7390284719204</div>
      <OrbitImages 
        images={recent.slice(0, 5).map(c => c.image_url || c.image || '/cardback.jpg')} 
        centralText="JJ" 
      />
    </ColorBends>
  </div>
)}

    <section><div className="section-header"><h2 className="section-title">Recent additions</h2><Link to="/collection">View collection</Link></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{recent.slice(0, 6).map((card) => <Link key={card.id || card.card_id} to="/collection" className="polaroid-card block w-full" style={{ '--rand': Math.random() }}><div className="aspect-[2/3] overflow-hidden border-2 border-black"><CardImage src={card.image_url || card.image} alt={card.name} /></div><div className="mt-4 font-bold text-center text-sm uppercase tracking-wide truncate px-2">{card.name}</div></Link>)}</div></section>
    <section><div className="section-header"><h2 className="section-title">Set shelf</h2><Link to="/sets">All sets</Link></div><div className="grid gap-3 lg:grid-cols-3">{near.map((set) => { const total = setTotal(set); const owned = set.owned_count || 0; return <AnimatedCard key={set.id} className="p-4 flex flex-col gap-2"><Text weight="semibold">{set.name}</Text><p className="my-2 text-sm text-text-secondary">{Math.max(total - owned, 0)} cards left</p><ProgressBar value={total ? owned / total : 0} /><p className="mt-2 text-xs text-text-muted">{owned} of {total} filed</p></AnimatedCard> })}</div></section>
    {notes.length > 0 && <section><div className="section-header"><h2 className="section-title"><SplitText text={COLLECTION_OVERVIEW_COPY.notesTitle} delay={80} /></h2><span className="text-sm text-text-muted">John John is keeping watch.</span></div><div className="grid gap-3 lg:grid-cols-3">{notes.map((note) => <ArchiveNote key={note.id} note={note} />)}</div></section>}
  </section>
}

