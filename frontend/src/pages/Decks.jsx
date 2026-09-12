import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Copy, GitCompare, Layers3, PackageOpen, Plus } from 'lucide-react'
import toast from 'react-hot-toast'
import { createDeck, duplicateDeck, getDecks } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { deckProgress } from '../utils/deckProgress'
import DeckCompositionBar from '../components/decks/DeckCompositionBar'
import DeckValidationPanel from '../components/decks/DeckValidationPanel'
import InventoryExportMenu from '../components/decks/InventoryExportMenu'

export default function Decks() {
  const { t } = useSettings()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [targetSize, setTargetSize] = useState(60)
  const [description, setDescription] = useState('')
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))
  const { data: decks = [], isLoading } = useQuery({ queryKey: ['decks'], queryFn: () => getDecks().then(response => response.data) })
  const createMutation = useMutation({
    mutationFn: createDeck,
    onSuccess: response => {
      queryClient.invalidateQueries({ queryKey: ['decks'] })
      toast.success(t('decks.created'))
      navigate(`/decks/${response.data.id}`)
    },
    onError: error => toast.error(error.response?.data?.detail || t('decks.createFailed')),
  })
  const duplicateMutation = useMutation({ mutationFn: duplicateDeck, onSuccess: response => { queryClient.invalidateQueries({ queryKey: ['decks'] }); toast.success('Deck duplicated'); navigate(`/decks/${response.data.id}`) }, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })
  const submit = event => {
    event.preventDefault()
    if (name.trim()) createMutation.mutate({ name: name.trim(), target_size: targetSize, description: description.trim() || null })
  }

  return <div className="space-y-4 pb-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold text-text-primary">{t('decks.title')}</h1><p className="mt-1 text-sm text-text-secondary">{t('decks.subtitle')}</p></div>
      <div className="flex gap-2"><button className="btn-secondary" onClick={() => navigate('/decks/inventory')}><PackageOpen size={16} /> Inventory Usage</button><InventoryExportMenu /><button className="btn-secondary" disabled={decks.length < 2} onClick={() => navigate(`/decks/compare?left=${decks[0]?.id}&right=${decks[1]?.id}`)}><GitCompare size={16} /> Compare</button><button className="btn-primary" onClick={() => setCreating(value => !value)}><Plus size={16} /> {t('decks.newDeck')}</button></div>
    </div>
    {creating && <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
      <input className="input sm:col-span-2" autoFocus required value={name} onChange={event => setName(event.target.value)} placeholder={t('decks.name')} />
      <input className="input sm:col-span-2" value={description} onChange={event => setDescription(event.target.value)} placeholder={t('decks.description')} />
      <label className="text-sm text-text-secondary">{t('decks.target')}<select className="select mt-1" value={targetSize} onChange={event => setTargetSize(Number(event.target.value))}>{[20, 40, 60].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <div className="flex items-end justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setCreating(false)}>{t('common.cancel')}</button><button className="btn-primary" disabled={createMutation.isPending}>{t('decks.createDeck')}</button></div>
    </form>}
    {isLoading ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[1, 2, 3].map(key => <div key={key} className="skeleton h-36 rounded-xl" />)}</div> : decks.length === 0 ? <div className="card py-16 text-center"><Layers3 size={46} className="mx-auto mb-3 text-text-muted" /><p className="text-text-secondary">{t('decks.empty')}</p><p className="mt-1 text-xs text-text-muted">{t('decks.emptyHint')}</p></div> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{decks.map(deck => {
      const progress = deckProgress(deck)
      return <div key={deck.id} className="card min-h-36 text-left transition-colors hover:border-brand-red/40">
        <button onClick={() => navigate(`/decks/${deck.id}`)} className="w-full text-left">
        <div className="flex items-start justify-between gap-2"><h2 className="truncate font-semibold text-text-primary">{deck.name}</h2><span className={`shrink-0 text-xs font-bold ${progress.status === 'complete' ? 'text-green' : progress.status === 'over' ? 'text-brand-red' : 'text-yellow'}`}>{progress.current}/{progress.target}</span></div>
        <DeckValidationPanel validation={deck.validation} t={t} compact />
        <p className="mt-1 text-xs text-text-muted">{deck.inventory_state === 'reserved' ? 'Reserved' : 'Planning'}{deck.shared_missing_copy_count ? ` · Shared missing ${deck.shared_missing_copy_count}` : ''}</p>
        {deck.description && <p className="mt-1 line-clamp-2 text-xs text-text-muted">{deck.description}</p>}
        <p className="mt-2 text-xs text-text-secondary">{progress.status === 'complete' ? t('decks.complete') : progress.status === 'over' ? label('decks.over', { count: progress.over }) : label('decks.remaining', { count: progress.remaining })}{deck.missing_copy_count > 0 && ` · ${label('decks.missingCopies', { count: deck.missing_copy_count })}`}</p>
        <div className="mt-3"><DeckCompositionBar entries={[]} compositionCounts={deck.composition_counts} progress={progress} t={t} label={label} compact /></div>
        {deck.updated_at && <p className="mt-1 text-[11px] text-text-muted">{label('decks.modified', { date: new Date(deck.updated_at).toLocaleDateString() })}</p>}</button>
        <div className="mt-2 flex gap-2"><button className="btn-ghost text-xs" onClick={() => duplicateMutation.mutate(deck.id)} disabled={duplicateMutation.isPending}><Copy size={13} /> Duplicate</button><button className="btn-ghost text-xs" onClick={() => navigate(`/decks/compare?left=${deck.id}&right=${decks.find(item => item.id !== deck.id)?.id}`)}><GitCompare size={13} /> Compare</button></div>
      </div>
    })}</div>}
  </div>
}
