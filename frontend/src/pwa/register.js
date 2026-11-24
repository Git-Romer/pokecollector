// Service-worker registration, update flow and kill switch, page side
// (docs/PWA_OFFLINE_DESIGN.md §6.3.4).
import { FOREGROUND_UPDATE_CHECK_MS } from '../offline/constants'

const CHECKED_AT_KEY = 'pc.swCheckedAt'
// A new document must be able to apply its next update. Session storage outlives it.
let reloadScheduled = false
const PRELOAD_RELOAD_KEY = 'pc.preloadReloaded'
const RESET_DOCUMENT_KEY = 'pc.resetDocument'

// Update guards: other features register a function that returns true while a reload
// would lose work (staged scanner photos, an outbox item being sent).
const guards = new Set()

export function addUpdateGuard(guard) {
  guards.add(guard)
  return () => guards.delete(guard)
}

export function isUpdateBlocked() {
  for (const guard of guards) {
    try {
      if (guard()) return true
    } catch {
      // A broken guard must not block updates forever.
    }
  }
  return false
}

function session() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

// Keep the URL escape hatch off for its redirected document too. Otherwise the
// default-on downloader immediately recreates caches that the escape hatch removed.
// A later manual reload has a different timeOrigin and enables normal operation.
export function isOfflineResetting() {
  if (typeof window === 'undefined') return false
  if (new URL(window.location.href).searchParams.get('pc_sw') === 'off') return true
  try {
    const store = session()
    const marker = store?.getItem(RESET_DOCUMENT_KEY)
    const documentId = String(window.performance.timeOrigin)
    if (marker === 'next') {
      store.setItem(RESET_DOCUMENT_KEY, documentId)
      return true
    }
    if (marker === documentId) return true
    if (marker) store.removeItem(RESET_DOCUMENT_KEY)
  } catch { /* Session storage may be unavailable. */ }
  return false
}

// Unregisters every service worker and deletes the pc-* caches. Never touches IndexedDB.
export async function resetServiceWorker() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map(registration => registration.unregister()))
  } catch {
    // ignore
  }
  try {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name.startsWith('pc-')).map(name => caches.delete(name)))
  } catch {
    // ignore
  }
}

export function stripResetParam(href) {
  const url = new URL(href)
  url.searchParams.delete('pc_sw')
  return url.pathname + url.search + url.hash
}

// Asks the waiting worker to take over, then reloads once on controllerchange.
// Returns { applied: false, blocked: true } while a guard refuses.
export function applyUpdate(registration) {
  if (isUpdateBlocked()) return { applied: false, blocked: true }
  const waiting = registration?.waiting
  if (!waiting) return { applied: false, blocked: false }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadScheduled) return
    reloadScheduled = true
    window.location.reload()
  }, { once: true })
  waiting.postMessage({ type: 'SKIP_WAITING' })
  return { applied: true, blocked: false }
}

function watchForUpdate(registration, onUpdateReady) {
  const notify = () => onUpdateReady(registration)
  if (registration.waiting && navigator.serviceWorker.controller) notify()
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing
    if (!worker) return
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) notify()
    })
  })
}

function scheduleForegroundChecks(registration) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const store = session()
    let last = 0
    try {
      last = Number(store?.getItem(CHECKED_AT_KEY)) || 0
    } catch {
      // ignore
    }
    if (Date.now() - last < FOREGROUND_UPDATE_CHECK_MS) return
    try {
      store?.setItem(CHECKED_AT_KEY, String(Date.now()))
    } catch {
      // ignore
    }
    registration.update().catch(() => {})
  })
}

function whenIdle(callback) {
  const run = () => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(callback, { timeout: 3000 })
    else setTimeout(callback, 1000)
  }
  if (document.readyState === 'complete') run()
  else window.addEventListener('load', run, { once: true })
}

export async function initServiceWorker({ flags, onUpdateReady }) {
  if (!('serviceWorker' in navigator)) return

  const url = new URL(window.location.href)
  if (url.searchParams.get('pc_sw') === 'off') {
    try { session()?.setItem(RESET_DOCUMENT_KEY, 'next') } catch { /* best effort */ }
    await resetServiceWorker()
    window.location.replace(stripResetParam(window.location.href))
    return
  }

  if (!flags?.sw || isOfflineResetting()) {
    await resetServiceWorker()
    return
  }

  if (!window.isSecureContext || !import.meta.env.PROD) return

  whenIdle(async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      watchForUpdate(registration, onUpdateReady)
      scheduleForegroundChecks(registration)
    } catch {
      // Registration can fail on unsupported setups (Lockdown Mode, private windows); the app works without it.
    }
  })
}

// A dynamic import failing after a deploy means the page runs old code against new files.
export function handlePreloadError(event, { onUpdateReady, registration } = {}) {
  event?.preventDefault?.()
  if (onUpdateReady && registration) {
    onUpdateReady(registration)
    return
  }
  const store = session()
  try {
    if (store?.getItem(PRELOAD_RELOAD_KEY)) return
    store?.setItem(PRELOAD_RELOAD_KEY, '1')
  } catch {
    // ignore
  }
  window.location.reload()
}
