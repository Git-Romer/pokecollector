import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, CheckCircle, AlertCircle, Clock } from 'lucide-react'
import { getSyncStatus, triggerSync } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { formatDistanceToNow } from 'date-fns'
import toast from 'react-hot-toast'
import clsx from 'clsx'

export default function SyncStatus() {
  const queryClient = useQueryClient()
  const { t } = useSettings()

  const { data } = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus().then(r => r.data),
    refetchInterval: 30000,
  })

  const syncMutation = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => {
        queryClient.invalidateQueries()
      }, 3000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  const isRunning = data?.is_running || syncMutation.isPending
  const lastSync = data?.last_sync
  const lastSyncTime = lastSync?.finished_at ? new Date(lastSync.finished_at) : null

  return (
    <div className="flex items-center gap-2">
      {lastSync && (
        <div className="hidden sm:flex items-center gap-2 text-xs text-text-muted">
          {lastSync.status === 'success' ? (
            <CheckCircle size={14} className="text-green" />
          ) : lastSync.status === 'error' ? (
            <AlertCircle size={14} className="text-brand-red" />
          ) : (
            <Clock size={14} />
          )}
          <span>
            {lastSyncTime
              ? `Synced ${formatDistanceToNow(lastSyncTime, { addSuffix: true })}`
              : t('settings.never')}
          </span>
        </div>
      )}

      <button
        onClick={() => syncMutation.mutate()}
        disabled={isRunning}
        className={clsx(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 min-h-[36px]',
          isRunning
            ? 'bg-bg-elevated text-text-muted cursor-not-allowed'
            : 'bg-brand-red/20 text-brand-red hover:bg-brand-red/30 border border-brand-red/30'
        )}
      >
        <RefreshCw size={12} className={clsx(isRunning && 'animate-spin')} />
        <span className="hidden sm:inline">{isRunning ? t('settings.syncing') : t('common.sync')}</span>
      </button>
    </div>
  )
}
