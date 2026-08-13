import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { getAuthMode, getMe } from '../api/client'
import { authRetryDelay, loadAuthState } from './authBootstrap'

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

        if (result.clearSession || !result.user) {
          localStorage.removeItem('user')
          if (result.clearSession) localStorage.removeItem('token')
        } else {
          localStorage.setItem('user', JSON.stringify(result.user))
        }
        setAuthStatus('ready')
      } catch {
        if (cancelled) return

        // Do not guess the authentication mode or discard the session while
        // the backend is unavailable. Keep protected routes on a connection
        // screen and recover as soon as startup completes.
        setAuthStatus('offline')
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

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
    // Force full page reload to clear all cached data (React Query, etc.)
    // Prevents settings/data from previous user session leaking
    window.location.href = '/login'
  }

  const loading = authStatus !== 'ready'
  const connectionError = authStatus === 'offline'

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      connectionError,
      multiUser,
      modeLocked,
      loginUser,
      updateCurrentUser,
      logout,
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
