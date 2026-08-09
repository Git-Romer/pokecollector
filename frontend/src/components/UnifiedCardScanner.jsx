import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, Check, ImagePlus, Loader2, Trash2, Upload, X } from 'lucide-react'
import toast from 'react-hot-toast'

import { enqueueScanJob } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { isSupportedScannerImage, SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import ConfirmDialog from './ui/ConfirmDialog'
import Modal from './ui/Modal'


export default function UnifiedCardScanner({ isOpen, onClose }) {
  const [stagedFiles, setStagedFiles] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [confirmation, setConfirmation] = useState(null)
  const cameraRef = useRef()
  const galleryRef = useRef()
  const stagedFilesRef = useRef([])
  const { t } = useSettings()
  const navigate = useNavigate()

  useEffect(() => {
    stagedFilesRef.current = stagedFiles
  }, [stagedFiles])

  useEffect(() => () => {
    stagedFilesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
  }, [])

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
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              disabled={stagedFiles.length >= 50}
              className="btn-secondary flex items-center justify-center gap-2"
            >
              <Camera size={16} />
              <span>{t('scanner.takePhoto')}</span>
            </button>
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
