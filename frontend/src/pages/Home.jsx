import SplitText from '../components/reactbits/SplitText'
import {useQuery} from '@tanstack/react-query'
import {useMemo, useState} from 'react'
import {ProgressBar, Text} from '@fluentui/react-components'
import {Link} from 'react-router-dom'
import {getDashboard, getSets} from '../api/client'

import CardImage from '../components/CardImage'
import ArchiveNote from '../components/ArchiveNote'
import AnimatedCard from '../components/reactbits/AnimatedCard'
import OrbitImages from '../components/reactbits/OrbitImages'
import ColorBends from '../components/reactbits/ColorBends'
import MagneticLink from '../components/originkit/MagneticLink'
import {useSettings} from '../contexts/SettingsContext'

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
const LOCAL_COLLECTION_NOTES = Object.freeze([
    {
        id: 'collection-care',
        title: 'Collection care',
        body: 'Keep storage locations, conditions, and the story behind each card current in this local collection.',
        href: '/collection',
    },
])
const FEATURED_CARD_STORAGE_KEY = 'john-johns-pc-featured-card-id'
const cardKey = (card) => String(card?.id || card?.card_id || card?.name || '')

function readPinnedFeaturedCardId() {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(FEATURED_CARD_STORAGE_KEY) || ''
}

export default function Home() {
    const {t} = useSettings()
    const dashboardQuery = useQuery({queryKey: ['dashboard'], queryFn: () => getDashboard().then((r) => r.data)})
    const setsQuery = useQuery({queryKey: ['sets'], queryFn: () => getSets().then((r) => r.data)})
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

    const [pinnedFeaturedCardId, setPinnedFeaturedCardId] = useState(readPinnedFeaturedCardId)
    const featured = useMemo(() => {
        if (!recent.length) return null
        return recent.find(card => cardKey(card) === pinnedFeaturedCardId) || recent[0]
    }, [pinnedFeaturedCardId, recent])
    const featuredImageStack = useMemo(() => {
        if (!featured) return recent.slice(0, 5)
        const selectedKey = cardKey(featured)
        return [featured, ...recent.filter(card => cardKey(card) !== selectedKey)].slice(0, 5)
    }, [featured, recent])
    const loading = dashboardQuery.isLoading || setsQuery.isLoading

    const pinFeaturedCard = (card) => {
        const nextId = cardKey(card)
        if (!nextId || typeof window === 'undefined') return
        window.localStorage.setItem(FEATURED_CARD_STORAGE_KEY, nextId)
        setPinnedFeaturedCardId(nextId)
    }

    // Counts only. The dashboard payload also carries total_value, total_cost
    // and pnl; none of them belong on this surface.
    const totalCards = data.total_cards ?? 0
    const uniqueCards = data.unique_cards ?? 0
    const totalSets = data.total_sets ?? 0

    return <section className="archive-card-reveal space-y-10" aria-label={t('archive.title')}>
        <header className="archive-anchor">
            <h1 className="archive-overview-title">{t('archive.title')}</h1>
            <p className="archive-anchor-lede">{t('archive.subtitle')}</p>
            <p className="archive-anchor-figure">
                <span className="archive-anchor-count">{totalCards}</span>
                <span className="archive-anchor-unit">{t('archive.cardsFiled')}</span>
            </p>
            <dl className="archive-anchor-stats">
                <div className="archive-anchor-stat">
                    <dt>{t('archive.uniqueCards')}</dt>
                    <dd>{uniqueCards}</dd>
                </div>
                <div className="archive-anchor-stat">
                    <dt>{t('archive.setsTracked')}</dt>
                    <dd>{totalSets}</dd>
                </div>
            </dl>
        </header>
        {loading &&
            <div className="archive-loading" role="status" aria-live="polite"><span className="archive-loading-orbit"
                                                                                    aria-hidden="true"/><SplitText
                text={t('archive.loading')} delay={30}/></div>}

        {recent.length > 0 && (
            <div className="archive-featured">
                <div className="archive-featured-copy">
                    <h2 className="text-5xl font-bold text-text-primary mag-heading uppercase leading-none">
                        <SplitText text={t('archive.latestTitle')} delay={40}/>
                    </h2>
                    <p className="archive-featured-note">
                        {t('archive.latestNote')}
                    </p>
                    {featured?.name && (() => {
                        const [before, name, after] = emphasise(t('archive.lastFiled'), featured.name)
                        return <p className="archive-featured-card">{before}<strong>{name}</strong>{after}</p>
                    })()}
                    {featured && (
                        <p className="mt-2 text-xs font-semibold text-text-muted">
                            {cardKey(featured) === pinnedFeaturedCardId ? 'Pinned Featured Card' : 'Latest card is featured until you pin one.'}
                        </p>
                    )}
                    <div className="mt-5 flex flex-wrap gap-3">
                        <MagneticLink className="archive-featured-action" to="/collection">
                            {t('archive.viewCollection')}
                        </MagneticLink>
                        {featured && (
                            <button type="button" className="btn-ghost" onClick={() => pinFeaturedCard(featured)}>
                                Pin Featured Card
                            </button>
                        )}
                    </div>
                </div>
                <ColorBends className="archive-featured-orbit" opacity={0.6}>
                    {/* Magazine-cover dressing, not data: hidden so the digits stop being
          read out as page content. */}
                    <div className="mag-barcode" aria-hidden="true">7390284719204</div>
                    <OrbitImages
                        images={featuredImageStack.map(c => c.image_url || c.image || '/cardback.jpg')}
                        centralText="∞"
                    />
                </ColorBends>
            </div>
        )}

        <section>
            <div className="section-header"><h2 className="section-title">{t('archive.recentAdditions')}</h2><Link
                to="/collection">{t('archive.viewCollection')}</Link></div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{recent.slice(0, 6).map((card) => {
                const isPinned = cardKey(card) === pinnedFeaturedCardId
                return <article key={card.id || card.card_id || card.name} className="space-y-2">
                    <Link to="/collection" className="polaroid-card block w-full">
                        <div className="aspect-[2/3] overflow-hidden border-2 border-black"><CardImage
                            src={card.image_url || card.image} alt={card.name}/></div>
                        <div
                            className="mt-4 font-bold text-center text-sm uppercase tracking-wide truncate px-2">{card.name}</div>
                    </Link>
                    <button
                        type="button"
                        className="btn-ghost w-full justify-center py-1 text-[11px]"
                        onClick={() => pinFeaturedCard(card)}
                        aria-pressed={isPinned}
                    >
                        {isPinned ? 'Pinned' : 'Pin featured'}
                    </button>
                </article>
            })}</div>
        </section>
        <section>
            <div className="section-header"><h2 className="section-title">{t('archive.setShelf')}</h2><Link
                to="/all-cards">{t('archive.allSets')}</Link></div>
            <div className="grid gap-3 lg:grid-cols-3">{near.map((set) => {
                const total = setTotal(set);
                const owned = set.owned_count || 0;
                return <AnimatedCard key={set.id} className="p-4 flex flex-col gap-2"><Text
                    weight="semibold">{set.name}</Text><p
                    className="my-2 text-sm text-text-secondary">{t('archive.cardsLeft', {count: Math.max(total - owned, 0)})}</p>
                    <ProgressBar value={total ? owned / total : 0}/><p
                        className="mt-2 text-xs text-text-muted">{t('archive.filedOfTotal', {owned, total})}</p>
                </AnimatedCard>
            })}</div>
        </section>
        <section>
            <div className="section-header"><h2 className="section-title"><SplitText text={t('archive.notesTitle')}
                                                                                     delay={80}/></h2><span
                className="text-sm text-text-muted">{t('archive.keepingWatch')}</span></div>
            <div className="grid gap-3 lg:grid-cols-3">{LOCAL_COLLECTION_NOTES.map((note) => <ArchiveNote
                key={note.id}
                note={note}
            />)}</div>
        </section>
    </section>
}
