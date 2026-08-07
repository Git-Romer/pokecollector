import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Camera, Upload, X, Check, Loader2, RefreshCw, Plus } from 'lucide-react'
import { recognizeCard, addToCollection } from '../api/client'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { CARD_VARIANTS, getDefaultVariant } from '../utils/cardVariants'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import MoneyInput from './MoneyInput'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { CardDisplay } from './card-system'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { isSupportedScannerImage, SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'

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
      className="fixed inset-0 z-[300] flex items-end justify-center bg-black/80 p-2 backdrop-blur-sm sm:items-center sm:p-3"
      onClick={onClose}
    >
      <div
        className="relative max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-bg-surface shadow-2xl sm:max-h-[calc(100dvh-1.5rem)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20 sm:hidden" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-50 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/70 text-white shadow-lg hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
          aria-label={t('common.close')}
        >
          <X size={18} />
        </button>
        <div className="p-5">
          {/* Card Info */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-16 flex-shrink-0">
              <CardDisplay variant="artwork" card={match} image={match.image} alt={match.name} showStateIndicators={false} loading="eager" />
            </div>
            <div className="flex-1 min-w-0 pr-9">
              <p className="font-bold text-white text-base truncate">{match.name}</p>
              <p className="text-xs font-mono text-brand-red/80 font-semibold">{`${(match.set_abbreviation || '').toUpperCase()} ${match.number || ''}`.trim()}</p>
              {match.rarity && <p className="text-[11px] text-text-muted">{match.rarity}</p>}
            </div>
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

export default function CardScanner({ isOpen, onClose, onCardSelected }) {
  const [phase, setPhase] = useState('capture') // 'capture' | 'loading' | 'results'
  const [preview, setPreview] = useState(null)
  const [results, setResults] = useState(null)
  const [selectedMatch, setSelectedMatch] = useState(null)
  const [addModal, setAddModal] = useState(null) // match to show modal for
  const fileRef = useRef()
  const { t } = useSettings()

  if (!isOpen) return null

  const handleFile = async (file) => {
    if (!file) return
    if (!isSupportedScannerImage(file)) {
      toast.error(t('scanner.recognitionFailed'))
      return
    }
    setPreview(URL.createObjectURL(file))
    setPhase('loading')
    try {
      const data = await recognizeCard(file)
      setResults(data)
      setSelectedMatch(data.matches?.[0] || null)
      setPhase('results')
    } catch (e) {
      const msg = e?.response?.data?.detail || t('scanner.recognitionFailed')
      toast.error(msg)
      setPhase('capture')
      setPreview(null)
    }
  }

  const reset = () => {
    setPhase('capture')
    setPreview(null)
    setResults(null)
    setSelectedMatch(null)
    setAddModal(null)
  }

  const detectedLang = results?.recognized?.language || 'en'

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

            <input ref={fileRef} type="file" accept={SCANNER_IMAGE_ACCEPT} capture="environment"
              className="hidden" onChange={e => handleFile(e.target.files?.[0])} />

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

            <p className="text-[11px] text-text-muted text-center max-w-xs">
              {t('scanner.aiHint')}
            </p>
          </div>
        )}

        {/* LOADING */}
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

        {/* RESULTS */}
        {phase === 'results' && results && (
          <div className="mx-auto max-w-6xl space-y-4 pb-24 sm:pb-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
              <div className="hidden rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:block">
                <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                  {t('scanner.yourScan')}
                </p>
                {preview && preview.startsWith('blob:') && (
                  <img
                    src={preview}
                    alt={t('scanner.yourScan')}
                    className="mx-auto max-h-[28rem] w-full rounded-xl object-contain"
                  />
                )}
              </div>

              <div className="space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">{t('scanner.detected')}</p>
                  <p className="text-lg font-bold text-white">{results.recognized?.name || '—'}</p>
                  {results.recognized?.number && <p className="text-sm text-text-muted">Nr. {results.recognized.number}</p>}
                  {results.recognized?.language && (
                    <p className="mt-0.5 text-xs uppercase tracking-wider text-text-muted">
                      {t('scanner.detectedLanguage')} {results.recognized.language}
                    </p>
                  )}
                </div>

                {results.matches?.length > 0 ? (
                  <div>
                    <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                      {t('scanner.bestMatches')} ({results.matches.length})
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {results.matches.map(match => {
                        const matchLang = match.lang || match._lang || 'en'
                        const selected = selectedMatch?.id === match.id
                          && (selectedMatch?.lang || selectedMatch?._lang || 'en') === matchLang
                        return (
                          <CardDisplay
                            key={`${match.id}-${matchLang}`}
                            variant="selectable"
                            card={match}
                            image={match.image}
                            languageLabel={tcgdexLanguageLabel(matchLang)}
                            selected={selected}
                            onClick={() => setSelectedMatch(match)}
                            onSelect={() => setSelectedMatch(match)}
                          />
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 py-6 text-center">
                    <p className="text-sm text-text-muted">{t('scanner.noMatches')}</p>
                    <p className="text-xs text-text-muted">{t('scanner.noMatchTip')}</p>
                  </div>
                )}
              </div>
            </div>

            <button onClick={reset}
              className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-text-muted hover:text-white transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <RefreshCw size={15} /> {t('scanner.scanAgain')}
            </button>

            {selectedMatch && (
              <div className="fixed bottom-3 left-3 right-3 z-20 rounded-2xl border border-white/15 bg-bg-surface/95 p-3 shadow-2xl backdrop-blur sm:sticky sm:bottom-3 sm:mx-auto sm:flex sm:max-w-xl sm:items-center sm:gap-3">
                <div className="mb-2 min-w-0 flex-1 sm:mb-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">{t('scanner.selectedMatch')}</p>
                  <p className="truncate text-sm font-bold text-text-primary">{selectedMatch.name}</p>
                </div>
                <button
                  type="button"
                  className="btn-primary w-full justify-center sm:w-auto"
                  onClick={() => setAddModal(selectedMatch)}
                >
                  <Check size={16} />
                  {t('scanner.useSelectedMatch')}
                </button>
              </div>
            )}
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
