import { BarChart3, LayoutDashboard, ShoppingBag } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import TabNav from './TabNav'

export default function AnalyticsSectionNav() {
  const { t } = useSettings()
  const tabs = [
    { to: '/analytics', label: t('nav.analytics'), icon: BarChart3 },
    { to: '/products', label: t('nav.products'), icon: ShoppingBag },
    { to: '/dashboard', label: t('nav.dashboard'), icon: LayoutDashboard },
  ]

  return <TabNav tabs={tabs} />
}
