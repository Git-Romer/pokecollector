import { createContext, useContext, useEffect, useState } from 'react'
import { getAuthMode, getMe } from '../api/client'

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
  const [loading, setLoading] = useState(true)
  const [multiUser, setMultiUser] = useState(true)

  useEffect(() => {
    getAuthMode()
      .then(({ multi_user }) => {
        setMultiUser(multi_user)
        const token = localStorage.getItem('token')
        if (!multi_user || token) {
          return getMe().then((currentUser) => {
            setUser(currentUser)
            localStorage.setItem('user', JSON.stringify(currentUser))
          })
        }
        setUser(null)
      })
      .catch(() => {
        const token = localStorage.getItem('token')
        if (token) {
          return getMe().then((currentUser) => {
            setUser(currentUser)
            localStorage.setItem('user', JSON.stringify(currentUser))
          })
        }
      })
      .catch(() => {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        setUser(null)
      })
      .finally(() => setLoading(false))
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

  return (
    <AuthContext.Provider value={{ user, loading, multiUser, loginUser, updateCurrentUser, logout }}>
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
