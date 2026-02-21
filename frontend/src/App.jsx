import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { SettingsProvider } from './contexts/SettingsContext'
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

export default function App() {
  return (
    <SettingsProvider>
      <BrowserRouter>
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
            <Route path="settings" element={<Settings />} />
            <Route path="migration" element={<CardMigration />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SettingsProvider>
  )
}
