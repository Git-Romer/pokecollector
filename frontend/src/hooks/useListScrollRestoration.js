import { useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'

const storageKey = (key) => `pokecollector:list-scroll:${key}`

const readSavedPosition = (key) => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(key)))
    if (!saved || !Number.isFinite(saved.scrollY) || typeof saved.anchorId !== 'string') return null
    return saved
  } catch {
    return null
  }
}

export const getSavedListScrollPosition = (key) => readSavedPosition(key)

export const isSavedPositionForLocation = (saved, location) => (
  saved?.locationKey === location.key
  && saved.pathname === location.pathname
  && saved.search === location.search
)

export const saveListScrollPosition = (key, position) => {
  try {
    sessionStorage.setItem(storageKey(key), JSON.stringify(position))
  } catch {
    // Storage may be unavailable in private browsing contexts.
  }
}

export const getDetailBackDelta = (state, listKey) => {
  if (state?.fromList !== listKey) return null
  const depth = Number(state.detailHistoryDepth)
  return -(Number.isInteger(depth) && depth >= 0 ? depth + 1 : 1)
}

export const getNextDetailNavigationState = (state, listKey) => {
  if (state?.fromList !== listKey) return undefined
  const depth = Number(state.detailHistoryDepth)
  return {
    ...state,
    detailHistoryDepth: (Number.isInteger(depth) && depth >= 0 ? depth : 0) + 1,
  }
}

export const restoreListScrollPosition = (saved, browserWindow = window, browserDocument = document) => {
  browserWindow.scrollTo({ top: saved.scrollY, left: 0, behavior: 'auto' })

  // A resized viewport or changed results can clamp the saved offset.
  if (Math.abs(browserWindow.scrollY - saved.scrollY) > 2) {
    browserDocument.getElementById(saved.anchorId)?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }
}

let activeHistoryRestoration = null

export const releaseManualHistoryScrollRestoration = () => {
  if (!activeHistoryRestoration) return
  activeHistoryRestoration.browserHistory.scrollRestoration = activeHistoryRestoration.previousValue
  activeHistoryRestoration = null
}

export const scheduleManualHistoryScrollRestorationRelease = (
  delay = 1000,
  browserWindow = globalThis,
) => {
  const restoration = activeHistoryRestoration
  if (!restoration) return () => {}

  const timeoutId = browserWindow.setTimeout(() => {
    if (activeHistoryRestoration === restoration) releaseManualHistoryScrollRestoration()
  }, delay)
  return () => browserWindow.clearTimeout(timeoutId)
}

export const enableManualHistoryScrollRestoration = (
  browserHistory = window.history,
) => {
  if (!browserHistory || !('scrollRestoration' in browserHistory)) return () => {}

  if (activeHistoryRestoration?.browserHistory !== browserHistory) {
    activeHistoryRestoration = {
      browserHistory,
      previousValue: browserHistory.scrollRestoration,
    }
  }

  browserHistory.scrollRestoration = 'manual'
  return releaseManualHistoryScrollRestoration
}

export const isListScrollSurfaceVisible = (key, browserDocument = document) => {
  const surface = browserDocument.querySelector(`[data-scroll-list="${key}"]`)
  return Boolean(surface?.getClientRects?.().length)
}

/**
 * React Router's <ScrollRestoration /> requires a data router, while this app
 * uses BrowserRouter. We also need to delay restoration until async list items
 * render and provide an item-anchor fallback when the layout has changed.
 */
export function useListScrollRestoration({ key, isReady, listState = null }) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const restoredLocationKey = useRef(null)

  useEffect(() => {
    if (listState === null) return
    const saved = readSavedPosition(key)
    if (!isSavedPositionForLocation(saved, location)) return
    saveListScrollPosition(key, { ...saved, listState })
  }, [key, listState, location])

  const saveScrollPosition = useCallback((anchorId, listState) => {
    const position = {
      scrollY: window.scrollY,
      anchorId,
      pathname: location.pathname,
      search: location.search,
      locationKey: location.key,
      listState,
    }
    saveListScrollPosition(key, position)
  }, [key, location.key, location.pathname, location.search])

  const createDetailNavigationState = useCallback((anchorId) => ({
    fromList: key,
    returnPath: `${location.pathname}${location.search}`,
    anchorId,
    detailHistoryDepth: 0,
  }), [key, location.pathname, location.search])

  useEffect(() => {
    if (!isReady || navigationType !== 'POP' || restoredLocationKey.current === location.key) return

    const saved = readSavedPosition(key)
    if (!isSavedPositionForLocation(saved, location)) return

    let frameId = null
    const restoreWhenVisible = () => {
      // React can prepare the returning route offscreen while keeping the detail
      // route visible. Wait for the list surface itself to become visible so its
      // offset is never applied to the old detail DOM.
      if (!isListScrollSurfaceVisible(key)) {
        frameId = window.requestAnimationFrame(restoreWhenVisible)
        return
      }

      restoreListScrollPosition(saved)
      restoredLocationKey.current = location.key
      releaseManualHistoryScrollRestoration()
    }

    frameId = window.requestAnimationFrame(restoreWhenVisible)
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
    }
  }, [isReady, key, location.key, location.pathname, location.search, navigationType])

  return { saveScrollPosition, createDetailNavigationState }
}

export function useDetailBackNavigation(listKey, fallbackPath) {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (location.state?.fromList !== listKey) return undefined

    // The list restores itself before paint. Native restoration would apply the
    // saved list offset to the still-mounted detail DOM during the POP instead.
    // The layout releases this only after the next non-detail route commits, so
    // native restoration stays disabled for the entire POP transition.
    enableManualHistoryScrollRestoration()
    return undefined
  }, [listKey, location.state])

  const goBack = useCallback(() => {
    const delta = getDetailBackDelta(location.state, listKey)
    if (delta !== null) {
      navigate(delta)
      return
    }
    navigate(fallbackPath)
  }, [fallbackPath, listKey, location.state, navigate])

  return goBack
}

export function useReleaseManualHistoryScrollRestoration() {
  const location = useLocation()

  useEffect(() => {
    if (location.state?.fromList) return
    return scheduleManualHistoryScrollRestorationRelease()
  }, [location.key, location.state])
}

export function useScrollToTopOnPush() {
  const navigationType = useNavigationType()

  useEffect(() => {
    if (navigationType === 'PUSH') window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [navigationType])
}
