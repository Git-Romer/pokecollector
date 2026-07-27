import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPublicProfile } from '../api/publicClient'
import { formatEur } from '../utils/formatEur'
import { useSettings } from '../contexts/SettingsContext'
import PublicHomeButton from '../components/PublicHomeButton'

export default function PublicProfile() {
  const { handle } = useParams()
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

  if (error) return <><PublicHomeButton /><div className="min-h-screen flex items-center justify-center text-text-secondary">{t('publicProfiles.profileUnavailable')}</div></>
  if (!profile) return <><PublicHomeButton /><div className="min-h-screen flex items-center justify-center text-text-secondary">{t('common.loading')}</div></>

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-8 text-text-primary">
      <PublicHomeButton />
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-lg">
          {profile.avatar_id && (
            <img src={`/api/pokedex/images/sprites/${profile.avatar_id}.png`} alt="" className="h-16 w-16 pixelated" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted">{t('publicProfiles.publicCollection')}</p>
            <h1 className="truncate text-2xl font-bold">{profile.trainer_name}</h1>
            <p className="text-sm text-text-secondary">@{profile.handle}</p>
          </div>
        </div>
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
                {binder.unique_card_count} {binder.unique_card_count === 1 ? t('binders.card') : t('binders.cards')}
                {binder.total_value != null ? ` · ${formatEur(binder.total_value)}` : ''}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}
