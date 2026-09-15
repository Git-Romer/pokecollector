import { useEffect, useState } from 'react'
import { useLocation, useParams, Link } from 'react-router-dom'
import { Layers3, PackageCheck } from 'lucide-react'
import { getPublicProfile } from '../api/publicClient'
import { formatEur } from '../utils/formatEur'
import { formatBinderCountSummary } from '../utils/binderCounts'
import { useSettings } from '../contexts/SettingsContext'
import PublicProfileShell from '../components/public/PublicProfileShell'

export default function PublicProfile() {
  const { handle } = useParams()
  const location = useLocation()
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const { t } = useSettings()

  useEffect(() => {
    let cancelled = false
    setProfile(null)
    setError(null)
    getPublicProfile(handle)
      .then(data => { if (!cancelled) setProfile(data) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [handle])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('publicProfiles.profileUnavailable')}</div>
  if (!profile) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('common.loading')}</div>

  const showDecks = location.pathname.endsWith('/decks')

  return (
    <PublicProfileShell profile={profile} handle={handle} activeSection={showDecks ? 'decks' : 'binders'} t={t}>
      {showDecks ? (
        profile.decks.length === 0 ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-text-secondary">{t('publicProfiles.noSharedDecks')}</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {profile.decks.map(deck => {
              const Icon = deck.binder_type === 'physical_deck' ? PackageCheck : Layers3
              return <Link key={deck.id} to={`/u/${handle}/deck/${deck.id}`} className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm transition hover:-translate-y-0.5 hover:bg-bg-elevated" style={{ borderLeftColor: deck.color, borderLeftWidth: 4 }}>
                <div className="flex items-start gap-3"><Icon size={20} className="mt-0.5 text-brand-red" /><div><div className="font-semibold">{deck.name}</div><div className="mt-1 text-sm text-text-secondary">{t(`binderTypes.${deck.binder_type === 'physical_deck' ? 'realDeck' : 'plannedDeck'}`)} · {t(`decks.format${deck.format}`)} · {deck.card_count}/{deck.target_size}</div>{deck.description && <p className="mt-2 text-xs text-text-muted line-clamp-2">{deck.description}</p>}</div></div>
              </Link>
            })}
          </div>
        )
      ) : <>
        {profile.binders.length === 0 && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-text-secondary">
            {t('publicProfiles.noSharedBinders')}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {profile.binders.map(binder => (
            <Link key={binder.id} to={`/u/${handle}/binder/${binder.id}`}
                  className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm transition hover:-translate-y-0.5 hover:bg-bg-elevated"
                  style={{ borderLeftColor: binder.color, borderLeftWidth: 4 }}>
              <div className="font-semibold">{binder.name}</div>
              <div className="mt-1 text-sm text-text-secondary">
                {formatBinderCountSummary(binder.card_count, binder.unique_card_count, t)}
                {binder.total_value != null ? ` · ${formatEur(binder.total_value)}` : ''}
              </div>
            </Link>
          ))}
        </div>
      </>}
    </PublicProfileShell>
  )
}
