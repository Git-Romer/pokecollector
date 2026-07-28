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
import MagneticLink from '../components/originkit/MagneticLink'
import { useSettings } from '../contexts/SettingsContext'

/**
 * Splits a translated sentence around its {name} placeholder so the card name
 * can carry emphasis without breaking word order in other languages.
 */
function emphasise(sentence, value) {
  // Written as an escape, not a literal NUL byte: the raw character made the
  // file read as binary to grep/diff. A codepoint no translation can contain
  // is still the point - an empty string here would split every character.
  const SENTINEL = '\u0000'
  const [before = '', after = ''] = sentence.replace('{name}', SENTINEL).split(SENTINEL)
  return [before, value, after]
}

const setTotal = (set) => set.total || set.total_cards || 0

export default function Home() {
  const { t } = useSettings()
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
    {/* No kicker above these headings: it repeated the heading text verbatim,
        so the page announced its own name twice in a row. */}
    <header><h1 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none"><SplitText text={t('archive.title')} delay={40} /></h1><p className="mt-2 text-text-secondary">{t('archive.subtitle')}</p></header>
    {loading && <div className="archive-loading" role="status" aria-live="polite"><span className="archive-loading-orbit" aria-hidden="true" /><SplitText text={t('archive.loading')} delay={30} /></div>}
    
{recent.length > 0 && (
  <div className="archive-featured">
    <div className="archive-featured-copy">
      <h2 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none">
        <SplitText text={t('archive.latestTitle')} delay={40} />
      </h2>
      <p className="archive-featured-note">
        {t('archive.latestNote')}
      </p>
      {featured?.name && (() => {
        const [before, name, after] = emphasise(t('archive.lastFiled'), featured.name)
        return <p className="archive-featured-card">{before}<strong>{name}</strong>{after}</p>
      })()}
      <MagneticLink className="archive-featured-action" to="/collection">
        {t('archive.viewCollection')}
      </MagneticLink>
    </div>
    <ColorBends className="archive-featured-orbit" opacity={0.6}>
      {/* Magazine-cover dressing, not data: hidden so the digits stop being
          read out as page content. */}
      <div className="mag-barcode" aria-hidden="true">7390284719204</div>
      <OrbitImages 
        images={recent.slice(0, 5).map(c => c.image_url || c.image || '/cardback.jpg')} 
        centralText="∞" 
      />
    </ColorBends>
  </div>
)}

    <section><div className="section-header"><h2 className="section-title">{t('archive.recentAdditions')}</h2><Link to="/collection">{t('archive.viewCollection')}</Link></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{recent.slice(0, 6).map((card) => <Link key={card.id || card.card_id} to="/collection" className="polaroid-card block w-full" style={{ '--rand': Math.random() }}><div className="aspect-[2/3] overflow-hidden border-2 border-black"><CardImage src={card.image_url || card.image} alt={card.name} /></div><div className="mt-4 font-bold text-center text-sm uppercase tracking-wide truncate px-2">{card.name}</div></Link>)}</div></section>
    <section><div className="section-header"><h2 className="section-title">{t('archive.setShelf')}</h2><Link to="/sets">{t('archive.allSets')}</Link></div><div className="grid gap-3 lg:grid-cols-3">{near.map((set) => { const total = setTotal(set); const owned = set.owned_count || 0; return <AnimatedCard key={set.id} className="p-4 flex flex-col gap-2"><Text weight="semibold">{set.name}</Text><p className="my-2 text-sm text-text-secondary">{t('archive.cardsLeft', { count: Math.max(total - owned, 0) })}</p><ProgressBar value={total ? owned / total : 0} /><p className="mt-2 text-xs text-text-muted">{t('archive.filedOfTotal', { owned, total })}</p></AnimatedCard> })}</div></section>
    {notes.length > 0 && <section><div className="section-header"><h2 className="section-title"><SplitText text={t('archive.notesTitle')} delay={80} /></h2><span className="text-sm text-text-muted">{t('archive.keepingWatch')}</span></div><div className="grid gap-3 lg:grid-cols-3">{notes.map((note) => <ArchiveNote key={note.id} note={note} />)}</div></section>}
  </section>
}

