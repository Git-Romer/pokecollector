import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import EvictedNotice from '../components/sync/EvictedNotice'
import LogoutGuardDialog from '../components/sync/LogoutGuardDialog'
import { SavedAtContext } from '../components/sync/StaleDataLabel'
import { readPwaFlags } from '../pwa/flags'
import { getCapabilities } from './capabilities'
import { REPLAY_TICK_MS } from './constants'
import { applyDebugParams } from './debug'
import { checkCanary, initCanary, requestPersistence } from './durability'
import { openOutboxDb } from './outbox/db.js'
import { createOutbox } from './outbox/index.js'
import { persist, purge, purgeOthers, restore } from './readCache'
import { createSyncReporter } from './syncToasts'
import { OutboxContext } from './useOutbox'
import AutomaticCollectionProvider from './AutomaticCollectionProvider'

const ignore = () => {}
const RESTORE_WAIT_MS = 1500

/**
 * The logout guard's decision loop (D7, A6). `ask()` resolves with 'sync' | 'keep' | 'discard' |
 * 'cancel'; `setBusy(true)` shows the progress label while a sync runs; `close()` hides the dialog.
 * Resolves true when logging out may proceed. `clearCache()` (the read cache, P8) runs on every
 * path that proceeds, including "nothing unsynced", and never blocks the logout.
 */
export async function runLogoutGuard({ outbox, ask, setBusy, close, clearCache = ignore }) {
  const proceed = await decideLogout({ outbox, ask, setBusy, close })
  if (proceed) {
    try {
      await clearCache()
    } catch {
      // best effort: a failed purge must not trap the user in the app
    }
  }
  return proceed
}

async function decideLogout({ outbox, ask, setBusy, close }) {
  try {
    await outbox.start()
  } catch {
    return true
  }
  for (;;) {
    if (outbox.getSnapshot().items.length === 0) {
      close()
      return true
    }
    const choice = await ask()
    if (choice === 'cancel') {
      close()
      return false
    }
    if (choice === 'keep') {
      close()
      return true
    }
    if (choice === 'discard') {
      try {
        await outbox.discardAllForUser()
      } catch {
        close()
        return false
      }
      close()
      return true
    }
    // 'sync': keep the dialog open with a progress label, then look again. The user asked for
    // it, so it runs as `manual` and also works when Automatic sync is switched off.
    setBusy(true)
    try {
      await outbox.syncNow('manual')
    } catch {
      // items stay; the dialog comes back
    }
  }
}

/**
 * Owns the outbox (docs/PWA_OFFLINE_DESIGN.md §6.2.12, P5). Inert unless the queue flag is on
 * and IndexedDB exists: then children render untouched and no logout guard is registered.
 */
export function OfflineProvider({ children }) {
  const { user, status, setLogoutGuard } = useAuth()
  const queryClient = useQueryClient()
  const { t, settings, loaded: settingsLoaded } = useSettings()
  const collectionEnabled = settings.offline_collection_enabled === 'true'
  const tRef = useRef(t)
  tRef.current = t
  const enabled = useMemo(() => readPwaFlags().queue && getCapabilities().indexedDB, [])
  const [outbox, setOutbox] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [evicted, setEvicted] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [restoreDone, setRestoreDone] = useState(false)
  const resolveRef = useRef(null)
  const persisterRef = useRef(null)
  const automaticRef = useRef(null)
  const stoppedWriterRef = useRef(Promise.resolve())
  const restoreStartedRef = useRef(false)
  const userIdRef = useRef(null)
  userIdRef.current = typeof user?.id === 'number' ? user.id : null

  const userId = userIdRef.current
  const active = (status === 'ready' || status === 'degraded') && userId !== null

  useEffect(() => {
    if (enabled) applyDebugParams()
  }, [enabled])

  useEffect(() => {
    if (!enabled) return undefined
    const instance = createOutbox({
      ctx: () => (userIdRef.current === null ? null : { userId: userIdRef.current, origin: window.location.origin }),
      flags: { queue: true },
      queryClient,
      onlineManager,
    })
    // Every replay result, whoever started it (ticks, the sheet, the logout guard), feeds the toasts.
    const report = createSyncReporter({ toast, getT: () => tRef.current })
    const rawSyncNow = instance.syncNow
    instance.syncNow = async (...args) => {
      const result = await rawSyncNow(...args)
      report(result)
      return result
    }
    setOutbox(instance)
    return () => {
      instance.stop()
      setOutbox(null)
    }
  }, [enabled, queryClient])

  // Start once a user is known; sync when the signed-in user changes (A4).
  useEffect(() => {
    if (!outbox || !active) return
    outbox.start().then(() => {
      // The startup auth check gave up: no need to wait for two probes to show the banner.
      if (status === 'degraded') outbox.noteUnreachable()
      return outbox.syncNow('login')
    }).catch(ignore)
  }, [outbox, active, userId, status])

  // Read cache (P8): other users' saved data goes as soon as the signed-in user is known.
  useEffect(() => {
    if (enabled && userId !== null) purgeOthers({ origin: window.location.origin, keepUserId: userId }).catch(ignore)
  }, [enabled, userId])

  // A degraded start puts the saved data back before protected routes mount (or after 1.5 s).
  useEffect(() => {
    if (!enabled || !settingsLoaded || !collectionEnabled || status !== 'degraded' || userId === null || restoreStartedRef.current) return
    restoreStartedRef.current = true
    const timer = window.setTimeout(() => setRestoreDone(true), RESTORE_WAIT_MS)
    restore(queryClient, { origin: window.location.origin, userId })
      .then(saved => { if (saved) setSavedAt(saved) })
      .catch(ignore)
      .finally(() => {
        window.clearTimeout(timer)
        setRestoreDone(true)
      })
  }, [enabled, settingsLoaded, collectionEnabled, status, userId, queryClient])

  // The server answered again: the pages hold fresh data, so the "saved data" label goes.
  useEffect(() => {
    if (status !== 'ready') return
    setSavedAt(null)
    setRestoreDone(true) // a session that started online never waits for a restore
  }, [status])

  // Saves allow-listed query results while a user is signed in. It starts after a degraded
  // start's restore so a half-empty cache never replaces the saved record.
  const persistReady = status === 'ready' || restoreDone
  useEffect(() => {
    if (!enabled || !settingsLoaded || !collectionEnabled || !active || !persistReady) return undefined
    const persister = persist(queryClient, { origin: window.location.origin, userId })
    persisterRef.current = persister
    return () => {
      stoppedWriterRef.current = persister.stop()
      if (persisterRef.current === persister) persisterRef.current = null
    }
  }, [enabled, settingsLoaded, collectionEnabled, active, persistReady, userId, queryClient])

  const clearOfflineMetadata = useCallback(async ownerId => {
    if (userIdRef.current === ownerId) await persisterRef.current?.stop()
    await stoppedWriterRef.current
    if (await purge({ origin: window.location.origin, userId: ownerId, strict: true }) !== true) throw new Error('cleanup_failed')
  }, [])
  const registerAutomatic = useCallback(controller => { automaticRef.current = controller }, [])

  // Storage protection (D12): persist() after the first enqueue and on every start while items
  // wait, and notice when the browser removed the database behind our back.
  useEffect(() => {
    if (!outbox || !active) return undefined
    let cancelled = false
    let requested = false
    const protect = async () => {
      if (requested || outbox.getSnapshot().items.length === 0) return
      requested = true
      let db = null
      try {
        db = await openOutboxDb()
        await requestPersistence({ db })
      } catch {
        // best effort
      } finally {
        db?.close()
      }
    }
    const checkEviction = async () => {
      let db = null
      try {
        await outbox.start()
        db = await openOutboxDb()
        const result = await checkCanary(db)
        if (result === 'evicted' && !cancelled) setEvicted(true)
        if (result !== 'ok') await initCanary(db)
      } catch {
        // the canary is advisory
      } finally {
        db?.close()
      }
      if (!cancelled) protect()
    }
    checkEviction()
    const unsubscribe = outbox.subscribe(() => { if (!cancelled) protect() })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [outbox, active])

  useEffect(() => {
    if (!outbox || !active) return undefined
    const sync = () => {
      if (document.visibilityState === 'visible') outbox.syncNow('auto').catch(ignore)
    }
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('online', sync)
    window.addEventListener('pageshow', sync)
    const timer = window.setInterval(sync, REPLAY_TICK_MS)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('online', sync)
      window.removeEventListener('pageshow', sync)
      window.clearInterval(timer)
    }
  }, [outbox, active])

  // Logout guard (D7, A6): the dialog decides what happens to unsynced items.
  useEffect(() => {
    if (!outbox) return undefined
    const ask = () => new Promise(resolve => {
      resolveRef.current = resolve
      setDialog({ busy: false })
    })
    const close = () => {
      resolveRef.current = null
      setDialog(null)
    }
    // Stop the writer first so a pending save cannot bring the data back after the purge.
    const clearCache = async () => {
      if (userIdRef.current === null) return
      await automaticRef.current?.stop()
      await persisterRef.current?.stop()
      await stoppedWriterRef.current
      await purge({ origin: window.location.origin, userId: userIdRef.current })
    }
    const guard = () => runLogoutGuard({ outbox, ask, setBusy: busy => setDialog({ busy }), close, clearCache })
    setLogoutGuard(guard)
    return () => {
      setLogoutGuard(null)
      resolveRef.current?.('cancel')
      resolveRef.current = null
      setDialog(null)
    }
  }, [outbox, setLogoutGuard])

  if (!enabled) return children

  const choose = choice => resolveRef.current?.(choice)
  const gated = collectionEnabled && status === 'degraded' && userId !== null && !restoreDone

  return (
    <OutboxContext.Provider value={outbox}>
      <SavedAtContext.Provider value={savedAt}>
        <AutomaticCollectionProvider clearMetadata={clearOfflineMetadata} onController={registerAutomatic}>
          {gated ? null : children}
        </AutomaticCollectionProvider>
      </SavedAtContext.Provider>
      <EvictedNotice isOpen={evicted} onClose={() => setEvicted(false)} />
      <LogoutGuardDialog
        isOpen={Boolean(dialog)}
        busy={Boolean(dialog?.busy)}
        onSync={() => choose('sync')}
        onKeep={() => choose('keep')}
        onDiscard={() => choose('discard')}
        onCancel={() => choose('cancel')}
      />
    </OutboxContext.Provider>
  )
}

export default OfflineProvider
