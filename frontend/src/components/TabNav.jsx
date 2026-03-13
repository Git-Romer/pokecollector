import { useNavigate, useLocation } from 'react-router-dom'

export default function TabNav({ tabs }) {
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <div className="flex border-b border-border overflow-x-auto scrollbar-none -mx-4 px-4 mb-4" style={{ WebkitOverflowScrolling: 'touch' }}>
      {tabs.map((tab) => {
        const active = location.pathname === tab.to || location.pathname.startsWith(`${tab.to}/`)
        return (
          <button
            key={tab.to}
            onClick={() => navigate(tab.to)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors border-b-2 flex-shrink-0 ${
              active
                ? 'border-brand-red text-brand-red'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {tab.icon && <tab.icon size={14} />}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
