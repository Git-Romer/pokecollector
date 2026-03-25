import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import PokeBallLoader from './components/PokeBallLoader'
import { SettingsProvider } from './contexts/SettingsContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { forceChangePassword } from './api/client'
import Layout from './components/Layout'
import HomeScreen from './pages/HomeScreen'
import Dashboard from './pages/Dashboard'
import CardSearch from './pages/CardSearch'
import Collection from './pages/Collection'
import Sets from './pages/Sets'
import SetDetail from './pages/SetDetail'
import Wishlist from './pages/Wishlist'
import Binders from './pages/Binders'
import BinderDetail from './pages/BinderDetail'
import Analytics from './pages/Analytics'
import Products from './pages/Products'
import Settings from './pages/Settings'
import CardMigration from './pages/CardMigration'
import Login from './pages/Login'
import Leaderboard from './pages/Leaderboard'
import Compare from './pages/Compare'
import Achievements from './pages/Achievements'
import { useSettings } from './contexts/SettingsContext'

function ForcePasswordChangeScreen() {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const { updateCurrentUser } = useAuth()
  const { t } = useSettings()

  const forceChangeMutation = useMutation({
    mutationFn: forceChangePassword,
    onSuccess: () => {
      updateCurrentUser({ must_change_password: false })
      setNewPassword('')
      setConfirmPassword('')
    },
  })

  const passwordsMatch = newPassword === confirmPassword
  const canSubmit = newPassword && confirmPassword && passwordsMatch && !forceChangeMutation.isPending

  const handleSubmit = (event) => {
    event.preventDefault()
    if (!canSubmit) return
    forceChangeMutation.mutate(newPassword)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-6 shadow-xl space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-text-primary">{t('settings.users.changePassword')}</h1>
          <p className="text-sm text-text-muted">{t('settings.users.forcePasswordChange')}</p>
        </div>
        <div>
          <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.newPassword')}</label>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className="input w-full"
            required
          />
        </div>
        <div>
          <label className="text-xs text-text-secondary mb-1 block">Confirm Password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="input w-full"
            required
          />
        </div>
        {!passwordsMatch && confirmPassword && (
          <p className="text-sm text-brand-red">Passwords do not match</p>
        )}
        {forceChangeMutation.isError && (
          <p className="text-sm text-brand-red">
            {forceChangeMutation.error?.response?.data?.detail || t('common.error')}
          </p>
        )}
        <button type="submit" disabled={!canSubmit} className="btn-primary w-full">
          {t('settings.users.changePassword')}
        </button>
      </form>
    </div>
  )
}

function ProtectedRoutes() {
  const { user, loading, multiUser } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <PokeBallLoader size={48} />
      </div>
    )
  }

  if (!user && multiUser) {
    return <Navigate to="/login" replace />
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <PokeBallLoader size={48} />
      </div>
    )
  }

  if (user.must_change_password) {
    return <ForcePasswordChangeScreen />
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<HomeScreen />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="search" element={<CardSearch />} />
        <Route path="collection" element={<Collection />} />
        <Route path="sets" element={<Sets />} />
        <Route path="sets/:setId" element={<SetDetail />} />
        <Route path="wishlist" element={<Wishlist />} />
        <Route path="binders" element={<Binders />} />
        <Route path="binders/:binderId" element={<BinderDetail />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="products" element={<Products />} />
        <Route path="leaderboard" element={<Leaderboard />} />
        <Route path="leaderboard/compare/:userId" element={<Compare />} />
        <Route path="achievements" element={<Achievements />} />
        <Route path="achievements/:userId" element={<Achievements />} />
        <Route path="settings" element={<Settings />} />
        <Route path="migration" element={<CardMigration />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/*" element={<ProtectedRoutes />} />
          </Routes>
        </BrowserRouter>
      </SettingsProvider>
    </AuthProvider>
  )
}
