import { useEffect, useRef, useState } from 'react'
import { addDeckEntry, updateDeckEntry } from '../api/client'

const DEBOUNCE_MS = 150

function debug(event, details) {
  if (import.meta.env.DEV) console.debug('[deck quantity sync]', event, details)
}

export function useDeckQuantitySync({ deckId, queryClient, onError }) {
  const [optimisticQuantities, setOptimisticQuantities] = useState({})
  const [pendingEntryIds, setPendingEntryIds] = useState(new Set())
  const desired = useRef(new Map())
  const timers = useRef(new Map())
  const inFlight = useRef(new Set())
  const sequences = useRef(new Map())
  const desiredAdds = useRef(new Map())
  const addTimers = useRef(new Map())
  const addInFlight = useRef(new Set())
  const addSequences = useRef(new Map())
  const [optimisticAddQuantities, setOptimisticAddQuantities] = useState({})
  const [pendingCardIds, setPendingCardIds] = useState(new Set())

  useEffect(() => () => {
    timers.current.forEach(timer => clearTimeout(timer))
    addTimers.current.forEach(timer => clearTimeout(timer))
  }, [])

  const setOptimistic = (entryId, quantity) => setOptimisticQuantities(current => ({ ...current, [entryId]: quantity }))
  const clearOptimistic = entryId => setOptimisticQuantities(current => {
    const next = { ...current }
    delete next[entryId]
    return next
  })
  const setPending = (entryId, pending) => setPendingEntryIds(current => {
    const next = new Set(current)
    if (pending) next.add(entryId)
    else next.delete(entryId)
    return next
  })
  const setPendingCard = (cardId, pending) => setPendingCardIds(current => {
    const next = new Set(current)
    if (pending) next.add(cardId)
    else next.delete(cardId)
    return next
  })
  const setOptimisticAdd = (cardId, quantity) => setOptimisticAddQuantities(current => ({ ...current, [cardId]: quantity }))
  const clearOptimisticAdd = cardId => setOptimisticAddQuantities(current => {
    const next = { ...current }
    delete next[cardId]
    return next
  })

  const schedule = (entryId, delay = DEBOUNCE_MS) => {
    clearTimeout(timers.current.get(entryId))
    timers.current.set(entryId, setTimeout(() => synchronize(entryId), delay))
  }

  const synchronize = async entryId => {
    if (inFlight.current.has(entryId)) return
    const quantity = desired.current.get(entryId)
    if (quantity === undefined) return

    inFlight.current.add(entryId)
    setPending(entryId, true)
    const sequence = (sequences.current.get(entryId) || 0) + 1
    sequences.current.set(entryId, sequence)
    debug('request start', { entryId, quantity, sequence })

    try {
      const response = await updateDeckEntry(deckId, entryId, { required_quantity: quantity })
      const serverEntry = response.data.entries?.find(entry => entry.id === entryId)
      const serverQuantity = serverEntry?.required_quantity
      const latestDesired = desired.current.get(entryId)
      const cachedQuantity = queryClient.getQueryData(['deck', String(deckId)])?.entries?.find(entry => entry.id === entryId)?.required_quantity
      debug('request complete', { entryId, quantity, sequence, status: response.status, serverQuantity, cachedQuantity, latestDesired })

      if (latestDesired === quantity) {
        desired.current.delete(entryId)
        clearOptimistic(entryId)
        queryClient.setQueryData(['deck', String(deckId)], response.data)
        queryClient.invalidateQueries({ queryKey: ['decks'] })
      } else {
        debug('stale response ignored', { entryId, sequence, latestDesired })
      }
    } catch (error) {
      const latestDesired = desired.current.get(entryId)
      debug('request failed', { entryId, quantity, sequence, status: error.response?.status, latestDesired })
      if (latestDesired === quantity) {
        desired.current.delete(entryId)
        clearOptimistic(entryId)
        debug('refetch start', { entryId, sequence })
        queryClient.invalidateQueries({ queryKey: ['deck', String(deckId)] })
        queryClient.invalidateQueries({ queryKey: ['decks'] })
        debug('refetch requested', { entryId, sequence })
        onError(error)
      }
    } finally {
      inFlight.current.delete(entryId)
      setPending(entryId, false)
      if (desired.current.has(entryId)) schedule(entryId, 0)
    }
  }

  const scheduleAdd = (cardId, delay = DEBOUNCE_MS) => {
    clearTimeout(addTimers.current.get(cardId))
    addTimers.current.set(cardId, setTimeout(() => synchronizeAdd(cardId), delay))
  }

  const synchronizeAdd = async cardId => {
    if (addInFlight.current.has(cardId)) return
    const quantity = desiredAdds.current.get(cardId)
    if (!quantity) return

    addInFlight.current.add(cardId)
    setPendingCard(cardId, true)
    const sequence = (addSequences.current.get(cardId) || 0) + 1
    addSequences.current.set(cardId, sequence)
    debug('add request start', { deckId, cardId, quantity, sequence, method: 'POST', endpoint: `/decks/${deckId}/entries` })

    try {
      const response = await addDeckEntry(deckId, { card_id: cardId, required_quantity: quantity })
      const serverEntry = response.data.entries?.find(entry => entry.card_id === cardId)
      const latestDesired = desiredAdds.current.get(cardId)
      debug('add request complete', { deckId, cardId, quantity, sequence, status: response.status, serverQuantity: serverEntry?.required_quantity, latestDesired })

      if (Array.isArray(response.data?.entries)) {
        queryClient.setQueryData(['deck', String(deckId)], response.data)
        queryClient.invalidateQueries({ queryKey: ['decks'] })
      } else {
        queryClient.invalidateQueries({ queryKey: ['deck', String(deckId)] })
        queryClient.invalidateQueries({ queryKey: ['decks'] })
      }
      desiredAdds.current.delete(cardId)
      clearOptimisticAdd(cardId)
      if (latestDesired > quantity && serverEntry) changeQuantity(serverEntry.id, serverEntry.required_quantity, latestDesired - quantity)
    } catch (error) {
      const latestDesired = desiredAdds.current.get(cardId)
      debug('add request failed', { deckId, cardId, quantity, sequence, status: error.response?.status, response: error.response?.data, latestDesired })
      if (latestDesired === quantity) {
        desiredAdds.current.delete(cardId)
        clearOptimisticAdd(cardId)
        queryClient.invalidateQueries({ queryKey: ['deck', String(deckId)] })
        queryClient.invalidateQueries({ queryKey: ['decks'] })
        onError(error)
      }
    } finally {
      addInFlight.current.delete(cardId)
      setPendingCard(cardId, false)
      if (desiredAdds.current.has(cardId)) scheduleAdd(cardId, 0)
    }
  }

  const changeQuantity = (entryId, renderedQuantity, delta) => {
    const current = desired.current.get(entryId) ?? renderedQuantity
    const quantity = Math.max(1, current + delta)
    if (quantity === current) return
    desired.current.set(entryId, quantity)
    setOptimistic(entryId, quantity)
    debug('quantity requested', { entryId, quantity, delta, sequence: sequences.current.get(entryId) || 0 })
    schedule(entryId)
  }

  const addCard = (cardId, existingEntry) => {
    if (existingEntry) {
      changeQuantity(existingEntry.id, existingEntry.required_quantity, 1)
      return
    }
    const quantity = (desiredAdds.current.get(cardId) || 0) + 1
    desiredAdds.current.set(cardId, quantity)
    setOptimisticAdd(cardId, quantity)
    debug('add requested', { deckId, cardId, quantity, sequence: addSequences.current.get(cardId) || 0 })
    scheduleAdd(cardId)
  }

  return { optimisticQuantities, pendingEntryIds, changeQuantity, addCard, optimisticAddQuantities, pendingCardIds }
}
