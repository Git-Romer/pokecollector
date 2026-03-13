import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight } from 'lucide-react'
import { compareUsers } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'

function TrainerAvatar({ avatarId, username }) {
  if (!avatarId) {
    return <img src="/pokeball.svg" alt={username} className="h-16 w-16 rounded-full border border-border bg-bg-card p-3" />
  }

  return (
    <img
      src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${avatarId}.gif`}
      alt={username}
      className="h-16 w-16 rounded-full border border-border bg-bg-card p-1 pixelated"
    />
  )
}

function StatBlock({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary/70 p-3">
      <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${accent || 'text-text-primary'}`}>{value}</p>
    </div>
  )
}

function TrainerPanel({ trainer, formatPrice, t }) {
  const pnl = Number(trainer?.pnl ?? 0)
  const bestCard = trainer?.most_valuable_card

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-3">
        <TrainerAvatar avatarId={trainer?.avatar_id} username={trainer?.username} />
        <div>
          <h2 className="text-xl font-bold text-text-primary">{trainer?.username}</h2>
          <p className="text-sm text-text-secondary">{trainer?.role}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatBlock label={t('leaderboard.value')} value={formatPrice(trainer?.total_value ?? 0)} accent="text-yellow" />
        <StatBlock label={t('leaderboard.cards')} value={Number(trainer?.total_cards ?? 0).toLocaleString()} />
        <StatBlock label={t('leaderboard.uniqueCards')} value={Number(trainer?.unique_cards ?? 0).toLocaleString()} />
        <StatBlock label={t('leaderboard.setsCompleted')} value={Number(trainer?.sets_completed ?? 0).toLocaleString()} />
      </div>

      <div className="rounded-2xl border border-border bg-bg-primary/60 p-4">
        <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">{t('leaderboard.pnl')}</p>
        <p className={`mt-2 text-2xl font-black ${pnl >= 0 ? 'text-green' : 'text-brand-red'}`}>
          {pnl >= 0 ? '+' : ''}{formatPrice(pnl)}
        </p>
      </div>

      <div>
        <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-text-muted">{t('leaderboard.bestCard')}</p>
        {bestCard ? (
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-bg-primary/60 p-3">
            <div className="h-16 w-12 overflow-hidden rounded-lg border border-border bg-bg-card">
              <img src={resolveCardImageUrl(bestCard)} alt={bestCard.name} className="h-full w-full object-cover" loading="lazy" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-text-primary">{bestCard.name}</p>
              <p className="text-sm text-text-secondary">{formatPrice(bestCard.price_market)}</p>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-bg-primary/60 p-3 text-sm text-text-muted">-</div>
        )}
      </div>
    </div>
  )
}

export default function Compare() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const { t, formatPrice } = useSettings()

  const { data, isLoading, error } = useQuery({
    queryKey: ['compare', userId],
    queryFn: () => compareUsers(userId).then((response) => response.data),
    enabled: Boolean(userId),
  })

  const overlapRatio = useMemo(() => {
    const total = Number(data?.overlap ?? 0) + Number(data?.only_a ?? 0) + Number(data?.only_b ?? 0)
    if (!total) return 0
    return (Number(data?.overlap ?? 0) / total) * 100
  }, [data])

  return (
    <div className="page-container">
      <div className="card">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary">
              <ArrowLeftRight size={20} className="text-blue" />
              {t('compare.title')}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">{t('leaderboard.compare')}</p>
          </div>
          <button type="button" className="btn-ghost" onClick={() => navigate('/leaderboard')}>
            {t('nav.leaderboard')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, index) => <div key={index} className="skeleton h-48 rounded-2xl" />)}
        </div>
      ) : error ? (
        <div className="card text-sm text-brand-red">Failed to load comparison.</div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[1fr_320px_1fr]">
            <TrainerPanel trainer={data.user_a} formatPrice={formatPrice} t={t} />

            <div className="card flex flex-col items-center justify-center gap-4 text-center">
              <div className="relative flex h-44 w-full max-w-[260px] items-center justify-center">
                <div className="absolute left-4 top-1/2 flex h-28 w-28 -translate-y-1/2 items-center justify-center rounded-full border border-blue/30 bg-blue/10 text-3xl font-black text-blue">
                  {data.only_a}
                </div>
                <div className="absolute right-4 top-1/2 flex h-28 w-28 -translate-y-1/2 items-center justify-center rounded-full border border-brand-red/30 bg-brand-red/10 text-3xl font-black text-brand-red">
                  {data.only_b}
                </div>
                <div className="relative z-10 flex h-24 w-24 items-center justify-center rounded-full border border-yellow/30 bg-yellow/10 text-3xl font-black text-yellow">
                  {data.overlap}
                </div>
              </div>

              <div className="w-full space-y-3">
                <StatBlock label={t('compare.cardsInCommon')} value={Number(data.overlap ?? 0).toLocaleString()} accent="text-yellow" />
                <StatBlock label={t('compare.onlyA')} value={Number(data.only_a ?? 0).toLocaleString()} accent="text-blue" />
                <StatBlock label={t('compare.onlyB')} value={Number(data.only_b ?? 0).toLocaleString()} accent="text-brand-red" />
                <div>
                  <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-text-muted">{t('compare.overlap')}</p>
                  <div className="h-2 overflow-hidden rounded-full bg-bg-primary">
                    <div className="h-full rounded-full bg-yellow transition-all" style={{ width: `${overlapRatio}%` }} />
                  </div>
                </div>
              </div>
            </div>

            <TrainerPanel trainer={data.user_b} formatPrice={formatPrice} t={t} />
          </div>

          <div className="card">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-text-primary">{t('compare.tradeSuggestions')}</h2>
              <p className="mt-1 text-sm text-text-secondary">{t('compare.exclusiveCards')}</p>
            </div>

            {data.trade_suggestions?.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {data.trade_suggestions.map((trade) => (
                  <div key={`${trade.card_id}-${trade.owner_username}-${trade.wants_username}`} className="rounded-2xl border border-border bg-bg-primary/60 p-3">
                    <div className="flex items-center gap-3">
                      <div className="h-16 w-12 overflow-hidden rounded-lg border border-border bg-bg-card">
                        <img src={resolveCardImageUrl(trade)} alt={trade.card_name} className="h-full w-full object-cover" loading="lazy" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-text-primary">{trade.card_name}</p>
                        <p className="text-sm text-text-secondary">{trade.owner_username} {t('compare.has')}</p>
                        <p className="text-sm text-text-secondary">{trade.wants_username} {t('compare.wants')}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-bg-primary/50 p-6 text-center text-text-muted">
                {t('compare.noTrades')}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
