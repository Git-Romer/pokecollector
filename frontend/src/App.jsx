import { BrowserRouter, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import { Suspense, lazy, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import PokeBallLoader from './components/PokeBallLoader'
import HoloDeviceMotionController from './components/HoloDeviceMotionController'
import AuthStartupScreen from './components/AuthStartupScreen'
import { SettingsProvider } from './contexts/SettingsContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { forceChangePassword } from './api/client'
import Layout from './components/Layout'
import { usePageScrollReset } from './hooks/useListScrollRestoration'
import { useSettings } from './contexts/SettingsContext'
import PublicHomeButton from './components/PublicHomeButton'
import { ConfirmDialogProvider } from './contexts/ConfirmDialogContext'
import UpdateBanner from './components/pwa/UpdateBanner'
import { OfflineProvider } from './offline/OfflineProvider'

const HomeScreen = lazy(() => import('./pages/HomeScreen'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const CardSearch = lazy(() => import('./pages/CardSearch'))
const Collection = lazy(() => import('./pages/Collection'))
const Pokedex = lazy(() => import('./pages/Pokedex'))
const PokedexSpecies = lazy(() => import('./pages/PokedexSpecies'))
const Sets = lazy(() => import('./pages/Sets'))
const SetDetail = lazy(() => import('./pages/SetDetail'))
const Artists = lazy(() => import('./pages/Artists'))
const ArtistChecklist = lazy(() => import('./pages/ArtistChecklist'))
const Wishlist = lazy(() => import('./pages/Wishlist'))
const Binders = lazy(() => import('./pages/Binders'))
const BinderDetail = lazy(() => import('./pages/BinderDetail'))
const DeckEditor = lazy(() => import('./pages/DeckEditor'))
const DeckCompare = lazy(() => import('./pages/DeckCompare'))
const Analytics = lazy(() => import('./pages/Analytics'))
const Products = lazy(() => import('./pages/Products'))
const Trades = lazy(() => import('./pages/Trades'))
const Settings = lazy(() => import('./pages/Settings'))
const CardMigration = lazy(() => import('./pages/CardMigration'))
const ScanQueue = lazy(() => import('./pages/ScanQueue'))
const OfflineCenter = lazy(() => import('./pages/OfflineCenter'))
const Login = lazy(() => import('./pages/Login'))
const OidcComplete = lazy(() => import('./pages/OidcComplete'))
const Leaderboard = lazy(() => import('./pages/Leaderboard'))
const Compare = lazy(() => import('./pages/Compare'))
const Achievements = lazy(() => import('./pages/Achievements'))
const UserCollection = lazy(() => import('./pages/UserCollection'))
const PublicProfile = lazy(() => import('./pages/PublicProfile'))
const PublicBinderView = lazy(() => import('./pages/PublicBinderView'))
const PublicWishlistView = lazy(() => import('./pages/PublicWishlistView'))
const PublicDeckView = lazy(() => import('./pages/PublicDeckView'))

function LegacyDeckBuildRedirect() {
  const { deckId } = useParams()
  return <Navigate to={`/decks/${deckId}`} replace />
}
const PublicDirectory = lazy(() => import('./pages/PublicDirectory'))
const CardSystemGallery = import.meta.env.DEV
  ? lazy(() => import('./components/card-system/CardSystemGallery'))
  : null

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
  const { user, updateCurrentUser } = useAuth()
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
      <form onSubmit={handleSubmit} method="post" action="/change-password" className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-6 shadow-xl space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-text-primary">{t('settings.users.changePassword')}</h1>
          <p className="text-sm text-text-muted">{t('settings.users.forcePasswordChange')}</p>
        </div>
        <input
          type="text"
          name="username"
          id="force-change-username"
          value={user?.username || ''}
          onChange={() => {}}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          aria-label={t('auth.username')}
          className="sr-only"
        />
        <div>
          <label htmlFor="force-change-new-password" className="text-xs text-text-secondary mb-1 block">{t('settings.users.newPassword')}</label>
          <input
            type="password"
            name="new-password"
            id="force-change-new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className="input w-full"
            required
          />
        </div>
        <div>
          <label htmlFor="force-change-confirm-password" className="text-xs text-text-secondary mb-1 block">{t('settings.users.confirmPassword')}</label>
          <input
            type="password"
            name="confirm-password"
            id="force-change-confirm-password"
            autoComplete="new-password"
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

function PageScrollBoundary({ children }) {
  usePageScrollReset()
  return children
}

function lazyRoute(element) {
  // Commit the reset with the resolved page, not with its loading placeholder.
  return <Suspense fallback={<RouteLoader />}><PageScrollBoundary>{element}</PageScrollBoundary></Suspense>
}

function PublicRoutes() {
  return (
    <>
      <PublicHomeButton />
      <Outlet />
    </>
  )
}

function ProtectedRoutes() {
  const { user, loading, connectionError, multiUser, retryConnection } = useAuth()

  if (loading) {
    return <AuthStartupScreen connectionError={connectionError} onRetry={retryConnection} />
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
        <Route path="pokedex" element={lazyRoute(<Pokedex />)} />
        <Route path="pokedex/:dexId" element={lazyRoute(<PokedexSpecies />)} />
        <Route path="collection/user/:userId" element={lazyRoute(<UserCollection />)} />
        <Route path="sets" element={lazyRoute(<Sets />)} />
        <Route path="sets/:setId" element={lazyRoute(<SetDetail />)} />
        <Route path="artists" element={lazyRoute(<Artists />)} />
        <Route path="artist/:artistName" element={lazyRoute(<ArtistChecklist />)} />
        <Route path="wishlist" element={lazyRoute(<Wishlist />)} />
        <Route path="binders" element={lazyRoute(<Binders />)} />
        <Route path="binders/:binderId" element={lazyRoute(<BinderDetail />)} />
        <Route path="decks" element={<Navigate to="/binders" replace />} />
        <Route path="decks/inventory" element={<Navigate to="/binders" replace />} />
        <Route path="decks/compare" element={lazyRoute(<DeckCompare />)} />
        <Route path="decks/:deckId" element={lazyRoute(<DeckEditor />)} />
        <Route path="decks/:deckId/build" element={<LegacyDeckBuildRedirect />} />
        <Route path="analytics" element={lazyRoute(<Analytics />)} />
        <Route path="products" element={lazyRoute(<Products />)} />
        <Route path="trades" element={lazyRoute(<Trades />)} />
        <Route path="leaderboard" element={lazyRoute(<Leaderboard />)} />
        <Route path="leaderboard/compare/:userId" element={lazyRoute(<Compare />)} />
        <Route path="achievements" element={lazyRoute(<Achievements />)} />
        <Route path="achievements/:userId" element={lazyRoute(<Achievements />)} />
        <Route path="settings" element={lazyRoute(<Settings />)} />
        <Route path="migration" element={lazyRoute(<CardMigration />)} />
        <Route path="scans" element={lazyRoute(<ScanQueue />)} />
        <Route path="scans/:jobId" element={lazyRoute(<ScanQueue />)} />
        <Route path="offline" element={lazyRoute(<OfflineCenter />)} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <OfflineProvider>
        <HoloDeviceMotionController />
        <ConfirmDialogProvider>
          <BrowserRouter>
            <Routes>
              {import.meta.env.DEV && <Route path="/__card-system" element={lazyRoute(<CardSystemGallery />)} />}
              <Route path="/login" element={lazyRoute(<Login />)} />
              <Route path="/auth/oidc/complete" element={lazyRoute(<OidcComplete />)} />
              <Route path="/u" element={<PublicRoutes />}>
                <Route index element={lazyRoute(<PublicDirectory />)} />
                <Route path=":handle" element={lazyRoute(<PublicProfile />)} />
                <Route path=":handle/decks" element={lazyRoute(<PublicProfile />)} />
                <Route path=":handle/binder/:binderId" element={lazyRoute(<PublicBinderView />)} />
                <Route path=":handle/wishlist" element={lazyRoute(<PublicWishlistView />)} />
                <Route path=":handle/deck/:deckId" element={lazyRoute(<PublicDeckView />)} />
              </Route>
              <Route path="/*" element={<ProtectedRoutes />} />
            </Routes>
          </BrowserRouter>
          <UpdateBanner />
        </ConfirmDialogProvider>
        </OfflineProvider>
      </SettingsProvider>
    </AuthProvider>
  )
}
