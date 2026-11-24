import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { getAuthMode, getMe } from '../api/client'
import { authRetryDelay, loadAuthState } from './authBootstrap'
import { clearSettingsCache } from '../offline/settingsCache'
import { clearAuthSnapshot, readAuthSnapshot, writeAuthSnapshot } from '../offline/authSnapshot'
import { readPwaFlags } from '../pwa/flags'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user')
    if (!stored) return null
    try {
      return JSON.parse(stored)
    } catch {
      localStorage.removeItem('user')
      return null
    }
  })
  const [authStatus, setAuthStatus] = useState('loading')
  const [multiUser, setMultiUser] = useState(true)
  const [modeLocked, setModeLocked] = useState(false)
  const [bootstrapVersion, setBootstrapVersion] = useState(0)
  const logoutGuardRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    let retryTimer = null

    const bootstrap = async (attempt = 0) => {
      try {
        const result = await loadAuthState({
          token: localStorage.getItem('token'),
          getAuthMode,
          getMe,
        })
        if (cancelled) return

        setMultiUser(result.multiUser)
        setModeLocked(result.modeLocked)
        setUser(result.user)

        if (result.clearToken) localStorage.removeItem('token')

        if (result.clearSession || !result.user) {
          localStorage.removeItem('user')
          if (result.clearSession) {
            clearAuthSnapshot()
            clearSettingsCache()
          }
        } else {
          localStorage.setItem('user', JSON.stringify(result.user))
          writeAuthSnapshot({ multiUser: result.multiUser, locked: result.modeLocked, user: result.user })
        }
        setAuthStatus('ready')
      } catch {
        if (cancelled) return

        // Do not guess the authentication mode or discard the session while
        // the backend is unavailable. With the offline queue on, a valid cached
        // sign-in opens the app in a display-only degraded state; otherwise keep
        // protected routes on a connection screen. Either way keep retrying and
        // recover as soon as startup completes.
        const snapshot = readPwaFlags().queue
          ? readAuthSnapshot({ token: localStorage.getItem('token') })
          : null
        if (snapshot) {
          setUser(snapshot.user)
          setMultiUser(snapshot.multiUser)
          setModeLocked(snapshot.locked)
          setAuthStatus('degraded')
        } else {
          setAuthStatus('offline')
        }
        retryTimer = window.setTimeout(() => bootstrap(attempt + 1), authRetryDelay(attempt))
      }
    }

    bootstrap()
    return () => {
      cancelled = true
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [bootstrapVersion])

  const retryConnection = useCallback(() => {
    setAuthStatus('loading')
    setBootstrapVersion((version) => version + 1)
  }, [])

  const loginUser = (token, userData) => {
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(userData))
    setUser(userData)
    writeAuthSnapshot({ multiUser, locked: modeLocked, user: userData })
  }

  const updateCurrentUser = (updates) => {
    setUser((prev) => {
      const next = prev ? { ...prev, ...updates } : prev
      if (next) {
        localStorage.setItem('user', JSON.stringify(next))
      }
      return next
    })
  }

  // OfflineProvider registers a guard that may ask what to do with unsynced items.
  const setLogoutGuard = useCallback((guard) => {
    logoutGuardRef.current = guard
  }, [])

  const logout = async () => {
    const proceed = logoutGuardRef.current ? await logoutGuardRef.current() : true
    if (!proceed) return
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    clearAuthSnapshot()
    clearSettingsCache()
    setUser(null)
    // Force full page reload to clear all cached data (React Query, etc.)
    // Prevents settings/data from previous user session leaking
    window.location.href = '/login'
  }

  const loading = authStatus === 'loading' || authStatus === 'offline'
  const connectionError = authStatus === 'offline'
  const offline = authStatus === 'degraded' || authStatus === 'offline'

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      status: authStatus,
      offline,
      connectionError,
      multiUser,
      modeLocked,
      loginUser,
      updateCurrentUser,
      logout,
      setLogoutGuard,
      retryConnection,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export default AuthContext
