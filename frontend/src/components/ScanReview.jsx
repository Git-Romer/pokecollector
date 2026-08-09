import { useEffect, useState } from 'react'
import { Camera, Loader2, Maximize2, RefreshCw, Trash2 } from 'lucide-react'
import { fetchScanJobItemImage } from '../api/client'
import { CardDisplay } from './card-system'
import Modal from './ui/Modal'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { formatRetryCountdown } from '../utils/retryCountdown'

export function ScanZoomModal({ photoUrl, card, onClose, t }) {
  const candidateImage = card?.image_hd
    || card?.image?.replace('/low.webp', '/high.webp')
    || card?.image

  return (
    <Modal isOpen onClose={onClose} title={t('scanner.compareCandidate')} size="xl">
      <div className="flex min-h-0 flex-col items-center justify-center gap-4 p-4 md:flex-row md:gap-8 md:p-6">
        {photoUrl && (
          <figure className="flex min-h-0 min-w-0 flex-1 flex-col items-center">
            <img src={photoUrl} alt={t('scanner.yourPhoto')}
              className="max-h-[58vh] max-w-full rounded-xl object-contain md:max-h-[68vh]" />
            <figcaption className="mt-2 text-xs text-text-muted">{t('scanner.yourPhoto')}</figcaption>
          </figure>
        )}
        {candidateImage && (
          <figure className="flex min-h-0 min-w-0 flex-1 flex-col items-center">
            <img src={candidateImage} alt={card?.name}
              className="max-h-[58vh] max-w-full rounded-xl object-contain md:max-h-[68vh]" />
            <figcaption className="mt-2 text-xs text-text-muted">{card?.name}</figcaption>
          </figure>
        )}
      </div>
    </Modal>
  )
}

export function useScanItemPhoto(jobId, item) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    if (!item.has_image) {
      setUrl(null)
      return undefined
    }
    let disposed = false
    let objectUrl = null
    fetchScanJobItemImage(jobId, item.id)
      .then(nextUrl => {
        if (disposed) {
          URL.revokeObjectURL(nextUrl)
          return
        }
        objectUrl = nextUrl
        setUrl(nextUrl)
      })
      .catch(() => setUrl(null))
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, item.id, item.has_image])

  return url
}

function CandidateGrid({ matches, photoUrl, onSelect, onModalChange, t }) {
  const [zoomCard, setZoomCard] = useState(null)
  if (!matches?.length) return null

  return (
    <>
      {zoomCard && (
        <ScanZoomModal photoUrl={photoUrl} card={zoomCard} onClose={() => {
          setZoomCard(null)
          onModalChange?.(false)
        }} t={t} />
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {matches.map(match => {
          const language = match.lang || match._lang || 'en'
          return (
            <div key={`${match.id}-${language}`}>
              <CardDisplay
                variant="selectable"
                card={match}
                image={match.image}
                languageLabel={tcgdexLanguageLabel(language)}
                onClick={() => onSelect(match)}
                onSelect={() => onSelect(match)}
                overlay={match.image ? (
                  <button type="button" onClick={event => {
                    event.stopPropagation()
                    setZoomCard(match)
                    onModalChange?.(true)
                  }}
                    aria-label={t('scanner.compareCandidate')}
                    title={t('scanner.compareCandidate')}
                    className="absolute right-2 top-2 z-30 grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-black/75 text-white shadow-lg transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red">
                    <Maximize2 size={15} />
                  </button>
                ) : null}
              />
            </div>
          )
        })}
      </div>
    </>
  )
}

export function ScanItemPanel({ jobId, item, onAdd, onRetry, onDismiss, onModalChange, retryNow, t }) {
  const photoUrl = useScanItemPhoto(jobId, item)
  const [photoExpanded, setPhotoExpanded] = useState(false)
  const active = ['pending', 'processing', 'retrying'].includes(item.status)
  const noMatches = item.status === 'done' && !item.matches?.length

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      {photoExpanded && (
        <ScanZoomModal photoUrl={photoUrl} onClose={() => {
          setPhotoExpanded(false)
          onModalChange?.(false)
        }} t={t} />
      )}
      <div className="flex gap-4">
        <button type="button" onClick={() => {
          if (!photoUrl) return
          setPhotoExpanded(true)
          onModalChange?.(true)
        }} disabled={!photoUrl}
          className="grid aspect-[2.5/3.5] w-24 flex-shrink-0 place-items-center overflow-hidden rounded-xl border border-white/10 bg-bg-primary/50 disabled:cursor-default">
          {photoUrl
            ? <img src={photoUrl} alt={t('scanner.yourPhoto')} className="h-full w-full object-contain" />
            : <Camera size={28} className="text-text-muted opacity-50" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-text-muted">
                {t('scanner.photoNumber')} {item.position + 1}
              </p>
              {item.recognized?.name && (
                <p className="truncate text-base font-bold text-white">{item.recognized.name}</p>
              )}
              {item.recognized?.number && (
                <p className="text-xs text-text-muted">Nr. {item.recognized.number}</p>
              )}
            </div>
            {!active && (
              <button type="button" onClick={() => onDismiss(item)}
                className="btn-ghost flex-shrink-0 border-brand-red/30 px-2 py-1 text-xs text-brand-red hover:bg-brand-red/10">
                <Trash2 size={14} /> {t('scanner.dismissScan')}
              </button>
            )}
          </div>

          {active && (
            <p className="mt-3 flex items-center gap-2 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" />
              {item.status === 'retrying'
                ? formatRetryCountdown(item.next_attempt_at, t, retryNow, item.retry_reason)
                : t('scanner.itemProcessing')}
            </p>
          )}

          {(item.status === 'failed' || noMatches) && (
            <div className="mt-3 space-y-3">
              <p role="alert" className={`rounded-xl border px-3 py-2 text-sm ${
                item.status === 'failed'
                  ? 'border-brand-red/20 bg-brand-red/10 text-brand-red'
                  : 'border-border bg-bg-card text-text-muted'
              }`}>
                {item.error || t(noMatches ? 'scanner.noMatches' : 'scanner.recognitionFailed')}
              </p>
              <button type="button" onClick={() => onRetry(item)} disabled={!item.has_image}
                className="btn-secondary justify-center">
                <RefreshCw size={14} /> {t('scanner.retryIndividually')}
              </button>
            </div>
          )}
        </div>
      </div>

      {item.status === 'done' && item.matches?.length > 0 && (
        <div className="mt-4">
          <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
            {t('scanner.bestMatches')} ({item.matches.length})
          </p>
          <CandidateGrid matches={item.matches} photoUrl={photoUrl} onSelect={match => onAdd(item, match)} onModalChange={onModalChange} t={t} />
        </div>
      )}
    </article>
  )
}
