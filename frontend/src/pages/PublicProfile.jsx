import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getPublicProfile } from '../api/publicClient'
import { formatEur } from '../utils/formatEur'

export default function PublicProfile() {
  const { handle } = useParams()
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getPublicProfile(handle)
      .then(data => { if (!cancelled) setProfile(data) })
      .catch(() => { if (!cancelled) setError('This profile is not available.') })
    return () => { cancelled = true }
  }, [handle])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{error}</div>
  if (!profile) return <div className="min-h-screen flex items-center justify-center text-text-secondary">Loading…</div>

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex items-center gap-3 mb-6">
        {profile.avatar_id && (
          <img src={`/api/pokedex/images/sprites/${profile.avatar_id}.png`} alt="" className="w-14 h-14" />
        )}
        <h1 className="text-2xl font-bold">{profile.trainer_name}</h1>
      </div>
      {profile.binders.length === 0 && (
        <p className="text-text-secondary">No shared binders yet.</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {profile.binders.map(binder => (
          <Link key={binder.id} to={`/u/${handle}/binder/${binder.id}`}
                className="rounded-lg border border-border p-4 hover:bg-bg-secondary"
                style={{ borderLeftColor: binder.color, borderLeftWidth: 4 }}>
            <div className="font-semibold">{binder.name}</div>
            <div className="text-sm text-text-secondary">
              {binder.unique_card_count} cards
              {binder.total_value != null ? ` · ${formatEur(binder.total_value)}` : ''}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
