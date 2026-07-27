import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen } from 'lucide-react'
import { getPublicProfiles } from '../api/publicClient'
import PokeBallLoader from '../components/PokeBallLoader'
import { useSettings } from '../contexts/SettingsContext'

function PublicAvatar({ profile }) {
  if (profile.avatar_id) {
    return (
      <img
        src={`/api/pokedex/images/sprites/${profile.avatar_id}.png`}
        alt=""
        className="h-14 w-14 flex-shrink-0 pixelated"
      />
    )
  }
  return <img src="/pokeball.svg" alt="" className="h-12 w-12 flex-shrink-0 opacity-60" />
}

export default function PublicDirectory() {
  const [profiles, setProfiles] = useState(null)
  const [error, setError] = useState(false)
  const { t } = useSettings()

  useEffect(() => {
    let cancelled = false
    getPublicProfiles()
      .then(data => { if (!cancelled) setProfiles(data) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [])

  if (error) {
    return <div className="flex min-h-screen items-center justify-center text-text-secondary">{t('publicProfiles.directoryUnavailable')}</div>
  }
  if (!profiles) {
    return <div className="flex min-h-screen items-center justify-center"><PokeBallLoader size={48} /></div>
  }

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-8 text-text-primary">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-lg">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted">{t('publicProfiles.directoryEyebrow')}</p>
          <h1 className="mt-1 text-2xl font-bold">{t('publicProfiles.directory')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('publicProfiles.directoryDesc')}</p>
        </header>

        {profiles.length === 0 ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-text-secondary">
            {t('publicProfiles.noPublicProfiles')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {profiles.map(profile => (
              <Link
                key={profile.handle}
                to={`/u/${profile.handle}`}
                className="flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm transition hover:-translate-y-0.5 hover:bg-bg-elevated"
              >
                <PublicAvatar profile={profile} />
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{profile.trainer_name}</h2>
                  <p className="truncate text-xs text-text-muted">@{profile.handle}</p>
                  <p className="mt-2 flex items-center gap-1.5 text-sm text-text-secondary">
                    <BookOpen size={14} />
                    {profile.binder_count} {profile.binder_count === 1 ? t('publicProfiles.sharedBinderCount') : t('publicProfiles.sharedBindersCount')}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
