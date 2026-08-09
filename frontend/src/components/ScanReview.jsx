import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Camera, Loader2, Maximize2, RefreshCw, Trash2, X } from 'lucide-react'
import { fetchScanJobItemImage } from '../api/client'
import { CardDisplay } from './card-system'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'

export function ScanZoomModal({ photoUrl, card, onClose, t }) {
  useEffect(() => {
    const closeOnEscape = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const candidateImage = card?.image_hd
    || card?.image?.replace('/low.webp', '/high.webp')
    || card?.image

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col bg-black/90 p-4" onClick={onClose}>
      <div className="flex justify-end">
        <button type="button" onClick={onClose} aria-label={t('common.close')}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20">
          <X size={18} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 py-3 md:flex-row md:gap-8"
        onClick={event => event.stopPropagation()}>
        {photoUrl && (
          <figure className="flex min-h-0 flex-col items-center">
            <img src={photoUrl} alt={t('scanner.yourPhoto')}
              className="max-h-[68vh] max-w-full rounded-xl object-contain md:max-h-[80vh]" />
            <figcaption className="mt-2 text-xs text-text-muted">{t('scanner.yourPhoto')}</figcaption>
          </figure>
        )}
        {candidateImage && (
          <figure className="flex min-h-0 flex-col items-center">
            <img src={candidateImage} alt={card?.name}
              className="max-h-[68vh] max-w-full rounded-xl object-contain md:max-h-[80vh]" />
            <figcaption className="mt-2 text-xs text-text-muted">{card?.name}</figcaption>
          </figure>
        )}
      </div>
    </div>,
    document.body,
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

function CandidateGrid({ matches, photoUrl, onSelect, t }) {
  const [zoomCard, setZoomCard] = useState(null)
  if (!matches?.length) return null

  return (
    <>
      {zoomCard && (
        <ScanZoomModal photoUrl={photoUrl} card={zoomCard} onClose={() => setZoomCard(null)} t={t} />
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {matches.map(match => {
          const language = match.lang || match._lang || 'en'
          return (
            <div key={`${match.id}-${language}`} className="relative">
              <CardDisplay
                variant="selectable"
                card={match}
                image={match.image}
                languageLabel={tcgdexLanguageLabel(language)}
                onClick={() => onSelect(match)}
                onSelect={() => onSelect(match)}
              />
              {match.image && (
                <button type="button" onClick={event => { event.stopPropagation(); setZoomCard(match) }}
                  aria-label={t('scanner.compareCandidate')}
                  title={t('scanner.compareCandidate')}
                  className="absolute right-2 top-2 z-20 grid h-8 w-8 place-items-center rounded-full bg-black/75 text-white hover:bg-black">
                  <Maximize2 size={15} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

export function ScanItemPanel({ jobId, item, onAdd, onRetry, onDismiss, t }) {
  const photoUrl = useScanItemPhoto(jobId, item)
  const [photoExpanded, setPhotoExpanded] = useState(false)
  const active = ['pending', 'processing', 'retrying'].includes(item.status)
  const noMatches = item.status === 'done' && !item.matches?.length

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      {photoExpanded && (
        <ScanZoomModal photoUrl={photoUrl} onClose={() => setPhotoExpanded(false)} t={t} />
      )}
      <div className="flex gap-4">
        <button type="button" onClick={() => photoUrl && setPhotoExpanded(true)} disabled={!photoUrl}
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
                className="flex flex-shrink-0 items-center gap-1 text-xs text-text-muted hover:text-brand-red">
                <Trash2 size={14} /> {t('scanner.dismissScan')}
              </button>
            )}
          </div>

          {active && (
            <p className="mt-3 flex items-center gap-2 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" />
              {item.status === 'retrying' ? t('scanner.itemRetrying') : t('scanner.itemProcessing')}
            </p>
          )}

          {(item.status === 'failed' || noMatches) && (
            <div className="mt-3 space-y-3">
              <p className={item.status === 'failed' ? 'text-sm text-brand-red' : 'text-sm text-text-muted'}>
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
          <CandidateGrid matches={item.matches} photoUrl={photoUrl} onSelect={match => onAdd(item, match)} t={t} />
        </div>
      )}
    </article>
  )
}
