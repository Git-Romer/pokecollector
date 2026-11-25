import { Outlet, useLocation } from 'react-router-dom'
import AppNav from './AppNav'
import OfflineUnavailable from './OfflineUnavailable'
import InstallHint from './pwa/InstallHint'
import OfflineBanner from './sync/OfflineBanner'
import StaleDataLabel from './sync/StaleDataLabel'
import { useReleaseManualHistoryScrollRestoration } from '../hooks/useListScrollRestoration'
import { isOfflineRoute } from '../offline/routes'
import { useOffline } from '../offline/useOffline'

export default function Layout() {
  const location = useLocation()
  const isHome = location.pathname === '/'
  const offline = useOffline()
  const showUnavailable = offline && !isOfflineRoute(location.pathname)
  useReleaseManualHistoryScrollRestoration()

  return (
    <div className="min-h-dvh flex flex-col bg-bg overflow-x-hidden">
      <OfflineBanner />
      {!isHome && <AppNav />}
      <main className={`flex-1 ${!isHome ? 'w-full px-6 pb-8 sm:px-8 lg:px-10 xl:px-12' : ''}`}>
        {showUnavailable ? <OfflineUnavailable /> : (
          <>
            <StaleDataLabel />
            <Outlet />
          </>
        )}
        {isHome && <InstallHint />}
      </main>
    </div>
  )
}
