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

const clearSavedPosition = (key) => {
  try {
    sessionStorage.removeItem(storageKey(key))
  } catch {
    // Storage may be unavailable in private browsing contexts.
  }
}

/**
 * Persists a list's position across a list/detail history traversal.  The
 * location key prevents an old request from being applied to a fresh visit.
 */
export function useListScrollRestoration({ key, isReady }) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const restoredLocationKey = useRef(null)

  const saveScrollPosition = useCallback((anchorId) => {
    const position = {
      scrollY: window.scrollY,
      anchorId,
      pathname: location.pathname,
      search: location.search,
      locationKey: location.key,
    }
    try {
      sessionStorage.setItem(storageKey(key), JSON.stringify(position))
    } catch {
      // Navigating still works if session storage is unavailable.
    }
  }, [key, location.key, location.pathname, location.search])

  const createDetailNavigationState = useCallback((anchorId) => ({
    fromList: key,
    returnPath: `${location.pathname}${location.search}`,
    anchorId,
  }), [key, location.pathname, location.search])

  useEffect(() => {
    if (!isReady || navigationType !== 'POP' || restoredLocationKey.current === location.key) return

    const saved = readSavedPosition(key)
    if (!saved || saved.locationKey !== location.key || saved.pathname !== location.pathname || saved.search !== location.search) return

    let frame
    let nestedFrame
    const restore = () => {
      window.scrollTo({ top: saved.scrollY, left: 0, behavior: 'auto' })

      // A resized viewport or changed results can clamp the saved offset.
      if (Math.abs(window.scrollY - saved.scrollY) > 2) {
        document.getElementById(saved.anchorId)?.scrollIntoView({ block: 'center', behavior: 'auto' })
      }
      restoredLocationKey.current = location.key
      clearSavedPosition(key)
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
    if (location.state?.fromList === listKey) {
      navigate(-1)
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
