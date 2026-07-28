import {useEffect, useState} from 'react'
import {Toolbar} from '@fluentui/react-components'
import {
    CollectionsRegular,
    DataBarVerticalRegular,
    SearchRegular,
    SettingsRegular,
    TableRegular
} from '@fluentui/react-icons'
import {NavLink, Outlet, useLocation} from 'react-router-dom'
import clsx from 'clsx'
import ArchiveCommandBar from './ArchiveCommandBar'
import JohnJohnSignal from './JohnJohnSignal'
import {PRIMARY_ARCHIVE_DESTINATIONS} from './archiveNavigation'
import {useSettings} from '../contexts/SettingsContext'
import ShinyText from './reactbits/ShinyText'

const ICONS = {
    collection: CollectionsRegular,
    search: SearchRegular,
    sets: TableRegular,
    analytics: DataBarVerticalRegular,
    settings: SettingsRegular
}
export const PRIMARY_ARCHIVE_NAV = PRIMARY_ARCHIVE_DESTINATIONS.map((item) => ({...item, icon: ICONS[item.icon]}))

/**
 * The shortcut handler accepts Ctrl and Cmd alike, so the hint has to match
 * the keyboard in front of the reader rather than always claiming Ctrl.
 */
export function shortcutHint(platform = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    return /Mac|iPhone|iPad|iPod/.test(platform) ? '⌘ K' : 'Ctrl K'
}

export default function ArchiveShell() {
    const {t} = useSettings()
    const [commandOpen, setCommandOpen] = useState(false)
    const location = useLocation()

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
            <div className="archive-ambient" aria-hidden="true"/>
            {/* A plain div, not <aside>: this is a layout rail holding the wordmark,
          the nav and a status caption. As an <aside> it published a
          `complementary` landmark named for navigation it merely contains. */}
            <div className="archive-rail hidden lg:flex">
                <NavLink to="/collection" className="archive-wordmark" aria-label="John John's PC, Collection Overview"><span
                    aria-hidden="true">∞</span><strong><ShinyText text="John John's PC" speed={5}/></strong></NavLink>
                <nav className="archive-nav" aria-label={t('archive.primaryNav')}>
                    {PRIMARY_ARCHIVE_NAV.map(({to, label, icon: Icon, end}) => (
                        <NavLink key={to} to={to} end={end}
                                 className={({isActive}) => clsx('archive-nav-link', isActive && 'archive-nav-link-active')}>
                            <Icon/><span>{label}</span>
                        </NavLink>
                    ))}
                </nav>
                <div className="archive-rail-footer"><JohnJohnSignal
                    decorative/><span>{t('archive.keepingWatch')}</span></div>
            </div>
            <div className="archive-content">
                <Toolbar className="archive-toolbar">
                    {/* A plain button rather than ToolbarButton: this reads as a search
              field, and Fluent's subtle appearance sets its own background and
              border colour that no amount of specificity would displace. */}
                    <button
                        type="button"
                        className="archive-search-trigger"
                        onClick={() => setCommandOpen(true)}
                        aria-label={t('archive.search')}
                        aria-keyshortcuts="Control+K"
                        aria-haspopup="dialog"
                        aria-expanded={commandOpen}
                    >
                        <SearchRegular aria-hidden="true"/>
                        <span className="archive-search-label">Search archive</span>
                        {/* Hidden from assistive tech: aria-keyshortcuts already carries
                this, and reading it aloud made the button's name
                "Search archive Ctrl K". */}
                        <kbd className="archive-kbd" aria-hidden="true">{shortcutHint()}</kbd>
                    </button>
                    <div className="ml-auto"><JohnJohnSignal/></div>
                </Toolbar>
                <main className="archive-main">
                    <div key={location.pathname} className="archive-route-frame">
                        <Outlet/>
                    </div>
                </main>
            </div>
            <nav className="archive-mobile-nav lg:hidden" aria-label={t('archive.mobileNav')}>
                {PRIMARY_ARCHIVE_NAV.map(({to, label, icon: Icon, end}) => (
                    <NavLink key={to} to={to} end={end}
                             className={({isActive}) => clsx('archive-mobile-link', isActive && 'archive-mobile-link-active')}>
                        <Icon/><span>{label}</span>
                    </NavLink>
                ))}
            </nav>
            <ArchiveCommandBar open={commandOpen} onClose={() => setCommandOpen(false)}/>
        </div>
    )
}
