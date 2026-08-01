import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Camera, Upload, Images, X, Check, Loader2, RefreshCw, Plus } from 'lucide-react'
import { recognizeCard, recognizeCardsBatch, addToCollection } from '../api/client'
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

// One photo's result inside the batch-results list: thumbnail + detected info
// + its own MatchesGrid, or an error panel if that photo's recognition failed.
function ScanResultPanel({ previewUrl, result, onSelectMatch, t }) {
  return (
    <div className="rounded-2xl p-3 flex gap-3"
      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {previewUrl && (
        <img src={previewUrl} className="w-16 aspect-[2.5/3.5] object-cover rounded-lg flex-shrink-0"
          style={{ border: '1px solid rgba(255,255,255,0.1)' }} />
      )}
      <div className="flex-1 min-w-0">
        {result.error ? (
          <p className="text-sm text-brand-red">{result.error}</p>
        ) : (
          <>
            <p className="font-bold text-white text-sm truncate">{result.recognized?.name || '—'}</p>
            {result.recognized?.number_local && (
              <p className="text-xs text-text-muted">
                Nr. {result.recognized.number_local}{result.recognized.number_total ? `/${result.recognized.number_total}` : ''}
              </p>
            )}
            <div className="mt-2">
              <MatchesGrid matches={result.matches} onSelect={onSelectMatch} t={t} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function CardScanner({ isOpen, onClose, onCardSelected }) {
  // capture -> loading -> results (single photo)
  // capture -> staging -> batch-loading -> batch-results (multiple photos)
  const [phase, setPhase] = useState('capture')
  const [preview, setPreview] = useState(null)
  const [results, setResults] = useState(null)
  const [stagedFiles, setStagedFiles] = useState([]) // [{ id, file, previewUrl, individual }]
  const [batchResults, setBatchResults] = useState(null) // [{ previewUrl, filename, recognized, matches, error }]
  const [addModal, setAddModal] = useState(null) // match to show modal for
  const fileRef = useRef()
  const multiFileRef = useRef()
  const { t } = useSettings()

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
    setStagedFiles(prev => prev.filter(f => f.id !== id))
  }

  const runBatchScan = async () => {
    if (!stagedFiles.length) return
    setPhase('batch-loading')
    const batched = stagedFiles.filter(f => !f.individual)
    const singles = stagedFiles.filter(f => f.individual)
    const previewById = new Map(stagedFiles.map(f => [f.file, f.previewUrl]))
    try {
      const data = await recognizeCardsBatch({
        batched: batched.map(f => f.file),
        singles: singles.map(f => f.file),
      })
      const combined = [
        ...(data.batched || []).map((r, i) => ({ ...r, previewUrl: previewById.get(batched[i]?.file) })),
        ...(data.singles || []).map((r, i) => ({ ...r, previewUrl: previewById.get(singles[i]?.file) })),
      ]
      setBatchResults(combined)
      setPhase('batch-results')
    } catch (e) {
      const msg = e?.response?.data?.detail || t('scanner.recognitionFailed')
      toast.error(msg)
      setPhase('staging')
    }
  }

  const reset = () => {
    setPhase('capture')
    setPreview(null)
    setResults(null)
    setStagedFiles([])
    setBatchResults(null)
    setAddModal(null)
  }

  const detectedLang = (results?.recognized?.language) || (addModal?.lang) || 'en'

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
              <button onClick={runBatchScan}
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

        {/* LOADING (batch) */}
        {phase === 'batch-loading' && (
          <div className="flex flex-col items-center gap-6 pt-8">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={32} className="text-brand-red animate-spin" />
              <p className="text-sm text-text-secondary font-medium">{t('scanner.batchScanning')}</p>
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

        {/* RESULTS (batch) */}
        {phase === 'batch-results' && batchResults && (
          <div className="space-y-3">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
              {t('scanner.batchResultsTitle')} ({batchResults.length})
            </p>
            {batchResults.map((result, i) => (
              <ScanResultPanel
                key={`${result.filename}-${i}`}
                previewUrl={result.previewUrl}
                result={result}
                onSelectMatch={setAddModal}
                t={t}
              />
            ))}

            <button onClick={reset}
              className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-text-muted hover:text-white transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <RefreshCw size={15} /> {t('scanner.scanAgain')}
            </button>
          </div>
        )}
      </div>

      {/* Add-to-collection modal */}
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
