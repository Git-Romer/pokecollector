import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import PokeBallLoader from './components/PokeBallLoader'
import { SettingsProvider } from './contexts/SettingsContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
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
