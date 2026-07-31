import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, CheckCircle, XCircle, Info, Zap } from 'lucide-react'
import { getCustomMatches, migrateCustomCard, dismissCustomMatch } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { CardArtworkFrame } from '../components/UnifiedCard'

function CardPreview({ card, label, match = false }) {
  const { t } = useSettings()
  const setNumber = [
    card?.set_ref?.abbreviation || card?.set?.abbreviation || card?.set_id,
    card?.number,
  ].filter(Boolean).join(' ').toUpperCase()

  return (
    <div className="rounded-2xl border border-border bg-bg-card/60 p-3 md:p-4">
      <div className="mb-3 flex justify-center">
        <span className={match
          ? 'rounded-md border border-green/40 bg-green/15 px-2 py-1 text-[10px] font-bold text-green'
          : 'rounded-md border border-yellow/40 bg-yellow/15 px-2 py-1 text-[10px] font-bold text-yellow'}>
          {label}
        </span>
      </div>
      <div className="flex items-center gap-3 md:block">
        <div className="migration-comparison-art w-12 flex-shrink-0 md:mx-auto md:w-40">
          <CardArtworkFrame
            card={card || {}}
            image={resolveCardImageUrl(card)}
            alt={card?.name || t('migration.noImage')}
            showStateIndicators={false}
            loading="eager"
          />
        </div>
        <div className="min-w-0 flex-1 md:mt-3 md:text-center">
          <p className="truncate text-sm font-bold text-text-primary">{card?.name || t('migration.noImage')}</p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] md:justify-center">
            {setNumber && <span className="truncate font-mono font-bold text-brand-red">{setNumber}</span>}
            {!match && <span className="text-text-muted">{t('migration.custom')}</span>}
            {match && card?.rarity && <span className="truncate text-text-muted">{card.rarity}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

function MatchCard({ match, onMigrate, onDismiss, migrating, dismissing }) {
  const { t } = useSettings()

  return (
    <div className="card space-y-4 p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Zap size={16} className="text-yellow flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">
              {match.custom_card?.name || match.api_card?.name || '—'}
            </p>
            <p className="text-xs text-text-muted">
              {t('migration.matchedAt')}:{' '}
              {match.matched_at ? format(parseISO(match.matched_at), 'dd.MM.yyyy HH:mm') : '—'}
            </p>
          </div>
        </div>
        <span className="badge bg-green/15 text-green flex-shrink-0">{t('migration.apiMatchFound')}</span>
      </div>

      <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1fr)_44px_minmax(0,1fr)]">
        <CardPreview card={match.custom_card} label={t('migration.yourCard')} />
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-xl border border-border bg-bg-elevated text-green">
          <ArrowDown size={18} className="md:hidden" aria-hidden />
          <ArrowRight size={18} className="hidden md:block" aria-hidden />
        </span>
        <CardPreview card={match.api_card} label={t('migration.apiCard')} match />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-card p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Info size={13} className="mt-0.5 flex-shrink-0 text-text-muted" />
          <p className="text-xs text-text-muted">{t('migration.migrationInfo')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-shrink-0">
          <button onClick={() => onDismiss(match.match_id)} disabled={migrating || dismissing} className="btn-ghost justify-center">
            <XCircle size={15} /> {dismissing ? t('migration.dismissing') : t('migration.dismiss')}
          </button>
          <button onClick={() => onMigrate(match.match_id)} disabled={migrating || dismissing} className="btn-primary justify-center">
            <CheckCircle size={15} /> {migrating ? t('migration.migrating') : t('migration.migrateCard')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CardMigration() {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [actionId, setActionId] = useState(null)
  const [actionType, setActionType] = useState(null)

  const { data: matches = [], isLoading } = useQuery({
    queryKey: ['custom-matches'],
    queryFn: () => getCustomMatches().then(r => r.data),
    refetchInterval: 60000,
  })

  const migrateMutation = useMutation({
    mutationFn: (matchId) => migrateCustomCard(matchId),
    onSuccess: () => {
      toast.success(t('migration.migrateSuccess'))
      queryClient.invalidateQueries({ queryKey: ['custom-matches'] })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      setActionId(null); setActionType(null)
    },
    onError: () => { toast.error(t('migration.migrateError')); setActionId(null); setActionType(null) },
  })

  const dismissMutation = useMutation({
    mutationFn: (matchId) => dismissCustomMatch(matchId),
    onSuccess: () => {
      toast.success(t('migration.dismissSuccess'))
      queryClient.invalidateQueries({ queryKey: ['custom-matches'] })
      setActionId(null); setActionType(null)
    },
    onError: () => { toast.error(t('migration.dismissError')); setActionId(null); setActionType(null) },
  })

  const handleMigrate = (matchId) => { setActionId(matchId); setActionType('migrate'); migrateMutation.mutate(matchId) }
  const handleDismiss = (matchId) => { setActionId(matchId); setActionType('dismiss'); dismissMutation.mutate(matchId) }

  return (
    <div className="max-w-5xl space-y-4 pb-2">
      <div>
        <h1 className="text-xl font-bold text-text-primary">{t('migration.title')}</h1>
        <p className="text-sm text-text-secondary mt-1">{t('migration.subtitle')}</p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map(i => <div key={i} className="card h-64 skeleton" />)}
        </div>
      ) : matches.length === 0 ? (
        <div className="card text-center py-16">
          <div className="w-16 h-16 pokeball-bg mx-auto mb-4 opacity-30" />
          <p className="text-text-secondary font-medium">{t('migration.empty')}</p>
          <p className="text-xs text-text-muted mt-1">{t('migration.emptyHint')}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <Zap size={14} className="text-yellow" />
            <span>{matches.length} {t('migration.pendingMatches')}</span>
          </div>
          <div className="space-y-4">
            {matches.map((match) => (
              <MatchCard key={match.match_id} match={match}
                onMigrate={handleMigrate} onDismiss={handleDismiss}
                migrating={actionId === match.match_id && actionType === 'migrate' && migrateMutation.isPending}
                dismissing={actionId === match.match_id && actionType === 'dismiss' && dismissMutation.isPending} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
