import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { getApiErrorMessage, releaseCollectionAssignments, unlinkProductCard, bulkUnlinkProductCards } from '../api/client'
import { invalidateCardState, invalidateCollectionPhotoState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'

export const removalEntryId = item => item.binder_card_id ?? item.id
const copiesFor = (item, kind) => Number(kind === 'collection' ? item.quantity : item.required_quantity ?? item.quantity ?? 1)
const signature = (items, kind) => items.map(item => `${removalEntryId(item)}:${copiesFor(item, kind)}`).sort().join('|')

/** Selection and confirmation shared by three separate, explicitly scoped views. */
export function useBulkRemoval({ items, kind, scopeKey, remove, t, blocked = false }) {
  const confirm = useConfirmDialog()
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState({ scopeKey, active: false, ids: new Set() })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const latest = useRef(null)
  latest.current = { scopeKey, items, blocked }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const visibleKey = items.map(removalEntryId).join(',')
  useEffect(() => {
    setSelection(previous => {
      if (previous.scopeKey !== scopeKey) return { scopeKey, active: false, ids: new Set() }
      const visible = new Set(latest.current.items.map(removalEntryId))
      const ids = new Set([...previous.ids].filter(id => visible.has(id)))
      return ids.size === previous.ids.size ? previous : { ...previous, ids }
    })
    setError(''); setConflict(null)
  }, [scopeKey, visibleKey])
  const active = selection.scopeKey === scopeKey && selection.active
  const selected = active ? items.filter(item => selection.ids.has(removalEntryId(item))) : []
  const selectedIds = new Set(selected.map(removalEntryId))
  const label = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t(`bulkRemoval.${key}`))
  const locked = busy || blocked
  const cancel = () => {
    if (pending.current || blocked) return
    setSelection({ scopeKey, active: false, ids: new Set() }); setError(''); setConflict(null)
  }
  const toggle = item => {
    if (pending.current || blocked) return
    const id = removalEntryId(item)
    if (!selectedIds.has(id) && selectedIds.size >= 500) { setError(label('limit')); return }
    setSelection(previous => {
      const ids = new Set(previous.ids)
      if (ids.has(id)) ids.delete(id)
      else if (ids.size < 500) ids.add(id)
      return { scopeKey, active: true, ids }
    })
  }
  const selectVisible = () => {
    if (pending.current || blocked) return
    if (items.length > 500) { setError(label('limit')); return }
    setSelection({ scopeKey, active: true, ids: new Set(items.map(removalEntryId)) })
  }
  const submit = async () => {
    if (pending.current || blocked || !selected.length) return
    pending.current = true; setBusy(true); setError('')
    const snapshot = signature(selected, kind)
    const ids = [...selectedIds].sort((a, b) => a - b)
    try {
      const approved = await confirm({
        title: label(`title${kind[0].toUpperCase()}${kind.slice(1)}`),
        message: label(`confirm${kind[0].toUpperCase()}${kind.slice(1)}`, {
          entries: selected.length, copies: selected.reduce((sum, item) => sum + copiesFor(item, kind), 0),
        }),
        confirmLabel: label('removeSelected'), destructive: true,
      })
      if (!approved || !mounted.current || latest.current.scopeKey !== scopeKey) return
      const current = latest.current.items.filter(item => selectedIds.has(removalEntryId(item)))
      if (latest.current.blocked || signature(current, kind) !== snapshot) { setError(label('changed')); return }
      await remove(ids)
      if (kind === 'collection') invalidateCollectionPhotoState(queryClient)
      else invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      const affected = new Set(['binders', 'binder-cards', 'binder-entry-equivalents', 'binder-print-optimization', 'decks', 'deck', 'deck-allocation', 'deck-picker-collection', 'duplicates'])
      queryClient.invalidateQueries({ predicate: query => affected.has(query.queryKey[0]) })
      if (mounted.current) setSelection(previous => previous.scopeKey === scopeKey ? { scopeKey, active: false, ids: new Set() } : previous)
    } catch (reason) {
      if (mounted.current && latest.current.scopeKey === scopeKey) {
        const detail = reason.response?.data?.detail
        if (kind === 'collection' && Array.isArray(detail?.conflicts)) setConflict({ ...detail, itemIds: ids, released: false })
        else setError(getApiErrorMessage(reason, label('failed')))
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const releaseAssignments = async () => {
    if (pending.current || blocked || !conflict || conflict.released) return
    const captured = conflict
    const assignments = captured.conflicts.flatMap(card => card.assignments).map(({ assignment_id, list_id, item_id, quantity }) => ({ assignment_id, list_id, item_id, quantity }))
    if (!assignments.length) return
    pending.current = true; setBusy(true); setError('')
    try {
      await releaseCollectionAssignments(captured.resolutions?.find(resolution => resolution.path === '/api/collection/release-assignments')?.body || { item_ids: captured.itemIds, assignments })
      invalidateCardState(queryClient)
      queryClient.invalidateQueries({ predicate: query => ['binders', 'binder-cards', 'decks', 'deck', 'deck-allocation', 'deck-picker-collection', 'binder-entry-equivalents', 'binder-print-optimization'].includes(query.queryKey[0]) })
      if (mounted.current && latest.current.scopeKey === scopeKey) setConflict(previous => previous === captured ? { ...captured, released: true } : previous)
    } catch (reason) {
      if (mounted.current && latest.current.scopeKey === scopeKey) {
        const detail = reason.response?.data?.detail
        if (Array.isArray(detail?.conflicts)) setConflict({ ...detail, itemIds: captured.itemIds, released: false })
        setError(getApiErrorMessage(reason, label('failed')))
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const unlinkProductLinks = async (links, single = false) => {
    if (pending.current || blocked || !conflict || !links.length) return
    const captured = conflict
    if (links.some(link => !captured.itemIds.includes(link.collection_item_id))) return
    pending.current = true; setBusy(true); setError('')
    try {
      if (single) {
        const link = links[0]
        await unlinkProductCard(link.product_id, link.product_card_id, {
          expected_collection_item_id: link.collection_item_id, expected_active_quantity: link.active_quantity,
        })
      } else await bulkUnlinkProductCards({ links })
      invalidateCardState(queryClient)
      queryClient.invalidateQueries({ predicate: query => ['products', 'products-summary', 'dashboard'].includes(query.queryKey[0]) })
      const removed = new Set(links.map(link => link.product_card_id))
      if (mounted.current && latest.current.scopeKey === scopeKey) setConflict(previous => previous === captured ? {
        ...captured, productsUnlinked: true,
        conflicts: captured.conflicts.map(card => ({
          ...card, products: card.products.filter(source => !removed.has(source.product_card_id)),
        })),
      } : previous)
    } catch (reason) {
      if (mounted.current && latest.current.scopeKey === scopeKey) setError(getApiErrorMessage(reason, label('failed')))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const unlinkProduct = (itemId, product) => unlinkProductLinks([{
    product_id: product.product_id, product_card_id: product.product_card_id,
    collection_item_id: itemId, active_quantity: product.active_quantity,
  }], true)
  const unlinkProducts = () => unlinkProductLinks(conflict.conflicts.flatMap(card => card.products.map(product => ({
    product_id: product.product_id, product_card_id: product.product_card_id,
    collection_item_id: card.item_id, active_quantity: product.active_quantity,
  }))))
  const closeConflict = () => { if (!pending.current) { setConflict(null); setError('') } }
  const retryRemoval = () => { if (!pending.current) { setConflict(null); submit() } }
  return { active, selectedIds, locked, busy, error, conflict, closeConflict, releaseAssignments, unlinkProduct, unlinkProducts, retryRemoval, toggle, cancel, selectVisible, submit, label,
    count: selected.length, copies: selected.reduce((sum, item) => sum + copiesFor(item, kind), 0),
    enter: () => { if (!pending.current && !blocked) { setSelection({ scopeKey, active: true, ids: new Set() }); setError('') } },
  }
}
