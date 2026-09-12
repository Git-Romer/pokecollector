import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { compareDecks, getDecks } from '../api/client'

const pct = value => `${(Number(value || 0) * 100).toFixed(1)}%`
const delta = value => `${value > 0 ? '+' : ''}${value}`

export default function DeckCompare() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [showUnchanged, setShowUnchanged] = useState(false)
  const [keyCard, setKeyCard] = useState('')
  const leftId = params.get('left')
  const rightId = params.get('right')
  const { data: decks = [] } = useQuery({ queryKey: ['decks'], queryFn: () => getDecks().then(r => r.data) })
  const { data, isLoading } = useQuery({ queryKey: ['deck-compare', leftId, rightId, keyCard], enabled: Boolean(leftId && rightId && leftId !== rightId), queryFn: () => compareDecks({ left_id: leftId, right_id: rightId, card_name: keyCard || undefined }).then(r => r.data) })
  const choose = (side, value) => setParams(current => { current.set(side, value); return current })
  const deck = data?.decks
  const cards = (data?.cards?.changes || []).filter(card => showUnchanged || card.status !== 'unchanged')
  const cardNames = (data?.cards?.changes || []).map(card => card.name)
  return <div className="space-y-5 pb-6">
    <button className="btn-ghost" onClick={() => navigate('/decks')}><ArrowLeft size={16} /> Back to decks</button>
    <div className="card grid gap-3 md:grid-cols-2"><label className="text-sm">Deck A<select aria-label="Deck A" className="select mt-1 w-full" value={leftId || ''} onChange={e => choose('left', e.target.value)}>{decks.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label><label className="text-sm">Deck B<select aria-label="Deck B" className="select mt-1 w-full" value={rightId || ''} onChange={e => choose('right', e.target.value)}>{decks.map(deck => <option key={deck.id} value={deck.id}>{deck.name}</option>)}</select></label></div>
    {isLoading ? <div className="skeleton h-80 rounded-xl" /> : !deck ? <p className="text-text-secondary">Choose two different decks to compare.</p> : <>
      <header className="grid gap-3 md:grid-cols-2">{['left', 'right'].map(side => <div key={side} className="card"><p className="text-xs text-text-muted">Deck {side === 'left' ? 'A' : 'B'}</p><h1 className="text-xl font-bold">{deck[side].name}</h1><p className="text-sm text-text-secondary">{deck[side].current_card_count} / {deck[side].target_size} · {deck[side].format}</p><p className={deck[side].validation?.valid ? 'text-green' : 'text-brand-red'}>{deck[side].validation?.valid ? 'Valid' : `${deck[side].validation?.errors?.length || 0} errors`}</p></div>)}</header>
      <section className="card"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Card Changes</h2><label className="text-xs"><input type="checkbox" checked={showUnchanged} onChange={e => setShowUnchanged(e.target.checked)} /> Show unchanged</label></div><div className="mt-3 space-y-2">{cards.map(card => <div key={card.name} className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${card.status === 'added' ? 'bg-green/10 text-green' : card.status === 'removed' ? 'bg-brand-red/10 text-brand-red' : 'bg-bg-primary'}`}><span>{card.name}</span><span>{card.left} → {card.right} ({delta(card.delta)})</span></div>)}</div></section>
      <section className="card"><h2 className="font-semibold">Composition</h2><div className="mt-2 grid grid-cols-4 gap-2 text-center text-sm"><b>Type</b><b>A</b><b>B</b><b>Delta</b>{(data.composition || []).map(row => <div key={row.metric} className="contents"><span>{row.metric}</span><span>{row.left}</span><span>{row.right}</span><span>{delta(row.delta)}</span></div>)}</div></section>
      <section className="card"><h2 className="font-semibold">Ownership & Validation</h2><p className="mt-2 text-sm">Missing copies: {data.ownership.left} → {data.ownership.right} ({delta(data.ownership.delta)})</p>{data.validation.changes.map(change => <p key={change.code} className="text-sm">{change.code}: {change.left?.status || 'n/a'} → {change.right?.status || 'n/a'}</p>)}</section>
      <section className="card"><h2 className="font-semibold">Effects / Consistency</h2>{data.effects.changes.map(row => <p key={row.metric} className="text-sm">{row.metric}: {row.left} → {row.right} ({delta(row.delta)})</p>)}</section>
      <section className="card"><h2 className="font-semibold">Probability</h2><p className="text-sm">Basic Pokemon opening 7: {pct(data.probability.left?.basic_pokemon?.at_least_one)} → {pct(data.probability.right?.basic_pokemon?.at_least_one)} ({((data.probability.right?.basic_pokemon?.at_least_one - data.probability.left?.basic_pokemon?.at_least_one) * 100).toFixed(1)} pp)</p><label className="mt-3 block text-sm">Key card<select aria-label="Key card" className="select mt-1 w-full" value={keyCard} onChange={e => setKeyCard(e.target.value)}><option value="">None</option>{cardNames.map(name => <option key={name}>{name}</option>)}</select></label>{keyCard && <p className="mt-2 text-sm">Copies: {data.probability.left?.key_card?.copies || 0} → {data.probability.right?.key_card?.copies || 0}; Opening 7: {pct(data.probability.left?.key_card?.opening_probability)} → {pct(data.probability.right?.key_card?.opening_probability)}</p>}</section>
    </>}
  </div>
}
