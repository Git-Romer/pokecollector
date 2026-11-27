import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Loader2, ShieldAlert, UserPlus } from 'lucide-react'
import toast from 'react-hot-toast'
import PokeBallLoader from '../components/PokeBallLoader'
import { completeOidcLogin } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { oidcUsernameErrorTranslationKey, runOidcCompletion } from '../utils/oidcAuth'

export default function OidcComplete() {
  const { user, loginUser, loading } = useAuth()
  const { t } = useSettings()
  const navigate = useNavigate()
  const [status, setStatus] = useState('working')
  const [username, setUsername] = useState('')
  const [nameError, setNameError] = useState(null)
  const startedRef = useRef(false)
  const submittingRef = useRef(false)
  const inputRef = useRef(null)
  const errorHeadingRef = useRef(null)

  function applyCompletion(result) {
    if (result.kind === 'username_required') {
      setStatus('username')
    } else if (result.kind === 'login') {
      navigate('/', { replace: true })
    } else {
      // Linking never replaces the session.
      toast.success(t('auth.oidcLinkedMessage'))
      navigate('/settings', { replace: true })
    }
  }

  useEffect(() => {
    // Preserve the single initial request through StrictMode's double effect.
    // A name prompt does not redeem the handoff; only a successful completion does.
    // A late anonymous bootstrap must not overwrite the session issued by
    // completion. Resolve startup first, then redeem the handoff exactly once.
    if (loading || startedRef.current) return
    startedRef.current = true

    runOidcCompletion({ request: completeOidcLogin, loginUser })
      .then(applyCompletion)
      .catch(() => setStatus('error'))

    // Do not cancel the only response during StrictMode setup/cleanup/setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loginUser])

  useEffect(() => {
    if (status === 'username') inputRef.current?.focus()
    if (status === 'error') errorHeadingRef.current?.focus()
  }, [status])

  async function handleSubmit(event) {
    event.preventDefault()
    if (submittingRef.current) return

    const chosenName = username.trim()
    const length = Array.from(chosenName).length
    if (length < 2 || length > 32) {
      setNameError('auth.oidcUsernameInvalid')
      inputRef.current?.focus()
      return
    }

    submittingRef.current = true
    setNameError(null)
    setStatus('submitting')
    try {
      const result = await runOidcCompletion({
        request: completeOidcLogin,
        loginUser,
        username: chosenName,
      })
      applyCompletion(result)
    } catch (error) {
      const errorKey = oidcUsernameErrorTranslationKey(error)
      if (errorKey) {
        setNameError(errorKey)
        setStatus('username')
      } else {
        setStatus('error')
      }
    } finally {
      submittingRef.current = false
    }
  }

  const isNaming = status === 'username' || status === 'submitting'
  const isSubmitting = status === 'submitting'

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg-primary px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(227,0,11,0.18),_transparent_28%)]" />
      <div className="relative flex min-h-[calc(100vh-5rem)] items-center justify-center">
        <section
          className="w-full max-w-md rounded-[2rem] border border-border bg-bg-card p-6 text-center shadow-2xl backdrop-blur-xl sm:p-8"
          style={{ backgroundColor: 'rgba(26, 26, 46, 0.78)' }}
          aria-labelledby="oidc-complete-title"
        >
          {isNaming ? (
            <>
              <p className="text-xs font-semibold uppercase tracking-[0.35em] text-text-muted">PokéCollector</p>
              <div className="mx-auto mt-6 flex h-14 w-14 items-center justify-center rounded-2xl border border-brand-red/20 bg-brand-red/10">
                <UserPlus size={26} className="text-brand-red" aria-hidden="true" />
              </div>
              <h1 id="oidc-complete-title" className="mt-5 text-2xl font-semibold text-text-primary">
                {t('auth.oidcUsernameTitle')}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {t('auth.oidcUsernameMessage')}
              </p>

              <form onSubmit={handleSubmit} noValidate className="mt-7 text-left" aria-busy={isSubmitting}>
                <label htmlFor="oidc-username" className="mb-2 block text-sm font-medium text-text-secondary">
                  {t('auth.username')}
                </label>
                <input
                  ref={inputRef}
                  id="oidc-username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={event => { setUsername(event.target.value); setNameError(null) }}
                  disabled={isSubmitting}
                  required
                  aria-invalid={Boolean(nameError)}
                  aria-describedby={`oidc-username-help${nameError ? ' oidc-username-error' : ''}`}
                  className={`input w-full disabled:opacity-60 ${nameError ? 'border-brand-red' : ''}`}
                />
                <p id="oidc-username-help" className="mt-2 text-xs leading-relaxed text-text-secondary">
                  {t('auth.oidcUsernameHelp')}
                </p>
                <div aria-live="polite" aria-atomic="true">
                  {nameError && (
                    <p id="oidc-username-error" className="mt-3 flex items-start gap-2 rounded-xl border border-brand-red/30 bg-brand-red/10 p-3 text-sm leading-relaxed text-text-primary">
                      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-brand-red" aria-hidden="true" />
                      <span>{t(nameError)}</span>
                    </p>
                  )}
                </div>
                <button type="submit" disabled={isSubmitting} className="btn-primary mt-6 w-full py-3">
                  {isSubmitting ? (
                    <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : null}
                  <span>{isSubmitting ? t('auth.oidcUsernameSubmitting') : t('auth.oidcUsernameSubmit')}</span>
                  {!isSubmitting && <ArrowRight size={18} aria-hidden="true" />}
                </button>
                <p role="status" className="sr-only">{isSubmitting ? t('auth.oidcUsernameSubmitting') : ''}</p>
              </form>
              <p className="mt-4 text-xs leading-relaxed text-text-secondary">{t('auth.oidcUsernameExpiry')}</p>
              <Link
                to="/login"
                replace
                aria-disabled={isSubmitting || undefined}
                tabIndex={isSubmitting ? -1 : undefined}
                onClick={event => { if (isSubmitting) event.preventDefault() }}
                className={`btn-ghost mt-3 w-full ${isSubmitting ? 'pointer-events-none opacity-50' : ''}`}
              >
                {t('auth.oidcBackToLogin')}
              </Link>
            </>
          ) : status === 'error' ? (
            <div aria-live="polite">
              <ShieldAlert size={44} className="mx-auto text-brand-red" aria-hidden="true" />
              <h1 id="oidc-complete-title" ref={errorHeadingRef} tabIndex={-1} className="mt-4 text-2xl font-semibold text-text-primary">
                {t('auth.oidcCompleteFailedTitle')}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
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
            </div>
          ) : (
            <div aria-live="polite" aria-busy="true">
              <PokeBallLoader size={48} />
              <h1 id="oidc-complete-title" className="mt-5 text-2xl font-semibold text-text-primary">
                {t('auth.oidcCompletingTitle')}
              </h1>
              <p className="mt-2 text-sm text-text-muted">{t('auth.oidcCompletingMessage')}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
