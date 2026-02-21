import { NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutDashboard, Search, Library, Grid2X2, Heart,
  BookOpen, BarChart3, ShoppingBag, Settings, Zap
} from 'lucide-react'
import { getDashboard, getCustomMatches } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import clsx from 'clsx'

export default function Sidebar() {
  const { t, formatPrice } = useSettings()

  const navItems = [
    { to: '/dashboard',  icon: LayoutDashboard, label: t('nav.dashboard') },
    { to: '/search',     icon: Search,           label: t('nav.cardSearch') },
    { to: '/collection', icon: Library,          label: t('nav.collection') },
    { to: '/sets',       icon: Grid2X2,          label: t('nav.sets') },
    { to: '/wishlist',   icon: Heart,             label: t('nav.wishlist') },
    { to: '/binders',    icon: BookOpen,          label: t('nav.binders') },
    { to: '/analytics',  icon: BarChart3,         label: t('nav.analytics') },
    { to: '/products',   icon: ShoppingBag,       label: t('nav.products') },
    { to: '/settings',   icon: Settings,          label: t('nav.settings') },
  ]

  const { data } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => getDashboard().then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: matches = [] } = useQuery({
    queryKey: ['custom-matches'],
    queryFn: () => getCustomMatches().then(r => r.data),
    refetchInterval: 60000,
  })
  const pendingMatchCount = matches.length
  const newSetsCount = data?.new_sets_count || 0

  return (
    <aside className="hidden lg:flex w-56 bg-bg-surface border-r border-border flex-col flex-shrink-0">
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group relative min-w-0',
                isActive
                  ? 'bg-brand-red/20 text-brand-red border border-brand-red/30'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-elevated'
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  size={18}
                  className={clsx(
                    'transition-colors flex-shrink-0',
                    isActive ? 'text-brand-red' : 'text-text-muted group-hover:text-text-secondary'
                  )}
                />
                <span className="flex-1 min-w-0 truncate">{label}</span>
                {/* New sets badge */}
                {label === t('nav.sets') && newSetsCount > 0 && (
                  <span className="ml-auto bg-brand-red text-white text-xs px-1.5 py-0.5 rounded-full min-w-[20px] text-center flex-shrink-0">
                    {newSetsCount}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}

        {/* Migration link — only when pending */}
        {pendingMatchCount > 0 && (
          <NavLink
            to="/migration"
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group relative min-w-0',
                isActive
                  ? 'bg-yellow/20 text-yellow border border-yellow/30'
                  : 'text-yellow/80 hover:text-yellow hover:bg-bg-elevated'
              )
            }
          >
            <Zap size={18} className="flex-shrink-0 text-yellow" />
            <span className="flex-1 min-w-0 truncate">{t('migration.title')}</span>
            <span className="ml-auto bg-yellow text-black text-xs px-1.5 py-0.5 rounded-full min-w-[20px] text-center font-bold flex-shrink-0">
              {pendingMatchCount}
            </span>
          </NavLink>
        )}
      </nav>

      {/* Collection summary */}
      {data && (
        <div className="p-3 border-t border-border">
          <div className="bg-bg-card rounded-lg p-3 text-xs space-y-1.5">
            <div className="flex justify-between items-center gap-2">
              <span className="text-text-muted">{t('nav.cards')}</span>
              <span className="text-text-primary font-medium">{data.total_cards?.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center gap-2">
              <span className="text-text-muted">{t('nav.value')}</span>
              <span className="text-green font-medium">{formatPrice(data.total_value || 0)}</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
