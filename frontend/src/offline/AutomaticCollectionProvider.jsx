import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { getCollectionOfflineManifest } from '../api/client'
import { readPwaFlags } from '../pwa/flags'
import { addUpdateGuard, isOfflineResetting } from '../pwa/register'
import { createAutomaticCollection } from './automaticCollection'
import { clearCollectionArtwork, downloadCollection, setCollectionCachePolicy } from './collectionDownload'
import { saveCollectionSnapshot } from './readCache'

const Context = createContext(null)
export const useAutomaticCollection = () => useContext(Context)

export default function AutomaticCollectionProvider({ children, clearMetadata, onController }) {
  const { user, status } = useAuth()
  const { settings, loaded } = useSettings()
  const queryClient = useQueryClient()
  const userId = user?.id
  const current = useRef({ userId, status })
  current.current = { userId, status }
  const instance = useRef(null)
  const [state, setState] = useState({ phase: 'waiting' })
  const flags = readPwaFlags()
  const supported = Boolean(flags.sw && flags.queue && !isOfflineResetting() && globalThis.isSecureContext
    && globalThis.caches && globalThis.navigator?.serviceWorker && globalThis.indexedDB)
  const enabled = settings.offline_collection_enabled === 'true'

  useEffect(() => {
    if (!supported || !loaded || !userId || !['ready', 'degraded'].includes(status)) return
    const origin = window.location.origin
    const token = localStorage.getItem('token')
    const isCurrentUser = () => current.current.userId === userId && localStorage.getItem('token') === token
    const withLock = (exclusive, work) => navigator.locks
      ? navigator.locks.request('pc-collection-download:' + origin, exclusive ? {} : { ifAvailable: true }, lock => lock ? work() : undefined)
      : work()
    const coordinator = createAutomaticCollection({
      getManifest: signal => getCollectionOfflineManifest(signal),
      download: options => downloadCollection({
        ...options, userId,
        saveMetadata: items => saveCollectionSnapshot(queryClient, items, { origin, userId, isCurrentUser: options.isCurrentUser }),
      }),
      setPolicy: value => setCollectionCachePolicy(value),
      clear: async () => { await clearMetadata(userId); await clearCollectionArtwork() },
      withLock, isActive: isCurrentUser,
      canRun: () => current.current.status === 'ready' && navigator.onLine !== false && document.visibilityState === 'visible',
      onState: setState,
    })
    instance.current = coordinator
    onController(coordinator)
    const removeGuard = addUpdateGuard(() => coordinator.busy())
    let debounce
    const wake = () => {
      if (document.visibilityState === 'visible') coordinator.run()
      else coordinator.pause()
    }
    const pause = () => coordinator.pause()
    const offline = () => coordinator.pause()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('offline', offline)
    window.addEventListener('pageshow', wake)
    window.addEventListener('pagehide', pause)
    const poll = setInterval(wake, 5 * 60 * 1000)
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || event.action?.type !== 'success' || event.action.manual
        || event.query?.queryKey?.[0] !== 'collection') return
      clearTimeout(debounce)
      debounce = setTimeout(wake, 2000)
    })
    return () => {
      coordinator.stop()
      if (instance.current === coordinator) instance.current = null
      onController(null)
      removeGuard(); unsubscribe(); clearInterval(poll); clearTimeout(debounce)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('offline', offline)
      window.removeEventListener('pageshow', wake)
      window.removeEventListener('pagehide', pause)
    }
  }, [supported, loaded, userId, status, queryClient, clearMetadata, onController])

  useEffect(() => { instance.current?.configure(enabled) }, [enabled, supported, loaded, userId, status])

  const stop = async () => {
    await instance.current?.stop()
    await clearMetadata(userId)
    setState({ phase: 'paused' })
  }

  return <Context.Provider value={supported ? { ...state, enabled, supported, stop, retry: () => instance.current?.run() } : null}>
    <span hidden className="collection-offline-download" aria-busy={state.phase === 'downloading'} />
    {children}
  </Context.Provider>
}
