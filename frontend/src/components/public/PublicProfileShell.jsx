import { BookOpen, Heart, Layers3 } from 'lucide-react'
import TabNav from '../TabNav'

export default function PublicProfileShell({ profile, handle, activeSection, t, children }) {
  const tabs = [
    { to: `/u/${handle}`, label: t('publicProfiles.binders'), icon: BookOpen, exact: true, active: activeSection === 'binders' },
    ...(profile.wishlist_is_public ? [{ to: `/u/${handle}/wishlist`, label: t('publicProfiles.wishlist'), icon: Heart, badge: profile.wishlist_count, active: activeSection === 'wishlist' }] : []),
    ...(profile.decks?.length ? [{ to: `/u/${handle}/decks`, label: t('publicProfiles.decks'), icon: Layers3, badge: profile.decks.length, active: activeSection === 'decks' }] : []),
  ]

  return (
    <main className="min-h-screen bg-bg-primary px-4 py-8 text-text-primary">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-lg">
          {profile.avatar_id && (
            <img src={`/api/pokedex/images/sprites/${profile.avatar_id}.png`} alt="" className="h-16 w-16 pixelated" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted">{t('publicProfiles.publicProfile')}</p>
            <h1 className="truncate text-2xl font-bold">{profile.trainer_name}</h1>
            <p className="text-sm text-text-secondary">@{profile.handle}</p>
          </div>
        </div>
        <TabNav tabs={tabs} />
        {children}
      </div>
    </main>
  )
}
