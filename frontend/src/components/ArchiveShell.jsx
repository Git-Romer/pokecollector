import { useEffect, useState } from 'react'
import { Badge, Button, Toolbar, ToolbarButton } from '@fluentui/react-components'
import { CollectionsRegular, DataBarVerticalRegular, SearchRegular, SettingsRegular, TableRegular } from '@fluentui/react-icons'
import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import ArchiveCommandBar from './ArchiveCommandBar'
import JohnJohnSignal from './JohnJohnSignal'
import { PRIMARY_ARCHIVE_DESTINATIONS } from './archiveNavigation'

const ICONS = { collection: CollectionsRegular, search: SearchRegular, sets: TableRegular, analytics: DataBarVerticalRegular, settings: SettingsRegular }
export const PRIMARY_ARCHIVE_NAV = PRIMARY_ARCHIVE_DESTINATIONS.map((item) => ({ ...item, icon: ICONS[item.icon] }))

export default function ArchiveShell() {
  const [commandOpen, setCommandOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target
      const editing = target instanceof HTMLElement && (target.matches('input, textarea, [contenteditable="true"]') || target.isContentEditable)
      if (!editing && event.key === '/') {
        event.preventDefault()
        setCommandOpen(true)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="archive-shell min-h-dvh">
      <aside className="archive-rail hidden lg:flex" aria-label="Primary navigation">
        <div className="archive-wordmark"><span>JJ</span><strong>John John's PC</strong></div>
        <nav className="archive-nav">
          {PRIMARY_ARCHIVE_NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => clsx('archive-nav-link', isActive && 'archive-nav-link-active')}>
              <Icon /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="archive-rail-footer"><JohnJohnSignal /><span>Archive keeper</span></div>
      </aside>
      <div className="archive-content">
        <Toolbar className="archive-toolbar">
          <ToolbarButton icon={<SearchRegular />} onClick={() => setCommandOpen(true)}>Search archive <kbd>Ctrl K</kbd></ToolbarButton>
          <div className="ml-auto"><JohnJohnSignal /></div>
        </Toolbar>
        <main className="archive-main"><Outlet /></main>
      </div>
      <nav className="archive-mobile-nav lg:hidden" aria-label="Primary navigation">
        {PRIMARY_ARCHIVE_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => clsx('archive-mobile-link', isActive && 'archive-mobile-link-active')}>
            <Icon /><span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <ArchiveCommandBar open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  )
}
