import { useNavigate, useLocation } from 'react-router-dom'
import { LogOut } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

const PAGE_TITLE_KEYS = {
  '/collection': 'nav.collection',
  '/search':     'nav.cardSearch',
  '/sets':       'nav.sets',
  '/analytics':  'nav.analytics',
  '/binders':    'nav.binders',
  '/wishlist':   'nav.wishlist',
  '/products':   'nav.products',
  '/settings':   'nav.settings',
  '/migration':  'migration.title',
  '/dashboard':  'nav.dashboard',
}

export default function AppNav() {
  const navigate = useNavigate()
  const location = useLocation()
  const { logout } = useAuth()
  const { t } = useSettings()

  const handleLogout = () => { logout(); navigate('/login') }

  if (location.pathname === '/') return null

  const titleKey = Object.entries(PAGE_TITLE_KEYS).find(
    ([path]) => location.pathname.startsWith(path)
  )?.[1]
  const title = titleKey ? t(titleKey) : ''

  return (
    <>
      {/* Page title — subtle top strip with logout */}
      {title && (
        <div className="sticky top-0 z-40 px-4 pt-5 pb-3 flex items-center justify-between"
          style={{ background: 'linear-gradient(to bottom, rgba(6,8,15,0.98) 70%, transparent)' }}>
          <div className="w-8" />
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-text-muted text-center truncate flex-1 min-w-0">
            {title}
          </p>
          <button
            onClick={handleLogout}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted hover:text-brand-red transition-colors pointer-events-auto"
            aria-label={t('auth.logout')}
          >
            <LogOut size={16} />
          </button>
        </div>
      )}

      {/* Floating Pokeball home button — bottom left */}
      <button
        onClick={() => navigate('/')}
        aria-label={t('home.navigation')}
        className="fixed bottom-6 left-4 z-50 w-12 h-12 rounded-full flex items-center justify-center
          transition-all duration-200 active:scale-90 hover:scale-110"
        style={{
          background: 'linear-gradient(180deg, #e3000b 50%, #f5f5f5 50%)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5), 0 0 0 2px rgba(0,0,0,0.8), 0 0 16px rgba(227,0,11,0.3)',
          border: '2px solid #111',
        }}
      >
        {/* Pokeball center button */}
        <div className="w-4 h-4 rounded-full bg-white border-2 border-black flex items-center justify-center"
          style={{ boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)' }}>
          <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
        </div>
        {/* Horizontal divider line */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] bg-black pointer-events-none" />
      </button>
    </>
  )
}
