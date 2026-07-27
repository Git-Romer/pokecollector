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

    let frame
    let nestedFrame
    const restore = () => {
      window.scrollTo({ top: saved.scrollY, left: 0, behavior: 'auto' })

      // A resized viewport or changed results can clamp the saved offset.
      if (Math.abs(window.scrollY - saved.scrollY) > 2) {
        document.getElementById(saved.anchorId)?.scrollIntoView({ block: 'center', behavior: 'auto' })
      }
      restoredLocationKey.current = location.key
    }

    frame = requestAnimationFrame(() => {
      nestedFrame = requestAnimationFrame(restore)
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(nestedFrame)
    }
  }, [isReady, key, location.key, location.pathname, location.search, navigationType])

  return { saveScrollPosition, createDetailNavigationState }
}

export function useDetailBackNavigation(listKey, fallbackPath) {
  const location = useLocation()
  const navigate = useNavigate()

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

export function useScrollToTopOnPush() {
  const navigationType = useNavigationType()

  useEffect(() => {
    if (navigationType === 'PUSH') window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [navigationType])
}
