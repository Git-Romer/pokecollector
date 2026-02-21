import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutDashboard, Search, Library, Grid2X2, MoreHorizontal,
  Heart, BookOpen, BarChart3, ShoppingBag, Settings, X, Zap
} from 'lucide-react'
import { getCustomMatches } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import clsx from 'clsx'

export default function BottomNav() {
  const { t } = useSettings()
  const [showMore, setShowMore] = useState(false)
  const navigate = useNavigate()

  const { data: matches = [] } = useQuery({
    queryKey: ['custom-matches'],
    queryFn: () => getCustomMatches().then(r => r.data),
    refetchInterval: 60000,
  })
  const pendingCount = matches.length

  const mainNav = [
    { to: '/dashboard',  icon: LayoutDashboard, label: t('nav.dashboard') },
    { to: '/search',     icon: Search,           label: t('nav.cardSearch') },
    { to: '/collection', icon: Library,          label: t('nav.collection') },
    { to: '/sets',       icon: Grid2X2,          label: t('nav.sets') },
  ]

  const moreNav = [
    { to: '/wishlist',   icon: Heart,      label: t('nav.wishlist') },
    { to: '/binders',    icon: BookOpen,   label: t('nav.binders') },
    { to: '/analytics',  icon: BarChart3,  label: t('nav.analytics') },
    { to: '/products',   icon: ShoppingBag, label: t('nav.products') },
    { to: '/settings',   icon: Settings,   label: t('nav.settings') },
    ...(pendingCount > 0
      ? [{ to: '/migration', icon: Zap, label: t('migration.title'), badge: pendingCount }]
      : []),
  ]

  const handleMoreNav = (to) => {
    setShowMore(false)
    navigate(to)
  }

  return (
    <>
      {/* ── Bottom Nav Bar ── */}
      <nav className="bottom-nav">
        {mainNav.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx('bottom-nav-item', isActive ? 'bottom-nav-active' : 'bottom-nav-inactive')
            }
          >
            <Icon size={22} />
            <span>{label}</span>
          </NavLink>
        ))}

        {/* More button */}
        <button
          onClick={() => setShowMore(true)}
          className={clsx(
            'bottom-nav-item',
            showMore ? 'bottom-nav-active' : 'bottom-nav-inactive'
          )}
        >
          <div className="relative">
            <MoreHorizontal size={22} />
            {pendingCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-yellow text-black text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center leading-none">
                {pendingCount}
              </span>
            )}
          </div>
          <span>{t('nav.more')}</span>
        </button>
      </nav>

      {/* ── More Sheet (slides up from bottom) ── */}
      {showMore && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            onClick={() => setShowMore(false)}
          />

          {/* Sheet panel */}
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-bg-surface border-t border-border rounded-t-2xl lg:hidden more-sheet-enter">
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 bg-border rounded-full" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2">
              <h3 className="text-sm font-semibold text-text-primary">{t('nav.more')}</h3>
              <button
                onClick={() => setShowMore(false)}
                className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-elevated transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Grid of nav items */}
            <div className="grid grid-cols-3 gap-2 p-4 safe-area-bottom">
              {moreNav.map(({ to, icon: Icon, label, badge }) => (
                <button
                  key={to}
                  onClick={() => handleMoreNav(to)}
                  className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl bg-bg-card hover:bg-bg-elevated active:bg-border transition-colors relative"
                >
                  <div className="relative">
                    <Icon size={22} className="text-text-secondary" />
                    {badge && (
                      <span className="absolute -top-1 -right-1 bg-yellow text-black text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center leading-none">
                        {badge}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-text-muted text-center leading-tight">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
