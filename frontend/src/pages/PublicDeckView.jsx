import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Layers3, PackageCheck } from 'lucide-react'
import { getPublicDeck, getPublicDeckProbability, getPublicProfile } from '../api/publicClient'
import CardListGallery from '../components/card-lists/CardListGallery'
import DeckAnalyticsPanel from '../components/decks/DeckAnalyticsPanel'
import DeckCompositionBar from '../components/decks/DeckCompositionBar'
import DeckValidationPanel from '../components/decks/DeckValidationPanel'
import PublicProfileShell from '../components/public/PublicProfileShell'
import { useSettings } from '../contexts/SettingsContext'

export default function PublicDeckView() {
  const { handle, deckId } = useParams()
  const { t, formatPrice } = useSettings()
  const [profile, setProfile] = useState(null)
  const [deck, setDeck] = useState(null)
  const [error, setError] = useState(false)
  const [view, setView] = useState('cards')
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))

  useEffect(() => {
    let cancelled = false
    setError(false)
    Promise.all([getPublicProfile(handle), getPublicDeck(handle, deckId)])
      .then(([profileData, deckData]) => { if (!cancelled) { setProfile(profileData); setDeck(deckData) } })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [handle, deckId])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('publicProfiles.deckUnavailable')}</div>
  if (!profile || !deck) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('common.loading')}</div>

  const DeckIcon = deck.binder_type === 'physical_deck' ? PackageCheck : Layers3
  const progress = {
    current: deck.card_count,
    target: deck.target_size,
    remaining: deck.remaining_to_target,
    over: deck.over_target_by,
    status: deck.status,
    missing: 0,
  }
  const probabilityFetcher = (_id, params) => getPublicDeckProbability(handle, deckId, params)

  return (
    <PublicProfileShell profile={profile} handle={handle} activeSection="decks" t={t}>
      <Link to={`/u/${handle}/decks`} className="btn-ghost mb-4 inline-flex py-1.5 text-sm"><ArrowLeft size={14} /> {t('publicProfiles.backToDecks')}</Link>
      <section className="mb-4 rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex gap-3"><DeckIcon className="mt-1 text-brand-red" size={24} /><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted">{t('publicProfiles.sharedDeck')}</p><h2 className="text-2xl font-bold">{deck.name}</h2><p className="mt-1 text-sm text-text-secondary">{t(`binderTypes.${deck.binder_type === 'physical_deck' ? 'realDeck' : 'plannedDeck'}`)} · {t(`decks.format${deck.format}`)}</p></div></div><DeckValidationPanel validation={deck.validation} t={t} compact /></div>
        {deck.description && <p className="mt-3 border-t border-border pt-3 text-sm text-text-secondary">{deck.description}</p>}
      </section>
      <DeckCompositionBar entries={deck.entries} compositionCounts={deck.composition_counts} progress={progress} t={t} label={label} />
      <div className="my-4 inline-flex rounded-xl border border-border bg-bg-card p-1" role="tablist"><button type="button" role="tab" aria-selected={view === 'cards'} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'cards' ? 'bg-brand-red text-white' : 'text-text-secondary'}`} onClick={() => setView('cards')}>{t('publicProfiles.cards')}</button><button type="button" role="tab" aria-selected={view === 'analytics'} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view === 'analytics' ? 'bg-brand-red text-white' : 'text-text-secondary'}`} onClick={() => setView('analytics')}>{t('decks.analytics')}</button></div>
      {view === 'cards' ? <CardListGallery entries={deck.entries} mode="public" t={t} formatPrice={formatPrice} publicQuantityLabel={quantity => t('publicProfiles.deckQuantity').replace('{count}', quantity)} /> : <DeckAnalyticsPanel analysis={deck.analysis} deckId={deckId} entries={deck.entries} t={t} probabilityFetcher={probabilityFetcher} probabilityQueryKey={`public-deck-probability-${handle}`} showComparison={false} />}
    </PublicProfileShell>
  )
}
