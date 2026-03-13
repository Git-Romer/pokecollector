import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Award } from 'lucide-react'
import { getAchievements } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

function TrainerAvatar({ avatarId, username }) {
  if (!avatarId) {
    return <img src="/pokeball.svg" alt={username} className="h-14 w-14 rounded-full border border-border bg-bg-card p-3" />
  }

  return (
    <img
      src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${avatarId}.gif`}
      alt={username}
      className="h-14 w-14 rounded-full border border-border bg-bg-card p-1 pixelated"
    />
  )
}

export default function Achievements() {
  const { userId } = useParams()
  const { user } = useAuth()
  const { t } = useSettings()
  const activeUserId = userId || user?.id

  const { data, isLoading, error } = useQuery({
    queryKey: ['achievements', activeUserId],
    queryFn: () => getAchievements(activeUserId).then((response) => response.data),
    enabled: Boolean(activeUserId),
  })

  const earnedLabel = useMemo(() => {
    const earned = Number(data?.earned ?? 0)
    const total = Number(data?.total ?? 20)
    return `${earned}/${total} ${t('achievements.earned')}`
  }, [data, t])

  return (
    <div className="page-container">
      <div className="card relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(255,138,101,0.16),transparent_40%)]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <TrainerAvatar avatarId={data?.avatar_id || user?.avatar_id} username={data?.username || user?.username || 'Trainer'} />
            <div>
              <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary">
                <Award size={22} className="text-yellow" />
                {t('achievements.title')}
              </h1>
              <p className="mt-1 text-sm text-text-secondary">{data?.username || user?.username}</p>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-bg-primary/70 px-4 py-3 text-sm font-semibold text-yellow">
            {earnedLabel}
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[...Array(6)].map((_, index) => <div key={index} className="skeleton h-48 rounded-2xl" />)}
        </div>
      ) : error ? (
        <div className="card text-sm text-brand-red">Failed to load achievements.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.achievements.map((achievement) => {
            const progress = Number(achievement.progress ?? 0)
            const target = Number(achievement.target ?? 1)
            const progressPct = Math.min((progress / target) * 100, 100)
            return (
              <div
                key={achievement.id}
                className={`rounded-2xl border p-4 transition-all ${
                  achievement.unlocked
                    ? 'border-yellow/40 bg-bg-card shadow-[0_0_24px_rgba(255,213,79,0.12)]'
                    : 'border-border bg-bg-card opacity-70'
                }`}
              >
                <div className="flex items-start gap-3">
                  <img
                    src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/badges/${achievement.badge_id}.png`}
                    alt={t(achievement.name_key)}
                    className={`h-14 w-14 flex-shrink-0 ${achievement.unlocked ? '' : 'grayscale opacity-50'}`}
                    loading="lazy"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="font-semibold text-text-primary">{t(achievement.name_key)}</h2>
                      <span className={`badge ${achievement.unlocked ? 'badge-yellow' : 'badge-gray'}`}>
                        {achievement.unlocked ? t('achievements.earned') : t('achievements.locked')}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{t(achievement.description_key)}</p>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
                    <span>{t('achievements.progress')}</span>
                    <span>{progress}/{target}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-bg-primary">
                    <div
                      className={`h-full rounded-full transition-all ${achievement.unlocked ? 'bg-yellow' : 'bg-text-muted'}`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
