import { useState } from 'react'
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
import { useSettings } from '../contexts/SettingsContext'
import {
  SCAN_JOBS_QUERY_KEY,
  hasActiveScanJobs,
  isScanJobActive,
  scanJobPollInterval,
} from '../utils/scanJobs'

function expiryLabel(job, t) {
  if (!job?.expires_at) return ''
  return `${t('scanner.expiresOn')} ${new Date(job.expires_at).toLocaleDateString()}`
}

function JobRow({ job, onOpen, t }) {
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
        {isScanJobActive(job) ? (
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

function JobDetail({ jobId }) {
  const { t } = useSettings()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [addSelection, setAddSelection] = useState(null)

  const { data: job, isLoading, isError } = useQuery({
    queryKey: ['scan-job', jobId],
    queryFn: () => getScanJob(jobId),
    refetchInterval: query => scanJobPollInterval(query.state.data),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['scan-job', jobId] })
    queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
  }

  const resolveMutation = useMutation({
    mutationFn: item => resolveScanJobItem(jobId, item.id),
    onSuccess: (_data, item) => {
      const remaining = (job?.items || []).filter(candidate => candidate.id !== item.id)
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
      invalidate()
      navigate('/scans', { replace: true })
    },
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const dismiss = item => {
    if (window.confirm(t('scanner.dismissScanConfirm'))) resolveMutation.mutate(item)
  }

  const discardJob = () => {
    if (window.confirm(t('scanner.discardJobConfirm'))) deleteMutation.mutate()
  }

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-brand-red" /></div>
  }
  if (isError || !job) {
    return <p className="py-16 text-center text-sm text-brand-red">{t('scanner.jobLoadFailed')}</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => navigate('/scans')}
          className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft size={16} /> {t('scanner.backToScans')}
        </button>
        <button type="button" onClick={discardJob} disabled={deleteMutation.isPending}
          className="grid h-9 w-9 place-items-center rounded-lg text-text-muted hover:bg-brand-red/10 hover:text-brand-red"
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
          {isScanJobActive(job) && (
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
    </div>
  )
}

export default function ScanQueue() {
  const { t } = useSettings()
  const navigate = useNavigate()
  const { jobId } = useParams()

  const { data, isLoading } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })

  if (jobId) {
    return <div className="mx-auto max-w-5xl p-4 md:p-6"><JobDetail jobId={Number(jobId)} /></div>
  }

  const jobs = data?.jobs || []
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-black text-text-primary">
          <ScanLine size={20} className="text-brand-red" /> {t('scanner.queueTitle')}
        </h1>
        <p className="mt-1 text-xs text-text-muted">{t('scanner.queueSubtitle')}</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-brand-red" /></div>
      ) : jobs.length === 0 ? (
        <div className="space-y-2 py-16 text-center">
          <p className="text-sm text-text-muted">{t('scanner.noScans')}</p>
          <button type="button" onClick={() => navigate('/search')} className="text-sm text-brand-red hover:underline">
            {t('scanner.goScan')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => <JobRow key={job.id} job={job} onOpen={id => navigate(`/scans/${id}`)} t={t} />)}
        </div>
      )}
    </div>
  )
}
