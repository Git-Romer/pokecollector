import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CheckCircle, XCircle, Info, Zap } from 'lucide-react'
import { getCustomMatches, migrateCustomCard, dismissCustomMatch } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'
import { resolveCardImageUrl } from '../utils/imageUrl'

function CardPreview({ card, label }) {
  const { t } = useSettings()
  if (!card) return (
    <div className="flex flex-col items-center gap-2 text-text-muted">
      <div className="w-24 h-32 rounded-lg bg-bg-card border border-border flex items-center justify-center">
        <span className="text-xs">{t('migration.noImage')}</span>
      </div>
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  )

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="w-24 h-32 rounded-lg overflow-hidden bg-bg-card border border-border flex-shrink-0">
        {resolveCardImageUrl(card) ? (
          <img src={resolveCardImageUrl(card)} alt={card.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xs text-text-muted">{t('migration.noImage')}</span>
          </div>
        )}
      </div>
      <div className="text-center max-w-[120px]">
        <p className="text-xs font-medium text-text-primary truncate">{card.name}</p>
        {card.set_id && (
          <p className="text-xs text-text-muted truncate">
            {card.set_id}{card.number ? ` #${card.number}` : ''}
          </p>
        )}
        {card.rarity && <p className="text-xs text-text-muted truncate">{card.rarity}</p>}
        {card.is_custom && (
          <span className="inline-block mt-1 text-xs bg-yellow/20 text-yellow px-1.5 py-0.5 rounded-full">Custom</span>
        )}
      </div>
      <span className="text-xs text-text-muted font-medium uppercase tracking-wide">{label}</span>
    </div>
  )
}

function MatchCard({ match, onMigrate, onDismiss, migrating, dismissing }) {
  const { t } = useSettings()

  return (
    <div className="card space-y-4">
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
        <span className="badge bg-yellow/20 text-yellow flex-shrink-0">{t('migration.apiMatchFound')}</span>
      </div>

      <div className="flex items-center justify-center gap-4 py-2">
        <CardPreview card={match.custom_card} label={t('migration.yourCard')} />
        <ArrowRight size={24} className="text-brand-red flex-shrink-0" />
        <CardPreview card={match.api_card} label={t('migration.apiCard')} />
      </div>

      <div className="bg-bg-card rounded-lg p-3 flex items-start gap-2">
        <Info size={13} className="text-text-muted flex-shrink-0 mt-0.5" />
        <p className="text-xs text-text-muted">{t('migration.migrationInfo')}</p>
      </div>

      <div className="flex gap-3">
        <button onClick={() => onMigrate(match.match_id)} disabled={migrating || dismissing} className="btn-primary flex-1 justify-center">
          <CheckCircle size={15} /> {migrating ? t('migration.migrating') : t('migration.migrate')}
        </button>
        <button onClick={() => onDismiss(match.match_id)} disabled={migrating || dismissing} className="btn-ghost flex-1 justify-center">
          <XCircle size={15} /> {dismissing ? t('migration.dismissing') : t('migration.dismiss')}
        </button>
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
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
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
    <div className="space-y-4 pb-2 max-w-2xl">
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
