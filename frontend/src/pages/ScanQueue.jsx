import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { ArrowLeft, Loader2, ScanLine, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { getScanJob, getScanJobs, resolveScanJobItem, deleteScanJob } from '../api/client'
import { ScanAddModal, ScanItemPanel } from '../components/ScanReview'
import { useSettings } from '../contexts/SettingsContext'
import {
  SCAN_JOBS_QUERY_KEY,
  isJobActive,
  jobPollInterval,
} from '../utils/scanJobs'

function JobRow({ job, onOpen, t }) {
  const active = isJobActive(job)
  return (
    <button
      onClick={() => onOpen(job.id)}
      className="w-full text-left p-4 rounded-2xl border border-border hover:border-brand-red/40 bg-bg-surface transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary">
            {job.done}/{job.total} {t('scanner.jobProgressSuffix')}
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            {job.created_at ? new Date(job.created_at).toLocaleString() : ''}
            {job.failed > 0 && ` · ${job.failed} ${t('scanner.jobFailedSuffix')}`}
          </p>
        </div>
        {active ? (
          <span className="text-[11px] text-text-muted flex items-center gap-1.5 flex-shrink-0">
            <Loader2 size={12} className="animate-spin" /> {t('scanner.jobRunning')}
          </span>
        ) : (
          <span className={clsx(
            'text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-full flex-shrink-0',
            job.status === 'failed' ? 'bg-brand-red/20 text-brand-red' : 'bg-green/15 text-green'
          )}>
            {job.status === 'failed' ? t('scanner.jobStatusFailed') : t('scanner.jobStatusDone')}
          </span>
        )}
      </div>
    </button>
  )
}

function JobDetail({ jobId, onBack }) {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [addModal, setAddModal] = useState(null) // { item, match }

  const { data: job, isLoading } = useQuery({
    queryKey: ['scan-job', jobId],
    queryFn: () => getScanJob(jobId),
    // Poll only while work is outstanding. Recognition is paced against the
    // Gemini rate limit server-side, so a large batch can take a while.
    refetchInterval: query => jobPollInterval(query.state.data),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['scan-job', jobId] })
    queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
  }

  const resolveMutation = useMutation({
    mutationFn: item => resolveScanJobItem(jobId, item.id),
    onSuccess: invalidate,
    onError: e => toast.error(e?.response?.data?.detail || t('scanner.recognitionFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteScanJob(jobId),
    onSuccess: () => {
      invalidate()
      onBack()
    },
    onError: e => toast.error(e?.response?.data?.detail || t('scanner.recognitionFailed')),
  })

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 size={28} className="animate-spin text-brand-red" />
      </div>
    )
  }
  if (!job) return null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button onClick={onBack} className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft size={16} /> {t('scanner.backToScans')}
        </button>
        <button
          onClick={() => deleteMutation.mutate()}
          title={t('scanner.discardJobHint')}
          className="text-text-muted hover:text-brand-red p-2 rounded-lg"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-text-primary">
          {job.done}/{job.total} {t('scanner.jobProgressSuffix')}
          {job.failed > 0 && ` · ${job.failed} ${t('scanner.jobFailedSuffix')}`}
        </p>
        {isJobActive(job) && (
          <span className="text-[11px] text-text-muted flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" /> {t('scanner.jobRunning')}
          </span>
        )}
      </div>

      {isJobActive(job) && (
        <p className="text-xs text-text-muted">{t('scanner.queueHint')}</p>
      )}
      {job.error_message && <p className="text-sm text-brand-red">{job.error_message}</p>}

      <div className="space-y-3">
        {(job.items || []).map(item => (
          <ScanItemPanel
            key={item.id}
            jobId={job.id}
            item={item}
            onSelectMatch={(scanItem, match) => setAddModal({ item: scanItem, match })}
            onResolve={item => resolveMutation.mutate(item)}
            t={t}
          />
        ))}
      </div>

      {addModal && (
        <ScanAddModal
          match={addModal.match}
          defaultLang={addModal.item?.recognized?.language || addModal.match?.lang || 'en'}
          onClose={() => setAddModal(null)}
          onAdded={() => {
            // Adding the card is the review — mark the item handled so it stops
            // showing up as outstanding.
            resolveMutation.mutate(addModal.item)
            setAddModal(null)
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
    refetchInterval: query => (
      (query.state.data?.jobs || []).some(isJobActive) ? 3000 : false
    ),
  })

  if (jobId) {
    return (
      <div className="p-4 md:p-6 max-w-4xl mx-auto">
        <JobDetail jobId={Number(jobId)} onBack={() => navigate('/scans')} />
      </div>
    )
  }

  const jobs = data?.jobs || []

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-black text-text-primary flex items-center gap-2">
          <ScanLine size={20} className="text-brand-red" /> {t('scanner.queueTitle')}
        </h1>
        <p className="text-xs text-text-muted mt-1">{t('scanner.queueSubtitle')}</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 size={28} className="animate-spin text-brand-red" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <p className="text-sm text-text-muted">{t('scanner.noScans')}</p>
          <button onClick={() => navigate('/search')} className="text-sm text-brand-red hover:underline">
            {t('scanner.goScan')}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => (
            <JobRow key={job.id} job={job} onOpen={id => navigate(`/scans/${id}`)} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}
