import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Camera, Upload, Images, X, Check, Loader2, RefreshCw, Plus, Trash2 } from 'lucide-react'
import {
  recognizeCard,
  enqueueScanJob,
  getScanJob,
  getScanJobs,
  resolveScanJobItem,
  deleteScanJob,
  fetchScanJobItemImage,
  addToCollection,
} from '../api/client'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { CARD_VARIANTS, getDefaultVariant } from '../utils/cardVariants'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import MoneyInput from './MoneyInput'
import { parseMoneyInputValue } from '../utils/moneyInput'

// ─── Add-to-Collection Modal für Scan-Ergebnis ──────────────────────────────
function ScanAddModal({ match, defaultLang, onClose, onAdded }) {
  const { t, exchangeRate, exchangeRateReady } = useSettings()
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState(() => getDefaultVariant(match))
  const [lang, setLang] = useState(match.lang || defaultLang || 'en')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [adding, setAdding] = useState(false)
  const queryClient = useQueryClient()

  const handleAdd = async () => {
    if (!exchangeRateReady) return
    setAdding(true)
    try {
      await addToCollection({
        card_id: match.id,
        quantity,
        condition,
        variant,
        lang,
        purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
      })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(`${match.name} ${t('scanner.addedToCollection')}!`)
      onAdded && onAdded()
      onClose()
    } catch (err) {
      const msg = err?.response?.data?.detail || t('card.addFailed')
      toast.error(msg)
    } finally {
      setAdding(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[300] bg-black/80 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-2xl md:rounded-2xl bg-bg-surface border-t md:border border-border overflow-y-auto max-h-[85dvh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="p-5">
          {/* Card Info */}
          <div className="flex items-center gap-3 mb-4">
            {match.image && (
              <img src={match.image} alt={match.name}
                className="w-16 h-22 object-cover rounded-xl border border-white/10 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="font-bold text-white text-base truncate">{match.name}</p>
              <p className="text-xs font-mono text-brand-red/80 font-semibold">{`${(match.set_abbreviation || '').toUpperCase()} ${match.number || ''}`.trim()}</p>
              {match.rarity && <p className="text-[11px] text-text-muted">{match.rarity}</p>}
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary p-1 flex-shrink-0">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3">
            {/* Language */}
            <div>
              <label className="text-xs text-text-muted mb-1.5 block font-medium">🌐 {t('lang.filter')}</label>
              <TcgdexLanguageSelect value={lang} onChange={setLang} className="select w-full" />
            </div>

            {/* Quantity + Condition */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('common.quantity')}</label>
                <input
                  type="number" min="1" value={quantity}
                  onChange={e => setQuantity(parseInt(e.target.value) || 1)}
                  className="input"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                <select value={condition} onChange={e => setCondition(e.target.value)} className="select">
                  {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {/* Variant */}
            <div>
              <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
              <select value={variant} onChange={e => setVariant(e.target.value)} className="select">
                {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>


            {/* Purchase price */}
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('scanner.purchasePriceLabel')}</label>
              <MoneyInput
                placeholder={t('analytics.amountPlaceholder')}
                value={purchasePrice}
                onChange={e => setPurchasePrice(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 mt-5">
            <button
              onClick={handleAdd}
              disabled={adding || !exchangeRateReady}
              className="flex-1 py-3 rounded-xl font-black text-white flex items-center justify-center gap-2 transition-all"
              style={{ background: adding ? '#555' : '#e3000b', boxShadow: adding ? 'none' : '0 0 16px rgba(227,0,11,0.3)' }}
            >
              {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {adding ? t('scanner.adding') : t('scanner.addToCollection')}
            </button>
            <button onClick={onClose} className="btn-ghost px-3">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── Match grid — the "which of these DB candidates is it" picker ──────────
// Shared by the single-photo result view and each panel of a batch result,
// so the card-tile rendering (image, language badge, hover-to-add) only
// exists once.
function MatchesGrid({ matches, onSelect, t }) {
  if (!matches?.length) {
    return (
      <div className="text-center py-6 space-y-2">
        <p className="text-text-muted text-sm">{t('scanner.noMatches')}</p>
        <p className="text-xs text-text-muted">{t('scanner.noMatchTip')}</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
      {matches.map(match => {
        const matchLang = match.lang || match._lang || 'en'
        const setCode = (match.set_abbreviation || match.set?.id || (match.id || '').split('-')[0]).toUpperCase()
        const localNum = match.localId || match.number || ''
        const cardIdLabel = `${setCode} ${localNum}`.trim()
        return (
          <div key={`${match.id}-${matchLang}`}
            className="flex flex-col cursor-pointer group hover:shadow-glow transition-all duration-200 hover:rotate-1"
            onClick={() => onSelect(match)}
          >
            <div className="relative w-full aspect-[2.5/3.5] overflow-hidden rounded-xl ring-1 ring-white/5 group-hover:ring-2 group-hover:ring-brand-red/30 transition-all duration-200">
              {match.image
                ? <img src={match.image} alt={match.name}
                    className="w-full h-full object-cover shadow-lg group-hover:scale-[1.02] transition-transform duration-300" />
                : <div className="w-full h-full bg-bg-surface rounded-xl flex items-center justify-center">
                    <span className="text-[9px] text-text-muted text-center p-1">{match.name}</span>
                  </div>
              }
              <span className={`absolute top-1 right-1 text-[8px] font-black px-1 py-0.5 rounded leading-none ${
                matchLang === 'de'
                  ? 'bg-yellow-500/80 text-yellow-900 border border-yellow-500/50'
                  : 'bg-blue-500/80 text-white border border-blue-500/50'
              }`}>
                {matchLang === 'de' ? '🇩🇪' : '🇬🇧'}
              </span>
              {match.printed_total_mismatch && (
                <span className="absolute top-1 left-1 text-[8px] font-black px-1 py-0.5 rounded leading-none bg-amber-500/90 text-black border border-amber-400"
                  title={t('scanner.printedTotalMismatch')}>
                  ⚠
                </span>
              )}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all flex items-center justify-center opacity-0 group-hover:opacity-100 rounded-xl">
                <div className="w-7 h-7 rounded-full flex items-center justify-center"
                  style={{ background: '#e3000b', boxShadow: '0 0 12px rgba(227,0,11,0.5)' }}>
                  <Plus size={14} className="text-white" />
                </div>
              </div>
            </div>

            <div className="pt-1 flex flex-col gap-0.5">
              <p className="font-bold text-white text-[10px] leading-tight line-clamp-2">{match.name}</p>
              {cardIdLabel && (
                <p className="text-[9px] font-mono text-brand-red/80 font-semibold">{cardIdLabel}</p>
              )}
              {match.rarity && (
                <p className="text-[9px] text-text-muted truncate">{match.rarity}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// The stored photo for a queued item. Loaded as a blob because the endpoint is
// authenticated, so it survives a page reload where a local blob: URL would not.
function ScanItemThumb({ jobId, item }) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    if (!item.has_image) return undefined
    let revoked = false
    let objectUrl = null
    fetchScanJobItemImage(jobId, item.id)
      .then(next => {
        if (revoked) {
          URL.revokeObjectURL(next)
          return
        }
        objectUrl = next
        setUrl(next)
      })
      .catch(() => {})
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, item.id, item.has_image])

  if (!url) {
    return <div className="w-16 aspect-[2.5/3.5] rounded-lg flex-shrink-0 bg-white/5" />
  }
  return (
    <img src={url} className="w-16 aspect-[2.5/3.5] object-cover rounded-lg flex-shrink-0"
      style={{ border: '1px solid rgba(255,255,255,0.1)' }} />
  )
}

// One queued photo in the review list: thumbnail + detected info + its own
// MatchesGrid, or a pending/error state.
function ScanItemPanel({ jobId, item, onSelectMatch, onResolve, t }) {
  return (
    <div className={`rounded-2xl p-3 flex gap-3 transition-opacity ${item.resolved ? 'opacity-40' : ''}`}
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <ScanItemThumb jobId={jobId} item={item} />
      <div className="flex-1 min-w-0">
        {item.status === 'pending' && (
          <p className="text-sm text-text-muted flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> {t('scanner.itemPending')}
          </p>
        )}
        {item.status === 'failed' && (
          <p className="text-sm text-brand-red">{item.error || t('scanner.recognitionFailed')}</p>
        )}
        {item.status === 'done' && (
          <>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-bold text-white text-sm truncate">{item.recognized?.name || '—'}</p>
                {item.recognized?.number_local && (
                  <p className="text-xs text-text-muted">
                    Nr. {item.recognized.number_local}{item.recognized.number_total ? `/${item.recognized.number_total}` : ''}
                  </p>
                )}
              </div>
              {!item.resolved && (
                <button onClick={() => onResolve(item)}
                  title={t('scanner.markReviewedHint')}
                  className="text-[10px] font-semibold px-2 py-1 rounded-lg border border-white/10 text-text-muted hover:text-white flex-shrink-0">
                  <Check size={12} className="inline mr-1" />{t('scanner.markReviewed')}
                </button>
              )}
            </div>
            {!item.resolved && (
              <div className="mt-2">
                <MatchesGrid matches={item.matches} onSelect={match => onSelectMatch(item, match)} t={t} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const POLL_INTERVAL_MS = 3000

export default function CardScanner({ isOpen, onClose, onCardSelected }) {
  // capture -> loading -> results (single photo)
  // capture -> staging -> review (multiple photos, recognized in the background)
  const [phase, setPhase] = useState('capture')
  const [preview, setPreview] = useState(null)
  const [results, setResults] = useState(null)
  const [stagedFiles, setStagedFiles] = useState([]) // [{ id, file, previewUrl, individual }]
  const [job, setJob] = useState(null) // { id, status, total, done, failed, pending, items }
  const [openJobs, setOpenJobs] = useState([]) // unfinished/unreviewed jobs from previous sessions
  const [addModal, setAddModal] = useState(null) // { item, match }
  const fileRef = useRef()
  const multiFileRef = useRef()
  const { t } = useSettings()

  // Surface jobs still in flight (or still awaiting review) when the scanner
  // opens, so closing the tab mid-scan doesn't lose them.
  useEffect(() => {
    if (!isOpen) return
    getScanJobs()
      .then(data => {
        const open = (data.jobs || []).filter(j => j.status !== 'done' || j.done > 0)
        setOpenJobs(open)
      })
      .catch(() => {})
  }, [isOpen])

  const refreshJob = useCallback(async (jobId) => {
    try {
      const data = await getScanJob(jobId)
      setJob(data)
      return data
    } catch {
      return null
    }
  }, [])

  // Poll while the job still has work outstanding. Recognition is paced against
  // the Gemini rate limit server-side, so this can run for a while.
  useEffect(() => {
    if (!job?.id) return undefined
    if (job.status === 'done' || job.status === 'failed') return undefined
    const timer = setInterval(() => { refreshJob(job.id) }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [job?.id, job?.status, refreshJob])

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

  const submitBatch = async () => {
    if (!stagedFiles.length) return
    try {
      const created = await enqueueScanJob({
        batched: stagedFiles.filter(f => !f.individual).map(f => f.file),
        singles: stagedFiles.filter(f => f.individual).map(f => f.file),
      })
      stagedFiles.forEach(f => URL.revokeObjectURL(f.previewUrl))
      setStagedFiles([])
      setPhase('review')
      await refreshJob(created.id)
    } catch (e) {
      const msg = e?.response?.data?.detail || t('scanner.recognitionFailed')
      toast.error(msg)
    }
  }

  const openExistingJob = async (jobId) => {
    setPhase('review')
    await refreshJob(jobId)
  }

  const handleResolveItem = async (item) => {
    if (!job?.id) return
    try {
      await resolveScanJobItem(job.id, item.id)
      await refreshJob(job.id)
    } catch (e) {
      toast.error(e?.response?.data?.detail || t('scanner.recognitionFailed'))
    }
  }

  const handleDiscardJob = async () => {
    if (!job?.id) return
    try {
      await deleteScanJob(job.id)
      setJob(null)
      setPhase('capture')
    } catch (e) {
      toast.error(e?.response?.data?.detail || t('scanner.recognitionFailed'))
    }
  }

  const reset = () => {
    stagedFiles.forEach(f => URL.revokeObjectURL(f.previewUrl))
    setPhase('capture')
    setPreview(null)
    setResults(null)
    setStagedFiles([])
    setJob(null)
    setAddModal(null)
  }

  // Prefer the language detected for the specific card being added; fall back
  // to the single-scan result, then English.
  const detectedLang =
    addModal?.item?.recognized?.language ||
    addModal?.match?.lang ||
    results?.recognized?.language ||
    addModal?.lang ||
    'en'

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
              <Images size={14} /> {t('scanner.uploadMultiple')}
            </button>

            <p className="text-[11px] text-text-muted text-center max-w-xs">
              {t('scanner.aiHint')}
            </p>

            {/* Scans still running or awaiting review from a previous visit */}
            {openJobs.length > 0 && (
              <div className="w-full max-w-xs space-y-2 pt-2">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                  {t('scanner.openJobs')}
                </p>
                {openJobs.map(j => (
                  <button key={j.id} onClick={() => openExistingJob(j.id)}
                    className="w-full text-left px-3 py-2 rounded-xl border border-white/10 hover:border-white/25 transition-colors">
                    <span className="text-xs text-white font-semibold">
                      {j.done}/{j.total} {t('scanner.jobProgressSuffix')}
                    </span>
                    {j.pending > 0 && (
                      <Loader2 size={12} className="inline ml-2 animate-spin text-text-muted" />
                    )}
                  </button>
                ))}
              </div>
            )}
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
                <MatchesGrid matches={results.matches} onSelect={setAddModal} t={t} />
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

        {/* REVIEW — queued batch, results stream in as the worker finishes them */}
        {phase === 'review' && job && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                {t('scanner.batchResultsTitle')} — {job.done}/{job.total}
                {job.failed > 0 && ` (${job.failed} ${t('scanner.jobFailedSuffix')})`}
              </p>
              {job.pending > 0 && (
                <span className="text-[10px] text-text-muted flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" /> {t('scanner.jobRunning')}
                </span>
              )}
            </div>

            {job.pending > 0 && (
              <p className="text-[11px] text-text-muted">{t('scanner.queueHint')}</p>
            )}

            {job.error_message && (
              <p className="text-sm text-brand-red">{job.error_message}</p>
            )}

            {(job.items || []).map(item => (
              <ScanItemPanel
                key={item.id}
                jobId={job.id}
                item={item}
                onSelectMatch={(scanItem, match) => setAddModal({ item: scanItem, match })}
                onResolve={handleResolveItem}
                t={t}
              />
            ))}

            <div className="flex gap-2">
              <button onClick={reset}
                className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-text-muted hover:text-white transition-colors"
                style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
                <RefreshCw size={15} /> {t('scanner.scanAgain')}
              </button>
              <button onClick={handleDiscardJob}
                title={t('scanner.discardJobHint')}
                className="px-4 py-3 rounded-xl flex items-center justify-center text-sm font-semibold text-text-muted hover:text-brand-red transition-colors"
                style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Add-to-collection modal. From the review list the match is wrapped with
          its scan item so adding it can also mark that item reviewed. */}
      {addModal && (
        <ScanAddModal
          match={addModal.match || addModal}
          defaultLang={detectedLang}
          onClose={() => setAddModal(null)}
          onAdded={() => {
            if (addModal.item) handleResolveItem(addModal.item)
            setAddModal(null)
          }}
        />
      )}
    </div>,
    document.body
  )
}
