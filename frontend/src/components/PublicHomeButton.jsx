import { Link } from 'react-router-dom'
import { useSettings } from '../contexts/SettingsContext'

export default function PublicHomeButton() {
  const { t } = useSettings()

  return (
    <Link
      to="/u"
      aria-label={t('publicProfiles.directory')}
      className="fixed z-50 flex h-12 w-12 items-center justify-center rounded-full transition-all duration-200 hover:scale-110 active:scale-90"
      style={{
        bottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        left: 'max(1rem, env(safe-area-inset-left))',
        background: 'linear-gradient(180deg, #e3000b 50%, #f5f5f5 50%)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5), 0 0 0 2px rgba(0,0,0,0.8), 0 0 16px rgba(227,0,11,0.3)',
        border: '2px solid #111',
      }}
    >
      <span className="absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 bg-black" aria-hidden />
      <span className="z-10 flex h-4 w-4 items-center justify-center rounded-full border-2 border-black bg-white" aria-hidden>
        <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
      </span>
    </Link>
  )
}
