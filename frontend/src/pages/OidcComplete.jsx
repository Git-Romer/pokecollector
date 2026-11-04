import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import toast from 'react-hot-toast'
import PokeBallLoader from '../components/PokeBallLoader'
import { completeOidcLogin } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { runOidcCompletion } from '../utils/oidcAuth'

export default function OidcComplete() {
  const { user, loginUser } = useAuth()
  const { t } = useSettings()
  const navigate = useNavigate()
  const [status, setStatus] = useState('working')
  const startedRef = useRef(false)

  useEffect(() => {
    // The handoff is one-use, so a development double-effect must not redeem it
    // twice. A page reload after a failure stays on the error screen instead of
    // starting an automatic retry loop.
    if (startedRef.current) return
    startedRef.current = true

    runOidcCompletion({ request: completeOidcLogin, loginUser })
      .then((result) => {
        if (result.kind === 'login') {
          navigate('/', { replace: true })
          return
        }
        // Linking never replaces the session. Return to the settings page that
        // started the flow so the new status is visible there.
        toast.success(t('auth.oidcLinkedMessage'))
        navigate('/settings', { replace: true })
      })
      .catch(() => {
        setStatus('error')
      })

    // The completion request must run exactly once for this page load;
    // StrictMode's setup/cleanup/setup cycle is intentionally not used to
    // cancel the only response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (status === 'error') {
    return (
      <main className="relative min-h-screen overflow-hidden bg-bg-primary px-4 py-10">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(227,0,11,0.18),_transparent_28%)]" />
        <div className="relative flex min-h-[calc(100vh-5rem)] items-center justify-center">
          <section
            className="w-full max-w-md rounded-[2rem] border border-border bg-bg-card p-6 text-center shadow-2xl sm:p-8"
            style={{ backgroundColor: 'rgba(26, 26, 46, 0.78)' }}
            aria-live="polite"
          >
            <ShieldAlert size={44} className="mx-auto text-brand-red" aria-hidden="true" />
            <h1 className="mt-4 text-2xl font-semibold text-text-primary">
              {t('auth.oidcCompleteFailedTitle')}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-text-muted">
              {t('auth.oidcCompleteFailedMessage')}
            </p>
            <Link to="/login" replace className="btn-primary mt-6 w-full">
              {t('auth.oidcBackToLogin')}
            </Link>
            {user && (
              <Link to="/settings" replace className="btn-ghost mt-3 w-full">
                {t('auth.oidcBackToSettings')}
              </Link>
            )}
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg-primary px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(227,0,11,0.18),_transparent_28%)]" />
      <div className="relative flex min-h-[calc(100vh-5rem)] items-center justify-center">
        <section
          className="w-full max-w-md rounded-[2rem] border border-border bg-bg-card p-6 text-center shadow-2xl sm:p-8"
          style={{ backgroundColor: 'rgba(26, 26, 46, 0.78)' }}
          aria-live="polite"
          aria-busy="true"
        >
          <PokeBallLoader size={48} />
          <h1 className="mt-5 text-2xl font-semibold text-text-primary">
            {t('auth.oidcCompletingTitle')}
          </h1>
          <p className="mt-2 text-sm text-text-muted">{t('auth.oidcCompletingMessage')}</p>
        </section>
      </div>
    </main>
  )
}
