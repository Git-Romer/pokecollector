import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckSquare } from 'lucide-react'
import Modal from './ui/Modal'

export function BulkRemovalToggle({ selection, empty = false }) {
  if (selection.active) return null
  return <button type="button" className="btn-ghost text-sm" disabled={empty || selection.locked} onClick={selection.enter}><CheckSquare size={16} />{selection.label('select')}</button>
}

function RemovalConflictDialog({ selection }) {
  const { conflict, label, busy, error } = selection
  const [confirmRelease, setConfirmRelease] = useState(false)
  const [confirmProduct, setConfirmProduct] = useState(null)
  useEffect(() => { setConfirmRelease(false); setConfirmProduct(null) }, [conflict])
  if (!conflict) return null
  const assignments = conflict.conflicts.flatMap(card => card.assignments)
  const productLinks = conflict.conflicts.flatMap(card => card.products)
  const products = productLinks.length > 0
  const unavailable = (conflict.blockers || []).filter(blocker => blocker.code === 'not_found_or_not_accessible')
  const close = () => { if (!busy) selection.closeConflict() }
  return <Modal isOpen onClose={close} title={label('conflictTitle')} size="lg">
    <div className="space-y-4 p-4">
      <p className="text-sm text-text-secondary">{label(conflict.released ? 'released' : conflict.productsUnlinked && !products && assignments.length === 0 ? 'blockersCleared' : 'conflictHint')}</p>
      {unavailable.length > 0 && <p role="alert" className="text-sm text-yellow">{label('unavailableEntries', { ids: unavailable.map(blocker => blocker.item_id).join(', ') })}</p>}
      {conflict.code === 'collection_assignments_changed' && <p role="alert" className="text-sm text-yellow">{label('assignmentsChanged')}</p>}
      <ul className="space-y-3">
        {conflict.conflicts.map(card => <li key={card.item_id} className="rounded-xl border border-border p-3">
          <p className="font-semibold">{card.name}</p>
          <p className="text-xs text-text-muted">{card.variant} · {card.condition} · {card.lang?.toUpperCase()} · {label('copies', { count: card.quantity })}</p>
          {!conflict.released && <ul className="mt-2 space-y-1 text-sm">{card.assignments.map(assignment => <li key={assignment.assignment_id} className="flex flex-wrap justify-between gap-2">
            <Link className="text-brand-red underline" onClick={close} to={`${assignment.list_type === 'physical_deck' ? '/decks' : '/binders'}/${assignment.list_id}`}>{assignment.list_name}</Link>
            <span>{label('copies', { count: assignment.quantity })}</span>
          </li>)}</ul>}
          {card.products.map(product => <div key={product.product_card_id} className="mt-2 space-y-2 text-sm">
            <p className="text-yellow">{label('productProtected')} <Link className="underline" to="/products" onClick={close}>{product.product_name}</Link> · {label('copies', { count: product.active_quantity })}</p>
            {confirmProduct === product.product_card_id ? <>
              <p className="rounded-lg bg-brand-red/10 p-3">{label('unlinkConfirm', { copies: product.active_quantity, card: card.name, product: product.product_name })}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={() => setConfirmProduct(null)}>{label('cancelUnlink')}</button>
                <button type="button" className="btn-danger text-sm" disabled={busy} onClick={() => selection.unlinkProduct(card.item_id, product)}>{label('confirmUnlink')}</button>
              </div>
            </> : <button type="button" className="btn-ghost text-sm" disabled={busy} onClick={() => { setConfirmRelease(false); setConfirmProduct(product.product_card_id) }}>{label('unlinkProduct')}</button>}
          </div>)}
        </li>)}
      </ul>
      {products && <p className="text-sm text-text-secondary">{label('productHint')}</p>}
      {confirmRelease && !conflict.released && <p className="rounded-lg bg-brand-red/10 p-3 text-sm">{label('releaseConfirm', { entries: assignments.length, copies: assignments.reduce((sum, row) => sum + row.quantity, 0) })}</p>}
      {confirmProduct === 'all' && <div className="space-y-2 rounded-lg bg-brand-red/10 p-3 text-sm">
        <p>{label('unlinkAllConfirm', { entries: productLinks.length, copies: productLinks.reduce((sum, product) => sum + product.active_quantity, 0) })}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirmProduct(null)}>{label('cancelUnlink')}</button>
          <button type="button" className="btn-danger" disabled={busy} onClick={selection.unlinkProducts}>{label('confirmUnlinkProducts')}</button>
        </div>
      </div>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        <button type="button" className="btn-ghost" disabled={busy} onClick={close}>{label('close')}</button>
        {products && <button type="button" className="btn-danger" disabled={busy} onClick={() => { setConfirmRelease(false); setConfirmProduct('all') }}>{label('unlinkProducts')}</button>}
        {!conflict.released && assignments.length > 0 && <button type="button" className="btn-danger" disabled={busy} onClick={() => confirmRelease ? selection.releaseAssignments() : setConfirmRelease(true)}>{label(confirmRelease ? 'confirmRelease' : 'releaseAssignments')}</button>}
        {(conflict.released || assignments.length === 0) && <button type="button" className="btn-danger" disabled={busy || products || unavailable.length > 0} onClick={selection.retryRemoval}>{label('retryRemoval')}</button>}
      </div>
    </div>
  </Modal>
}

export function BulkRemovalActions({ selection, empty = false, children }) {
  const { active, locked, label } = selection
  if (!active) return children
  return <div className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-3 right-3 z-40 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-surface/95 p-3 shadow-xl backdrop-blur lg:static lg:ml-auto lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none" role="region" aria-label={label('actions')}>
    <span className="mr-auto text-sm font-medium" aria-live="polite">{label('selected', { entries: selection.count, copies: selection.copies })}</span>
    <button type="button" className="btn-ghost text-sm" disabled={locked || empty} onClick={selection.selectVisible}>{label('selectVisible')}</button>
    <button type="button" className="btn-ghost text-sm" disabled={locked} onClick={selection.cancel}>{label('cancelSelection')}</button>
    <button type="button" className="btn-danger text-sm" disabled={locked || !selection.count} onClick={selection.submit}>{label('removeSelected')}</button>
  </div>
}

export default function BulkRemovalToolbar({ selection }) {
  return <>
    {selection.error && !selection.conflict && <p className="text-sm text-red-400" role="alert">{selection.error}</p>}
    <RemovalConflictDialog selection={selection} />
  </>
}
