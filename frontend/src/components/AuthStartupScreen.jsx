import { RefreshCw, WifiOff } from 'lucide-react'
import PokeBallLoader from './PokeBallLoader'
import { useSettings } from '../contexts/SettingsContext'

export default function AuthStartupScreen({ connectionError = false, onRetry }) {
  const { t } = useSettings()

  return (
    <main className="min-h-screen bg-bg-primary px-4 flex items-center justify-center">
      <section
        className="w-full max-w-md rounded-2xl border border-border bg-bg-card p-6 text-center shadow-xl sm:p-8"
        aria-live="polite"
      >
        {connectionError ? (
          <>
            <WifiOff size={44} className="mx-auto text-brand-red" aria-hidden="true" />
            <h1 className="mt-4 text-xl font-semibold text-text-primary">
              {t('auth.connectionTitle')}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-text-muted">
              {t('auth.connectionMessage')}
            </p>
            <button type="button" className="btn-primary mt-6 w-full" onClick={onRetry}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('auth.retryConnection')}
            </button>
          </>
        ) : (
          <>
            <PokeBallLoader size={48} />
            <h1 className="mt-5 text-xl font-semibold text-text-primary">
              {t('auth.startingTitle')}
            </h1>
            <p className="mt-2 text-sm text-text-muted">{t('auth.startingMessage')}</p>
          </>
        )}
      </section>
    </main>
  )
}
