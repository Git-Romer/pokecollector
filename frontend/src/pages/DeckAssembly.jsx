import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Copy, Download, Minus, Plus, Printer, RotateCcw } from 'lucide-react'
import toast from 'react-hot-toast'
import { useNavigate, useParams } from 'react-router-dom'
import { getDeck, getDeckAssemblyProgress, resetDeckAssemblyProgress, updateDeck, updateDeckAssemblyProgress } from '../api/client'
import DeckCardViewer from '../components/decks/DeckCardViewer'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { useSettings } from '../contexts/SettingsContext'
import { assemblyEntries, assemblyProgress, deckAssemblyCsv, deckAssemblyText, missingDeckCards } from '../utils/deckAssembly'
import { groupDeckEntries, nextDeckCardIndex, previousDeckCardIndex } from '../utils/deckProgress'

const progressKey = deckId => ['deck-assembly-progress', String(deckId)]

export default function DeckAssembly() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const { t } = useSettings()
  const confirm = useConfirmDialog()
  const queryClient = useQueryClient()
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))
  const [viewerIndex, setViewerIndex] = useState(null)
  const { data: deck, isLoading } = useQuery({ queryKey: ['deck', deckId], queryFn: () => getDeck(deckId).then(response => response.data) })
  const { data: savedProgress = [] } = useQuery({ queryKey: progressKey(deckId), queryFn: () => getDeckAssemblyProgress(deckId).then(response => response.data) })
  const setProgress = useMutation({
    mutationFn: data => updateDeckAssemblyProgress(deckId, data).then(response => response.data),
    onSuccess: data => queryClient.setQueryData(progressKey(deckId), current => (current || []).filter(item => item.entry_id !== data.entry_id).concat(data)),
    onError: error => toast.error(error.response?.data?.detail || t('common.error')),
  })
  const resetProgress = useMutation({
    mutationFn: () => resetDeckAssemblyProgress(deckId),
    onSuccess: () => queryClient.setQueryData(progressKey(deckId), []),
    onError: error => toast.error(error.response?.data?.detail || t('common.error')),
  })
  const reserveDeck = useMutation({ mutationFn: () => updateDeck(deckId, { inventory_state: 'reserved' }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deck', deckId] }) })

  if (isLoading) return <div className="skeleton h-96 rounded-xl" />
  if (!deck) return null

  const entries = assemblyEntries(deck.entries, Object.fromEntries(savedProgress.map(item => [item.entry_id, item.pulled_quantity])))
  const summary = assemblyProgress(entries)
  const missing = missingDeckCards(entries)
  const groups = groupDeckEntries(entries)
  const updateEntry = (entry, quantity) => setProgress.mutate({ entry_id: entry.id, pulled_quantity: quantity })
  const copy = async (text, success) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(success)
    } catch {
      toast.error(t('common.error'))
    }
  }
  const downloadCsv = () => {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([deckAssemblyCsv(entries)], { type: 'text/csv;charset=utf-8' }))
    link.download = `${deck.name.replaceAll(/[^a-z0-9]+/gi, '-').replaceAll(/^-|-$/g, '') || 'deck'}-checklist.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 0)
  }

  return (
    <div className="deck-assembly space-y-4 pb-8">
      <div className="no-print flex items-center justify-between gap-2">
        <button className="btn-ghost" onClick={() => navigate(`/decks/${deckId}`)}><ArrowLeft size={16} /> {t('decks.backToEditor')}</button>
        <button className="btn-ghost text-brand-red" disabled={!summary.pulled || resetProgress.isPending} onClick={async () => { if (await confirm({ title: t('decks.resetChecklist'), message: t('decks.resetChecklistConfirm') })) resetProgress.mutate() }}><RotateCcw size={16} /> {t('decks.resetChecklist')}</button>
      </div>

      <header className="sticky top-0 z-10 -mx-1 space-y-3 rounded-xl border border-border bg-bg-primary/95 p-4 shadow-sm backdrop-blur print:static print:border-0 print:bg-white print:p-0 print:shadow-none">
        <div><h1 className="text-2xl font-bold text-text-primary">{t('decks.buildDeck')}: {deck.name}</h1><p className="text-sm text-text-muted">{t('decks.target')}: {summary.required} · Inventory status: {deck.inventory_state === 'reserved' ? 'Reserved' : 'Planning'}</p>{deck.inventory_state !== 'reserved' && <button className="btn-secondary mt-2" onClick={() => reserveDeck.mutate()} disabled={reserveDeck.isPending}>Reserve collection for this deck</button>}</div>
        {!deck.validation?.valid && <p className="no-print rounded-lg bg-brand-red/10 px-3 py-2 text-sm font-medium text-brand-red">{label('decks.validationErrors', { count: deck.validation?.errors?.length || 0 })}</p>}
        <div className="h-3 overflow-hidden rounded-full bg-bg-elevated" role="progressbar" aria-label={t('decks.pulledProgress')} aria-valuenow={summary.pulled} aria-valuemax={summary.required}><div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${summary.percent}%` }} /></div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs sm:text-sm">
          <p><strong className="block text-text-primary">{summary.pulled} / {summary.required}</strong>{t('decks.pulled')}</p>
          <p><strong className="block text-brand-red">{summary.missing}</strong>{t('decks.missingFromCollection')}</p>
          <p><strong className="block text-text-primary">{summary.remainingToPull}</strong>{t('decks.remainingToPull')}</p>
        </div>
      </header>

      <div className="no-print flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={() => copy(deckAssemblyText(deck, entries), t('decks.checklistCopied'))}><Copy size={15} /> {t('decks.copyChecklist')}</button>
        <button className="btn-secondary" onClick={downloadCsv}><Download size={15} /> {t('decks.exportChecklistCsv')}</button>
        <button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> {t('decks.printChecklist')}</button>
      </div>

      {missing.length > 0 && <section className="no-print card space-y-2"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-text-primary">{t('decks.missingCards')}</h2><button className="btn-ghost text-xs" onClick={() => copy(deckAssemblyText(deck, entries, true), t('decks.missingCopied'))}><Copy size={14} /> {t('common.copy')}</button></div>{missing.map(entry => <p key={entry.id} className="text-sm text-brand-red">{entry.missing_quantity}x {entry.card?.name || entry.card_id}</p>)}</section>}

      {Object.entries(groups).map(([category, categoryEntries]) => categoryEntries.length > 0 && <section key={category} className="space-y-2"><h2 className="px-1 text-sm font-bold uppercase tracking-wider text-text-muted">{t(`decks.${category}`)}</h2>{categoryEntries.map(entry => {
        const index = entries.findIndex(item => item.id === entry.id)
        const max = Math.min(entry.required_quantity, entry.available_quantity ?? entry.owned_quantity)
        return <article key={entry.id} className="rounded-xl border border-border bg-bg-card p-4"><div className="flex items-center gap-3"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => setViewerIndex(index)}><p className="font-semibold text-text-primary">{entry.required_quantity}x {entry.card?.name || entry.card_id}</p><p className="mt-1 text-xs text-text-muted">{t('decks.required')}: {entry.required_quantity} · {t('decks.ownedLabel')}: {entry.owned_quantity}{entry.shortage > 0 && <span className="text-brand-red"> · {t('decks.missingLabel')}: {entry.shortage}</span>}</p></button><div className="flex shrink-0 items-center gap-1" aria-label={`${entry.card?.name || entry.card_id} ${t('decks.pulled')}`}><button type="button" className="rounded-lg border border-border p-3 text-text-primary disabled:opacity-35" disabled={entry.pulled_quantity <= 0 || setProgress.isPending} onClick={() => updateEntry(entry, entry.pulled_quantity - 1)} aria-label={t('decks.decrementPulled')}><Minus size={18} /></button><button type="button" className="min-w-16 rounded-lg bg-bg-elevated px-2 py-3 text-sm font-bold text-text-primary" onClick={() => updateEntry(entry, max)} aria-label={t('decks.markAllPulled')}>{entry.pulled_quantity} / {entry.required_quantity}</button><button type="button" className="rounded-lg border border-border p-3 text-text-primary disabled:opacity-35" disabled={entry.pulled_quantity >= max || setProgress.isPending} onClick={() => updateEntry(entry, entry.pulled_quantity + 1)} aria-label={t('decks.incrementPulled')}><Plus size={18} /></button></div></div>{entry.shortage > 0 && <p className="mt-2 text-xs font-medium text-brand-red">{t('decks.pulledLimitedToOwned')}</p>}</article>
      })}</section>)}

      <DeckCardViewer entries={entries} activeIndex={viewerIndex} onClose={() => setViewerIndex(null)} onPrevious={() => setViewerIndex(index => previousDeckCardIndex(index, entries.length))} onNext={() => setViewerIndex(index => nextDeckCardIndex(index, entries.length))} t={t} label={label} />
    </div>
  )
}
