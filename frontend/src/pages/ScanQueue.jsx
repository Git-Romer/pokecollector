import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Clock3, Loader2, ScanLine, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  deleteScanJob,
  getScanJob,
  getScanJobs,
  resolveScanJobItem,
  retryScanJobItem,
} from '../api/client'
import { ScanAddModal } from '../components/CardScanner'
import { ScanItemPanel } from '../components/ScanReview'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import Modal from '../components/ui/Modal'
import { useSettings } from '../contexts/SettingsContext'
import {
  SCAN_JOBS_QUERY_KEY,
  hasActiveScanJobs,
  isScanJobActive,
  scanJobPollInterval,
} from '../utils/scanJobs'
import { formatRetryCountdown } from '../utils/retryCountdown'

function useRetryClock(enabled) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [enabled])

  return now
}

function expiryLabel(job, t) {
  if (!job?.expires_at) return ''
  return `${t('scanner.expiresOn')} ${new Date(job.expires_at).toLocaleDateString()}`
}

function JobRow({ job, onOpen, retryNow, t }) {
  const waitingOnly = Number(job.retrying || 0) > 0 && Number(job.active || 0) === Number(job.retrying || 0)
  return (
    <button type="button" onClick={() => onOpen(job.id)}
      className="w-full rounded-2xl border border-border bg-bg-surface p-4 text-left transition-colors hover:border-brand-red/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary">
            {job.processed}/{job.total} {t('scanner.processed')}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {job.attention > 0 && `${job.attention} ${t('scanner.needReview')}`}
            {job.attention > 0 && job.failed_attention > 0 && ' · '}
            {job.failed_attention > 0 && `${job.failed_attention} ${t('scanner.failed')}`}
          </p>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
            <Clock3 size={11} /> {expiryLabel(job, t)}
          </p>
        </div>
        {waitingOnly ? (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-text-muted">
            <Clock3 size={13} /> {formatRetryCountdown(job.next_retry_at, t, retryNow, job.retry_reason)}
          </span>
        ) : isScanJobActive(job) ? (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-text-muted">
            <Loader2 size={13} className="animate-spin" /> {t('scanner.processing')}
          </span>
        ) : (
          <span className="rounded-full bg-brand-red/15 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-brand-red">
            {job.attention} {t('scanner.ready')}
          </span>
        )}
      </div>
    </button>
  )
}

function JobDetail({ jobId, onObscuredChange }) {
  const { t } = useSettings()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [addSelection, setAddSelection] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [itemModalOpen, setItemModalOpen] = useState(false)

  useEffect(() => {
    onObscuredChange(Boolean(addSelection || confirmation || itemModalOpen))
    return () => onObscuredChange(false)
  }, [addSelection, confirmation, itemModalOpen, onObscuredChange])

  const { data: job, isLoading, isError } = useQuery({
    queryKey: ['scan-job', jobId],
    queryFn: () => getScanJob(jobId),
    refetchInterval: query => scanJobPollInterval(query.state.data),
  })
  const retryNow = useRetryClock(Number(job?.retrying || 0) > 0)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['scan-job', jobId] })
    queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
  }

  const resolveMutation = useMutation({
    mutationFn: item => resolveScanJobItem(jobId, item.id),
    onSuccess: (_data, item) => {
      const remaining = (job?.items || []).filter(candidate => candidate.id !== item.id)
      setConfirmation(null)
      invalidate()
      if (remaining.length === 0) navigate('/scans', { replace: true })
    },
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const retryMutation = useMutation({
    mutationFn: item => retryScanJobItem(jobId, item.id),
    onSuccess: invalidate,
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteScanJob(jobId),
    onSuccess: () => {
      setConfirmation(null)
      invalidate()
      navigate('/scans', { replace: true })
    },
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const dismiss = item => setConfirmation({ type: 'dismiss', item })

  const discardJob = () => setConfirmation({ type: 'discard' })

  const confirmDestructiveAction = () => {
    if (confirmation?.type === 'dismiss') resolveMutation.mutate(confirmation.item)
    else if (confirmation?.type === 'discard') deleteMutation.mutate()
  }

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-brand-red" /></div>
  }
  if (isError || !job) {
    return (
      <div role="alert" className="rounded-xl border border-brand-red/20 bg-brand-red/10 p-4 text-center text-sm text-brand-red">
        {t('scanner.jobLoadFailed')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => navigate('/scans')}
          className="btn-ghost px-3 py-1.5 text-sm">
          <ArrowLeft size={16} /> {t('scanner.backToScans')}
        </button>
        <button type="button" onClick={discardJob} disabled={deleteMutation.isPending}
          className="btn-ghost h-9 w-9 border-brand-red/30 p-0 text-brand-red hover:bg-brand-red/10"
          aria-label={t('scanner.discardJob')} title={t('scanner.discardJob')}>
          <Trash2 size={17} />
        </button>
      </div>

      <div className="rounded-2xl border border-border bg-bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-bold text-text-primary">{job.processed}/{job.total} {t('scanner.processed')}</p>
            <p className="mt-1 text-xs text-text-muted">{expiryLabel(job, t)}</p>
          </div>
          {Number(job.retrying || 0) > 0 && Number(job.active || 0) === Number(job.retrying || 0) ? (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <Clock3 size={13} /> {formatRetryCountdown(job.next_retry_at, t, retryNow, job.retry_reason)}
            </span>
          ) : isScanJobActive(job) && (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <Loader2 size={13} className="animate-spin" /> {t('scanner.processing')}
            </span>
          )}
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/5">
          <div className="h-full rounded-full bg-brand-red transition-all"
            style={{ width: `${job.total ? Math.round((job.processed / job.total) * 100) : 0}%` }} />
        </div>
        <p className="mt-2 text-xs text-text-muted">
          {job.pending + job.processing + job.retrying} {t('scanner.remaining')}
          {job.failed > 0 && ` · ${job.failed} ${t('scanner.failed')}`}
        </p>
      </div>

      <div className="space-y-3">
        {(job.items || []).map(item => (
          <ScanItemPanel
            key={item.id}
            jobId={job.id}
            item={item}
            onAdd={(scanItem, match) => setAddSelection({ item: scanItem, match })}
            onRetry={itemToRetry => retryMutation.mutate(itemToRetry)}
            onDismiss={dismiss}
            onModalChange={setItemModalOpen}
            retryNow={retryNow}
            t={t}
          />
        ))}
      </div>

      {addSelection && (
        <ScanAddModal
          match={addSelection.match}
          defaultLang={addSelection.item.recognized?.language || addSelection.match.lang || 'en'}
          onClose={() => setAddSelection(null)}
          onAdded={() => {
            resolveMutation.mutate(addSelection.item)
            setAddSelection(null)
          }}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmation)}
        onClose={() => setConfirmation(null)}
        onConfirm={confirmDestructiveAction}
        title={confirmation?.type === 'discard' ? t('scanner.discardJob') : t('scanner.dismissScan')}
        message={confirmation?.type === 'discard' ? t('scanner.discardJobConfirm') : t('scanner.dismissScanConfirm')}
        confirmLabel={confirmation?.type === 'discard' ? t('scanner.discardJob') : t('scanner.dismissScan')}
        cancelLabel={t('common.cancel')}
        isPending={deleteMutation.isPending || resolveMutation.isPending}
        destructive
      />
    </div>
  )
}

export default function ScanQueue() {
  const { t } = useSettings()
  const navigate = useNavigate()
  const { jobId } = useParams()
  const [isNestedOpen, setIsNestedOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })

  const closeScans = () => navigate('/search')
  const jobs = data?.jobs || []
  const retryNow = useRetryClock(jobs.some(job => Number(job.retrying || 0) > 0))
  return (
    <Modal isOpen onClose={closeScans} title={t('scanner.queueTitle')} size="xl" isObscured={isNestedOpen}>
      <div className="space-y-4 p-4 sm:p-5">
        {jobId ? (
          <JobDetail jobId={Number(jobId)} onObscuredChange={setIsNestedOpen} />
        ) : (
          <>
            <p className="text-sm text-text-secondary">{t('scanner.queueSubtitle')}</p>

            {isLoading ? (
              <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-brand-red" /></div>
            ) : jobs.length === 0 ? (
              <div className="card space-y-3 py-12 text-center">
                <ScanLine size={28} className="mx-auto text-text-muted opacity-50" />
                <p className="text-sm text-text-muted">{t('scanner.noScans')}</p>
                <button type="button" onClick={closeScans} className="btn-primary mx-auto justify-center">
                  {t('scanner.goScan')}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {jobs.map(job => <JobRow key={job.id} job={job} onOpen={id => navigate(`/scans/${id}`)} retryNow={retryNow} t={t} />)}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
