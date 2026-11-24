// Change notifications between tabs: BroadcastChannel with a `storage`-event fallback
// (docs/PWA_OFFLINE_DESIGN.md §6.2.9).

export const CHANNEL_NAME = 'pokecollector-outbox'
export const STORAGE_PING_KEY = 'pc.outbox.ping'

function safeStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function createEvents({
  BroadcastChannelImpl = globalThis.BroadcastChannel,
  storage = safeStorage(),
  eventTarget = globalThis.window,
  channelName = CHANNEL_NAME,
} = {}) {
  const listeners = new Set()
  let channel = null
  let storageHandler = null

  const emitLocal = message => listeners.forEach(cb => {
    try {
      cb(message)
    } catch {
      // a broken listener must not affect the others
    }
  })

  function ensureOpen() {
    if (channel || storageHandler) return
    if (typeof BroadcastChannelImpl === 'function') {
      try {
        channel = new BroadcastChannelImpl(channelName)
        channel.onmessage = event => emitLocal(event.data)
        return
      } catch {
        channel = null
      }
    }
    if (eventTarget?.addEventListener) {
      storageHandler = event => {
        if (event.key !== STORAGE_PING_KEY || !event.newValue) return
        try {
          emitLocal(JSON.parse(event.newValue).message)
        } catch {
          emitLocal({ type: 'changed' })
        }
      }
      eventTarget.addEventListener('storage', storageHandler)
    }
  }

  return {
    /** Tells OTHER tabs something changed (the sender's own tab is notified by its caller). */
    publish(message = { type: 'changed' }) {
      ensureOpen()
      if (channel) {
        try {
          channel.postMessage(message)
        } catch {
          // closed channel
        }
        return
      }
      try {
        storage?.setItem(STORAGE_PING_KEY, JSON.stringify({ message, at: Date.now(), r: Math.random() }))
      } catch {
        // storage unavailable
      }
    },
    /** Messages from other tabs. Returns an unsubscribe function. */
    subscribe(cb) {
      ensureOpen()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    close() {
      listeners.clear()
      if (channel) channel.close()
      channel = null
      if (storageHandler) eventTarget?.removeEventListener?.('storage', storageHandler)
      storageHandler = null
    },
  }
}
