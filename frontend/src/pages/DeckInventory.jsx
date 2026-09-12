import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { getDeckAllocation } from '../api/client'
import InventoryExportMenu from '../components/decks/InventoryExportMenu'

export default function DeckInventory() {
  const navigate = useNavigate()
  const [all, setAll] = useState(false)
  const { data, isLoading } = useQuery({ queryKey: ['deck-allocation', all], queryFn: () => getDeckAllocation({ conflicts_only: !all }).then(r => r.data) })
  return <div className="space-y-4 pb-6"><button className="btn-ghost" onClick={() => navigate('/decks')}><ArrowLeft size={16} /> Back to decks</button><div><h1 className="text-xl font-bold">Shared Deck Inventory</h1><p className="text-sm text-text-secondary">Reserved decks: {data?.summary?.reserved_decks || 0} · Conflicting cards: {data?.summary?.conflicting_cards || 0} · Missing copies: {data?.summary?.missing_copies || 0}</p></div><InventoryExportMenu /><label className="text-sm"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Show all reserved cards</label>{isLoading ? <div className="skeleton h-48 rounded-xl" /> : <div className="space-y-3">{data?.items?.map(item => <article key={item.card_id} className="card"><h2 className="font-semibold">{item.name}</h2><div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4"><span>Owned {item.owned}</span><span>Reserved {item.reserved}</span><span>Free {item.free}</span><span className={item.shortage ? 'text-brand-red' : ''}>Missing {item.shortage}</span></div>{item.decks.map(deck => <p key={deck.deck_id} className="mt-1 text-xs text-text-secondary">{deck.name} ×{deck.quantity}</p>)}</article>)}</div>}</div>
}
