import { Outlet, useLocation } from 'react-router-dom'
import AppNav from './AppNav'

export default function Layout() {
  const location = useLocation()
  const isHome = location.pathname === '/'

  return (
    <div className="min-h-dvh flex flex-col bg-bg">
      {!isHome && <AppNav />}
      <main className={`flex-1 ${!isHome ? 'w-full px-4 pb-8' : ''}`}>
        <Outlet />
      </main>
    </div>
  )
}
