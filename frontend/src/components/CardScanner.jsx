import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Camera, Upload, ImagePlus, X, Loader2, RefreshCw } from 'lucide-react'
import { recognizeCard, enqueueScanJob } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { ScanAddModal, MatchesGrid, CardZoomModal } from './ScanReview'

export default function CardScanner({ isOpen, onClose, onCardSelected }) {
  // capture -> loading -> results (single photo, answered inline)
  // capture -> staging -> queued (multiple photos; reviewed on /scans, not here)
  const [phase, setPhase] = useState('capture')
  const [preview, setPreview] = useState(null)
  const [results, setResults] = useState(null)
  const [stagedFiles, setStagedFiles] = useState([]) // [{ id, file, previewUrl, individual }]
  const [addModal, setAddModal] = useState(null) // match to add
  const [zoomCard, setZoomCard] = useState(null)
  const fileRef = useRef()
  const multiFileRef = useRef()
  const { t } = useSettings()
  const navigate = useNavigate()

  if (!isOpen) return null

  const handleFile = async (file) => {
    if (!file) return
    setPreview(URL.createObjectURL(file))
    setPhase('loading')
    try {
      const data = await recognizeCard(file)
      setResults(data)
      setPhase('results')
    } catch (e) {
      const msg = e?.response?.data?.detail || t('scanner.recognitionFailed')
      toast.error(msg)
      setPhase('capture')
      setPreview(null)
    }
  }

  const handleMultiFiles = (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setStagedFiles(files.map((file, i) => ({
      id: `${Date.now()}-${i}`,
      file,
      previewUrl: URL.createObjectURL(file),
      individual: false,
    })))
    setPhase('staging')
  }

  const toggleIndividual = (id) => {
    setStagedFiles(prev => prev.map(f => f.id === id ? { ...f, individual: !f.individual } : f))
  }

  const removeStagedFile = (id) => {
    setStagedFiles(prev => {
      const target = prev.find(f => f.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(f => f.id !== id)
    })
  }

  // Queue the batch, then hand off to the queue page — recognition runs in the
  // background, so there is nothing to wait for here.
  const submitBatch = async () => {
    if (!stagedFiles.length) return
    try {
      const created = await enqueueScanJob({
        batched: stagedFiles.filter(f => !f.individual).map(f => f.file),
        singles: stagedFiles.filter(f => f.individual).map(f => f.file),
      })
      stagedFiles.forEach(f => URL.revokeObjectURL(f.previewUrl))
      setStagedFiles([])
      setPhase('capture')
      onClose && onClose()
      navigate(`/scans/${created.id}`)
    } catch (e) {
      const msg = e?.response?.data?.detail || t('scanner.recognitionFailed')
      toast.error(msg)
    }
  }

  const reset = () => {
    stagedFiles.forEach(f => URL.revokeObjectURL(f.previewUrl))
    setPhase('capture')
    setPreview(null)
    setResults(null)
    setStagedFiles([])
    setAddModal(null)
  }

  const detectedLang = results?.recognized?.language || addModal?.lang || 'en'

  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col"
      style={{ background: 'rgba(0,0,0,0.95)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-6 pb-4 flex-shrink-0">
        <div>
          <p className="text-[10px] text-text-muted uppercase tracking-[0.2em]">{t('scanner.title')}</p>
          <h2 className="text-lg font-black text-white">{t('scanner.subtitle')}</h2>
        </div>
        <button onClick={onClose}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.08)' }}>
          <X size={18} className="text-text-muted" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8">

        {/* CAPTURE */}
        {phase === 'capture' && (
          <div className="flex flex-col items-center gap-5 pt-4">
            <div className="w-full max-w-xs aspect-[2.5/3.5] rounded-2xl flex flex-col items-center justify-center relative"
              style={{ border: '2px dashed rgba(227,0,11,0.4)', background: 'rgba(227,0,11,0.04)' }}>
              <div className="absolute top-2 left-2 w-6 h-6 border-t-2 border-l-2 border-brand-red rounded-tl" />
              <div className="absolute top-2 right-2 w-6 h-6 border-t-2 border-r-2 border-brand-red rounded-tr" />
              <div className="absolute bottom-2 left-2 w-6 h-6 border-b-2 border-l-2 border-brand-red rounded-bl" />
              <div className="absolute bottom-2 right-2 w-6 h-6 border-b-2 border-r-2 border-brand-red rounded-br" />
              <Camera size={40} className="text-brand-red opacity-40 mb-2" />
              <p className="text-xs text-text-muted text-center px-6">{t('scanner.alignCard')}</p>
            </div>

            <input ref={fileRef} type="file" accept="image/*" capture="environment"
              className="hidden" onChange={e => handleFile(e.target.files?.[0])} />
            <input ref={multiFileRef} type="file" accept="image/*" multiple
              className="hidden" onChange={e => { handleMultiFiles(e.target.files); e.target.value = '' }} />

            <button onClick={() => fileRef.current?.click()}
              className="w-full max-w-xs py-4 rounded-2xl font-black text-white text-base flex items-center justify-center gap-3"
              style={{ background: '#e3000b', boxShadow: '0 0 24px rgba(227,0,11,0.35)' }}>
              <Camera size={20} /> {t('scanner.takePhoto')}
            </button>

            <button
              onClick={() => {
                if (fileRef.current) {
                  fileRef.current.removeAttribute('capture')
                  fileRef.current.click()
                }
              }}
              className="text-sm text-text-muted hover:text-text-secondary flex items-center gap-2 transition-colors">
              <Upload size={14} /> {t('scanner.uploadImage')}
            </button>

            <button
              onClick={() => multiFileRef.current?.click()}
              className="text-sm text-text-muted hover:text-text-secondary flex items-center gap-2 transition-colors">
              <ImagePlus size={14} /> {t('scanner.uploadMultiple')}
            </button>

            <p className="text-[11px] text-text-muted text-center max-w-xs">
              {t('scanner.aiHint')}
            </p>

          </div>
        )}

        {/* STAGING — review/toggle photos before a batch scan */}
        {phase === 'staging' && (
          <div className="space-y-4">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
              {t('scanner.stagingTitle')} ({stagedFiles.length})
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {stagedFiles.map(f => (
                <div key={f.id} className="flex flex-col gap-1.5">
                  <div className="relative w-full aspect-[2.5/3.5] rounded-xl overflow-hidden ring-1 ring-white/10">
                    <img src={f.previewUrl} className="w-full h-full object-cover" />
                    <button onClick={() => removeStagedFile(f.id)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center bg-black/70">
                      <X size={12} className="text-white" />
                    </button>
                  </div>
                  <button
                    onClick={() => toggleIndividual(f.id)}
                    title={t('scanner.processIndividuallyHint')}
                    className={`text-[9px] font-semibold py-1 rounded-lg border transition-colors ${
                      f.individual
                        ? 'bg-brand-red/20 border-brand-red/50 text-brand-red'
                        : 'bg-white/5 border-white/10 text-text-muted'
                    }`}>
                    {f.individual ? `✓ ${t('scanner.processIndividually')}` : t('scanner.processIndividually')}
                  </button>
                </div>
              ))}
            </div>

            {stagedFiles.length === 0 ? (
              <p className="text-center text-sm text-text-muted py-4">{t('scanner.noPhotosStaged')}</p>
            ) : (
              <button onClick={submitBatch}
                className="w-full py-4 rounded-2xl font-black text-white text-base flex items-center justify-center gap-3"
                style={{ background: '#e3000b', boxShadow: '0 0 24px rgba(227,0,11,0.35)' }}>
                <Camera size={20} /> {t('scanner.scanCount')} ({stagedFiles.length})
              </button>
            )}

            <button onClick={reset}
              className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-text-muted hover:text-white transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              {t('common.cancel')}
            </button>
          </div>
        )}

        {/* LOADING (single) */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center gap-6 pt-8">
            {preview && preview.startsWith("blob:") && (
              <img src={preview} className="w-40 aspect-[2.5/3.5] object-cover rounded-xl"
                style={{ border: '1px solid rgba(255,255,255,0.1)' }} />
            )}
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={32} className="text-brand-red animate-spin" />
              <p className="text-sm text-text-secondary font-medium">{t('scanner.recognizing')}</p>
              <p className="text-xs text-text-muted text-center">{t('scanner.analyzing')}</p>
            </div>
          </div>
        )}

        {/* RESULTS (single) */}
        {phase === 'results' && results && (
          <div className="space-y-4">
            <div className="rounded-2xl p-4"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted mb-2">{t('scanner.detected')}</p>
              <p className="font-bold text-white text-lg">{results.recognized?.name || '—'}</p>
              {results.recognized?.number_local && (
                <p className="text-sm text-text-muted">
                  Nr. {results.recognized.number_local}{results.recognized.number_total ? `/${results.recognized.number_total}` : ''}
                </p>
              )}
              {results.recognized?.language && (
                <p className="text-xs text-text-muted mt-0.5 uppercase tracking-wider">
                  {t('scanner.detectedLanguage')} {results.recognized.language}
                </p>
              )}
            </div>

            {results.matches?.length > 0 ? (
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted mb-3">
                  {t('scanner.matches')} ({results.matches.length})
                </p>
                <MatchesGrid matches={results.matches} onSelect={setAddModal} onZoom={setZoomCard} t={t} />
              </div>
            ) : (
              <MatchesGrid matches={[]} onSelect={setAddModal} t={t} />
            )}

            <button onClick={reset}
              className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-text-muted hover:text-white transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <RefreshCw size={15} /> {t('scanner.scanAgain')}
            </button>
          </div>
        )}

      </div>

      {/* Add-to-collection modal (single-photo scans only — queued batches are
          reviewed on /scans). */}
      {zoomCard && (
        <CardZoomModal card={zoomCard} photoUrl={preview} onClose={() => setZoomCard(null)} t={t} />
      )}

      {addModal && (
        <ScanAddModal
          match={addModal}
          defaultLang={detectedLang}
          onClose={() => setAddModal(null)}
          onAdded={() => setAddModal(null)}
        />
      )}
    </div>,
    document.body
  )
}
