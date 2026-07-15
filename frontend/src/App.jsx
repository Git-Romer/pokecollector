import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Suspense, lazy, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import PokeBallLoader from './components/PokeBallLoader'
import { SettingsProvider } from './contexts/SettingsContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { forceChangePassword } from './api/client'
import Layout from './components/Layout'
import { useSettings } from './contexts/SettingsContext'

const HomeScreen = lazy(() => import('./pages/HomeScreen'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const CardSearch = lazy(() => import('./pages/CardSearch'))
const Collection = lazy(() => import('./pages/Collection'))
const Sets = lazy(() => import('./pages/Sets'))
const SetDetail = lazy(() => import('./pages/SetDetail'))
const Wishlist = lazy(() => import('./pages/Wishlist'))
const Binders = lazy(() => import('./pages/Binders'))
const BinderDetail = lazy(() => import('./pages/BinderDetail'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Products = lazy(() => import('./pages/Products'))
const Trades = lazy(() => import('./pages/Trades'))
const Settings = lazy(() => import('./pages/Settings'))
const CardMigration = lazy(() => import('./pages/CardMigration'))
const Login = lazy(() => import('./pages/Login'))
const Leaderboard = lazy(() => import('./pages/Leaderboard'))
const Compare = lazy(() => import('./pages/Compare'))
const Achievements = lazy(() => import('./pages/Achievements'))
const UserCollection = lazy(() => import('./pages/UserCollection'))

function RouteLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <PokeBallLoader size={48} />
    </div>
  )
}

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
          <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.confirmPassword')}</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="input w-full"
            required
          />
        </div>
        {!passwordsMatch && confirmPassword && (
          <p className="text-sm text-brand-red">{t('settings.users.passwordsDoNotMatch')}</p>
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

function lazyRoute(element) {
  return <Suspense fallback={<RouteLoader />}>{element}</Suspense>
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
        <Route index element={lazyRoute(<HomeScreen />)} />
        <Route path="dashboard" element={lazyRoute(<Dashboard />)} />
        <Route path="search" element={lazyRoute(<CardSearch />)} />
        <Route path="collection" element={lazyRoute(<Collection />)} />
        <Route path="collection/user/:userId" element={lazyRoute(<UserCollection />)} />
        <Route path="sets" element={lazyRoute(<Sets />)} />
        <Route path="sets/:setId" element={lazyRoute(<SetDetail />)} />
        <Route path="wishlist" element={lazyRoute(<Wishlist />)} />
        <Route path="binders" element={lazyRoute(<Binders />)} />
        <Route path="binders/:binderId" element={lazyRoute(<BinderDetail />)} />
        <Route path="analytics" element={lazyRoute(<Analytics />)} />
        <Route path="products" element={lazyRoute(<Products />)} />
        <Route path="trades" element={lazyRoute(<Trades />)} />
        <Route path="leaderboard" element={lazyRoute(<Leaderboard />)} />
        <Route path="leaderboard/compare/:userId" element={lazyRoute(<Compare />)} />
        <Route path="achievements" element={lazyRoute(<Achievements />)} />
        <Route path="achievements/:userId" element={lazyRoute(<Achievements />)} />
        <Route path="settings" element={lazyRoute(<Settings />)} />
        <Route path="migration" element={lazyRoute(<CardMigration />)} />
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
            <Route path="/login" element={lazyRoute(<Login />)} />
            <Route path="/*" element={<ProtectedRoutes />} />
          </Routes>
        </BrowserRouter>
      </SettingsProvider>
    </AuthProvider>
  )
}
