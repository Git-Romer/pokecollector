import { useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpDown, Trophy, Award } from 'lucide-react'
import { getLeaderboard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import TabNav from '../components/TabNav'
import { resolveCardImageUrl } from '../utils/imageUrl'

const SORT_OPTIONS = ['total_value', 'total_cards', 'unique_cards', 'sets_completed', 'pnl']

function rankLabel(rank) {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return `#${rank}`
}

function TrainerAvatar({ avatarId, username }) {
  if (!avatarId) {
    return <img src="/pokeball.svg" alt={username} className="h-12 w-12 rounded-full border border-border bg-bg-card p-2" />
  }

  return (
    <img
      src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${avatarId}.gif`}
      alt={username}
      className="h-12 w-12 rounded-full border border-border bg-bg-card p-1 pixelated"
    />
  )
}

export default function Leaderboard() {
  const navigate = useNavigate()
  const { t, formatPrice } = useSettings()
  const { multiUser } = useAuth()
  const [sortBy, setSortBy] = useState('total_value')
  const SOCIAL_TABS = [
    { to: '/leaderboard', label: t('nav.leaderboard'), icon: Trophy },
    { to: '/achievements', label: t('nav.achievements'), icon: Award },
  ]

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['leaderboard'],
    queryFn: () => getLeaderboard().then((response) => response.data),
  })

  const rows = useMemo(() => {
    return [...data].sort((a, b) => {
      const left = Number(a?.[sortBy] ?? 0)
      const right = Number(b?.[sortBy] ?? 0)
      if (right !== left) return right - left
      return Number(b?.total_value ?? 0) - Number(a?.total_value ?? 0)
    })
  }, [data, sortBy])

  if (!multiUser) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="page-container">
      <TabNav tabs={SOCIAL_TABS} />
      <div className="card relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(255,213,79,0.16),transparent_40%)]" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
              <Trophy size={22} className="text-yellow" />
              {t('leaderboard.title')}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">{rows.length} trainers</p>
          </div>
          <div className="w-full max-w-[220px]">
            <label className="mb-1 block text-xs text-text-muted">{t('leaderboard.sortBy')}</label>
            <div className="relative">
              <ArrowUpDown size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <select className="select pl-9" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {SORT_OPTIONS.map((key) => (
                  <option key={key} value={key}>{t(`leaderboard.${key === 'total_value' ? 'value' : key === 'total_cards' ? 'cards' : key === 'unique_cards' ? 'uniqueCards' : key === 'sets_completed' ? 'setsCompleted' : 'pnl'}`)}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, index) => <div key={index} className="skeleton h-28 rounded-2xl" />)}
        </div>
      ) : error ? (
        <div className="card text-sm text-brand-red">Failed to load leaderboard.</div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-16 text-text-muted">No trainers found.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((trainer, index) => {
            const bestCard = trainer.most_valuable_card
            const pnl = Number(trainer.pnl ?? 0)
            const positive = pnl >= 0
            return (
              <button
                key={trainer.user_id}
                type="button"
                onClick={() => navigate(`/leaderboard/compare/${trainer.user_id}`)}
                className="w-full rounded-2xl border border-border bg-bg-card p-4 text-left transition-all hover:border-yellow/40 hover:bg-bg-elevated"
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="flex h-12 min-w-12 items-center justify-center rounded-2xl bg-bg-primary text-lg font-black">
                      {rankLabel(index + 1)}
                    </div>
                    <TrainerAvatar avatarId={trainer.avatar_id} username={trainer.username} />
                    <div>
                      <p className="text-lg font-semibold text-text-primary">{trainer.username}</p>
                      <p className="text-xs uppercase tracking-[0.2em] text-text-muted">{trainer.role}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:items-center">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{t('leaderboard.value')}</p>
                      <p className="mt-1 text-sm font-semibold text-yellow">{formatPrice(trainer.total_value)}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{t('leaderboard.cards')}</p>
                      <p className="mt-1 text-sm font-semibold text-text-primary">{Number(trainer.total_cards ?? 0).toLocaleString()}</p>
                    </div>
                    <div className="col-span-2 md:col-span-1">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{t('leaderboard.bestCard')}</p>
                      {bestCard ? (
                        <div className="mt-1 flex items-center gap-2">
                          <div className="h-10 w-8 overflow-hidden rounded-lg border border-border bg-bg-primary">
                            <img src={resolveCardImageUrl(bestCard)} alt={bestCard.name} className="h-full w-full object-cover" loading="lazy" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-text-primary">{bestCard.name}</p>
                            <p className="text-xs text-text-muted">{formatPrice(bestCard.price_market)}</p>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-1 text-sm text-text-muted">-</p>
                      )}
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{t('leaderboard.pnl')}</p>
                      <p className={`mt-1 text-sm font-semibold ${positive ? 'text-green' : 'text-brand-red'}`}>
                        {positive ? '+' : ''}{formatPrice(pnl)}
                      </p>
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
