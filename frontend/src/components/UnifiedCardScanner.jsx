import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Camera, Check, HelpCircle, ImagePlus, Loader2, Trash2, Upload, X } from 'lucide-react'
import toast from 'react-hot-toast'

import { enqueueScanJob, getScannerConfiguration } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { isSupportedScannerImage, SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import ConfirmDialog from './ui/ConfirmDialog'
import Modal from './ui/Modal'


function PhotoPositionGuide({ title, description }) {
  return (
    <div className="space-y-3">
      <div className="mx-auto w-36 rounded-2xl border-2 border-text-muted/50 bg-bg-surface p-3 shadow-inner">
        <div className="relative mx-auto aspect-[2.5/3.5] w-20 rounded-md border-2 border-brand-yellow bg-bg-elevated">
          <span className="absolute left-1 top-1 h-3 w-3 rounded-sm border-l-2 border-t-2 border-white" />
          <span className="absolute right-1 top-1 h-3 w-3 rounded-sm border-r-2 border-t-2 border-white" />
          <span className="absolute bottom-1 left-1 h-3 w-3 rounded-sm border-b-2 border-l-2 border-white" />
          <span className="absolute bottom-1 right-1 h-3 w-3 rounded-sm border-b-2 border-r-2 border-white" />
          <div className="absolute inset-x-2 top-3 h-8 rounded bg-white/10" />
          <div className="absolute inset-x-2 bottom-3 space-y-1">
            <div className="h-1 rounded bg-white/20" />
            <div className="h-1 rounded bg-white/20" />
          </div>
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">{description}</p>
      </div>
    </div>
  )
}


export default function UnifiedCardScanner({ isOpen, onClose }) {
  const [stagedFiles, setStagedFiles] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [confirmation, setConfirmation] = useState(null)
  const [photoGuidePinned, setPhotoGuidePinned] = useState(false)
  const [photoGuideHovered, setPhotoGuideHovered] = useState(false)
  const cameraRef = useRef()
  const galleryRef = useRef()
  const stagedFilesRef = useRef([])
  const { t } = useSettings()
  const navigate = useNavigate()
  const { data: scannerConfiguration } = useQuery({
    queryKey: ['scanner-configuration'],
    queryFn: getScannerConfiguration,
    enabled: isOpen,
  })

  useEffect(() => {
    stagedFilesRef.current = stagedFiles
  }, [stagedFiles])

  useEffect(() => () => {
    stagedFilesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
  }, [])

  useEffect(() => {
    if (!isOpen) {
      setPhotoGuidePinned(false)
      setPhotoGuideHovered(false)
    }
  }, [isOpen])

  const appendFiles = fileList => {
    const incoming = Array.from(fileList || []).filter(file => {
      if (isSupportedScannerImage(file)) return true
      toast.error(t('scanner.unsupportedImage'))
      return false
    })
    if (!incoming.length) return
    const remaining = Math.max(0, 50 - stagedFilesRef.current.length)
    const accepted = incoming.slice(0, remaining)
    if (accepted.length < incoming.length) toast.error(t('scanner.batchLimitReached'))
    const additions = accepted.map(file => ({
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      individual: false,
    }))
    setStagedFiles(current => [...current, ...additions])
  }

  const removeFile = id => {
    setStagedFiles(current => {
      const removed = current.find(item => item.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter(item => item.id !== id)
    })
  }

  const clearFiles = () => {
    stagedFilesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
    stagedFilesRef.current = []
    setStagedFiles([])
  }

  const finishClose = () => {
    clearFiles()
    setPhotoGuidePinned(false)
    setPhotoGuideHovered(false)
    setConfirmation(null)
    onClose?.()
  }

  const closeScanner = () => {
    if (stagedFiles.length) {
      setConfirmation('close')
      return
    }
    finishClose()
  }

  const requestClear = () => setConfirmation('clear')

  const confirmDiscard = () => {
    if (confirmation === 'close') finishClose()
    else {
      clearFiles()
      setConfirmation(null)
    }
  }

  const toggleIndividual = id => {
    setStagedFiles(current => current.map(item => (
      item.id === id ? { ...item, individual: !item.individual } : item
    )))
  }

  const allIndividual = stagedFiles.length > 0 && stagedFiles.every(item => item.individual)
  const toggleAllIndividual = () => {
    setStagedFiles(current => current.map(item => ({ ...item, individual: !allIndividual })))
  }

  const startScanning = async () => {
    if (!stagedFiles.length || submitting) return
    setSubmitting(true)
    try {
      const individualPositions = stagedFiles
        .map((item, position) => item.individual ? position : null)
        .filter(position => position !== null)
      const job = await enqueueScanJob(
        stagedFiles.map(item => item.file),
        individualPositions,
      )
      clearFiles()
      onClose?.()
      navigate(`/scans/${job.id}`)
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('scanner.batchSubmitFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={closeScanner}
        title={t('scanner.title')}
        size="xl"
        isObscured={Boolean(confirmation)}
      >
        <div className="space-y-4 p-4 sm:p-5">
          <p className="text-sm text-text-secondary">{t('scanner.subtitle')}</p>
          {scannerConfiguration?.visual_verification === 'disabled' && (
            <div role="status" className="rounded-xl border border-brand-yellow/35 bg-brand-yellow/10 px-3 py-2.5">
              <p className="text-xs font-semibold text-brand-yellow">{t('settings.scannerDegradedTitle')}</p>
              <p className="mt-1 text-[11px] text-text-secondary">{t('settings.scannerDegradedWarning')}</p>
            </div>
          )}
          <input
            ref={cameraRef}
            type="file"
            accept={SCANNER_IMAGE_ACCEPT}
            capture="environment"
            className="hidden"
            onChange={event => {
              appendFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <input
            ref={galleryRef}
            type="file"
            accept={SCANNER_IMAGE_ACCEPT}
            multiple
            className="hidden"
            onChange={event => {
              appendFiles(event.target.files)
              event.target.value = ''
            }}
          />

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                {t('scanner.photos')}
              </p>
              <p className="text-sm text-text-secondary">{stagedFiles.length}/50 {t('scanner.photos')}</p>
            </div>
            {stagedFiles.length > 0 && (
              <button
                type="button"
                onClick={requestClear}
                className="btn-ghost border-brand-red/30 px-3 py-1.5 text-xs text-brand-red hover:bg-brand-red/10"
              >
                <Trash2 size={14} />
                <span>{t('scanner.clearBatch')}</span>
              </button>
            )}
          </div>

          {stagedFiles.length > 0 ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-7">
              {stagedFiles.map((item, index) => (
                <div key={item.id} className="space-y-1.5">
                  <div className="relative aspect-[2.5/3.5] overflow-hidden rounded-xl border border-white/10 bg-bg-surface">
                    <img src={item.previewUrl} alt="" className="h-full w-full object-contain" />
                    <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(item.id)}
                      aria-label={t('common.remove')}
                      className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/75 text-white hover:bg-brand-red"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  {stagedFiles.length > 1 && (
                    <button
                      type="button"
                      onClick={() => toggleIndividual(item.id)}
                      className={`flex w-full items-center justify-center gap-1 rounded-lg border px-1 py-1 text-[9px] font-semibold transition-colors ${
                        item.individual
                          ? 'border-brand-red/50 bg-brand-red/20 text-brand-red'
                          : 'border-white/10 bg-white/5 text-text-muted'
                      }`}
                    >
                      {item.individual && <Check size={10} />}
                      <span>{t('scanner.scanIndividually')}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border-2 border-dashed border-white/10 py-12 text-center text-sm text-text-muted">
              {t('scanner.noPhotosStaged')}
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                disabled={stagedFiles.length >= 50}
                className="btn-secondary flex flex-1 items-center justify-center gap-2"
              >
                <Camera size={16} />
                <span>{t('scanner.takePhoto')}</span>
              </button>
              <div
                className="group relative z-20"
                onMouseEnter={() => {
                  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
                    setPhotoGuideHovered(true)
                  }
                }}
                onMouseLeave={() => setPhotoGuideHovered(false)}
              >
                <button
                  type="button"
                  onClick={event => {
                    const helpButton = event.currentTarget
                    setPhotoGuidePinned(current => {
                      if (current) requestAnimationFrame(() => helpButton.blur())
                      return !current
                    })
                  }}
                  className="btn-ghost grid h-full min-h-10 w-10 place-items-center p-0"
                  aria-label={t('scanner.photoGuide')}
                  aria-describedby="scanner-photo-guide"
                >
                  <HelpCircle size={18} />
                </button>
                <div
                  id="scanner-photo-guide"
                  role="tooltip"
                  className={`absolute bottom-12 right-0 w-72 rounded-2xl border border-border bg-bg-card p-4 shadow-xl transition-all group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100 ${
                    photoGuidePinned || photoGuideHovered
                      ? 'visible translate-y-0 opacity-100'
                      : 'invisible translate-y-1 opacity-0'
                  }`}
                >
                  <PhotoPositionGuide
                    title={t('scanner.photoGuideTitle')}
                    description={t('scanner.photoGuideDescription')}
                  />
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => galleryRef.current?.click()}
              disabled={stagedFiles.length >= 50}
              className="btn-secondary flex items-center justify-center gap-2"
            >
              <Upload size={16} />
              <span>{t('scanner.chooseFromGallery')}</span>
            </button>
          </div>

          {stagedFiles.length > 1 && (
            <button
              type="button"
              onClick={toggleAllIndividual}
              className="btn-ghost flex w-full items-center justify-center gap-2"
            >
              {allIndividual ? <ImagePlus size={16} /> : <Check size={16} />}
              <span>{allIndividual ? t('scanner.useAutomaticGrouping') : t('scanner.scanAllIndividually')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={startScanning}
            disabled={!stagedFiles.length || submitting}
            className="btn-primary flex w-full items-center justify-center gap-2 py-3"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
            <span>{submitting ? t('scanner.submittingBatch') : t('scanner.startScanning')}</span>
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(confirmation)}
        onClose={() => setConfirmation(null)}
        onConfirm={confirmDiscard}
        title={confirmation === 'clear' ? t('scanner.clearBatch') : t('scanner.title')}
        message={confirmation === 'clear' ? t('scanner.clearBatchConfirm') : t('scanner.discardStagedConfirm')}
        confirmLabel={confirmation === 'clear' ? t('scanner.clearBatch') : t('scanner.discardAndClose')}
        cancelLabel={t('common.cancel')}
        destructive
      />
    </>
  )
}
