import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ShieldAlert, ShieldCheck, User, X } from 'lucide-react'
import toast from 'react-hot-toast'
import AuthStartupScreen from '../components/AuthStartupScreen'
import { login } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { formatProviderLabel, oidcErrorTranslationKey, readOidcError } from '../utils/oidcAuth'

function SignInWithProvider({ label, provider, prominent = false }) {
  return (
    <a
      href="/api/auth/oidc/start"
      rel="nofollow"
      className={`btn-primary w-full ${prominent ? 'py-3 text-base' : ''}`}
    >
      <ShieldCheck size={prominent ? 20 : 18} aria-hidden="true" />
      <span>{formatProviderLabel(label, provider)}</span>
    </a>
  )
}

function MethodDivider({ label }) {
  return (
    <div className="relative flex items-center gap-3 py-1" aria-hidden="true">
      <span className="h-px flex-1 bg-white/10" />
      <span className="text-[10px] font-black uppercase tracking-[0.25em] text-text-muted">{label}</span>
      <span className="h-px flex-1 bg-white/10" />
    </div>
  )
}

export default function Login() {
  const [lastUser] = useState(() => localStorage.getItem('lastUser') || '')
  const [lastUserAvatar] = useState(() => localStorage.getItem('lastUserAvatar') || '')
  const [showSwitchUser, setShowSwitchUser] = useState(() => !localStorage.getItem('lastUser'))
  const [username, setUsername] = useState(() => localStorage.getItem('lastUser') || '')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const {
    user,
    loading: authLoading,
    connectionError,
    loginUser,
    multiUser,
    passwordLoginEnabled,
    oidcEnabled,
    oidcDisplayName,
    retryConnection,
  } = useAuth()
  const { t } = useSettings()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  if (authLoading) {
    return <AuthStartupScreen connectionError={connectionError} onRetry={retryConnection} />
  }

  if (user || !multiUser) {
    return <Navigate to="/" replace />
  }

  const oidcErrorCode = readOidcError(searchParams)
  const oidcErrorKey = oidcErrorCode ? oidcErrorTranslationKey(oidcErrorCode) : null
  const providerName = oidcDisplayName || t('auth.ssoDefaultName')
  const hasAnyMethod = passwordLoginEnabled || oidcEnabled
  const showLastUser = passwordLoginEnabled && lastUser && !showSwitchUser

  const dismissOidcError = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('oidc_error')
    setSearchParams(next, { replace: true })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)

    try {
      const data = await login(username, password)
      localStorage.setItem('lastUser', username)
      localStorage.setItem('lastUserAvatar', data.user.avatar_id || '')
      loginUser(data.access_token, data.user)
      navigate('/')
    } catch (err) {
      toast.error(err.response?.data?.detail || t('auth.loginFailed'))
    } finally {
      setLoading(false)
    }
  }

  const passwordForm = showLastUser ? (
    <form onSubmit={handleSubmit} method="post" action="/login" className="space-y-5">
      <div className="flex flex-col items-center text-center">
        <div
          className={`flex items-center justify-center rounded-full border border-white/10 bg-bg-primary shadow-[0_20px_50px_rgba(0,0,0,0.35)] ${
            lastUserAvatar ? 'h-28 w-28' : 'h-24 w-24'
          }`}
          style={{ backgroundColor: 'rgba(10, 10, 15, 0.82)' }}
        >
          {lastUserAvatar ? (
            <img
              src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${lastUserAvatar}.gif`}
              alt={`${lastUser} avatar`}
              className="w-16 h-16 pixelated"
            />
          ) : (
            <User size={40} className="text-text-primary" aria-hidden="true" />
          )}
        </div>
        <p className="mt-4 text-xl font-semibold text-text-primary">{lastUser}</p>
      </div>

      <input
        type="text"
        name="username"
        id="login-username-saved"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        tabIndex={-1}
        aria-label={t('auth.username')}
        className="sr-only"
      />

      <div>
        <label htmlFor="login-password-saved" className="mb-1 block text-xs text-text-secondary">
          {t('auth.password')}
        </label>
        <input
          name="password"
          id="login-password-saved"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input w-full"
          autoComplete="current-password"
          autoFocus
          required
        />
      </div>

      <button type="submit" disabled={loading || !password} className="btn-primary w-full">
        {loading ? t('auth.signingIn') : t('auth.login')}
      </button>

      <button
        type="button"
        onClick={() => {
          setShowSwitchUser(true)
          setUsername('')
          setPassword('')
        }}
        className="mx-auto block text-sm text-text-muted transition-colors hover:text-text-primary"
      >
        {t('auth.switchUser')}
      </button>
    </form>
  ) : (
    <form onSubmit={handleSubmit} method="post" action="/login" className="space-y-4">
      <div>
        <label htmlFor="login-username" className="mb-1 block text-xs text-text-secondary">
          {t('auth.username')}
        </label>
        <input
          name="username"
          id="login-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="input w-full"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
        />
      </div>

      <div>
        <label htmlFor="login-password" className="mb-1 block text-xs text-text-secondary">
          {t('auth.password')}
        </label>
        <input
          name="password"
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input w-full"
          autoComplete="current-password"
          required
        />
      </div>

      <button type="submit" disabled={loading || !username || !password} className="btn-primary w-full">
        {loading ? t('auth.signingIn') : t('auth.login')}
      </button>
    </form>
  )

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg-primary">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(227,0,11,0.18),_transparent_28%)]" />
      <div className="absolute inset-0 backdrop-blur-[2px]" />

      <div className="relative flex min-h-screen items-center justify-center p-4 sm:p-6">
        <div
          className="w-full max-w-md rounded-[2rem] border border-border bg-bg-card p-6 shadow-2xl backdrop-blur-xl sm:p-8"
          style={{ backgroundColor: 'rgba(26, 26, 46, 0.78)' }}
        >
          <div className="mb-8 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-text-muted">PokéCollector</p>
            <h1 className="mt-4 text-3xl font-semibold text-text-primary">
              {showLastUser ? t('auth.welcomeBack') : t('auth.login')}
            </h1>
            <p className="mt-2 text-sm text-text-muted">
              {oidcEnabled && !passwordLoginEnabled
                ? t('auth.oidcOnlySubtitle')
                : t('auth.signInToCollection')}
            </p>
          </div>

          {oidcErrorKey && (
            <div
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-xl border border-brand-red/30 bg-brand-red/10 px-3.5 py-3 text-left"
            >
              <ShieldAlert size={18} className="mt-0.5 flex-shrink-0 text-brand-red" aria-hidden="true" />
              <p className="flex-1 text-sm leading-snug text-text-primary">{t(oidcErrorKey)}</p>
              <button
                type="button"
                onClick={dismissOidcError}
                className="rounded-md p-0.5 text-text-muted transition-colors hover:text-text-primary"
                aria-label={t('common.close')}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          )}

          {!hasAnyMethod ? (
            <div className="py-2 text-center" role="status">
              <ShieldAlert size={36} className="mx-auto text-brand-red" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-semibold text-text-primary">{t('auth.noMethodsTitle')}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-muted">{t('auth.noMethodsMessage')}</p>
            </div>
          ) : (
            <>
              {passwordLoginEnabled && passwordForm}

              {passwordLoginEnabled && oidcEnabled && (
                <div className="mt-6">
                  <MethodDivider label={t('auth.or')} />
                </div>
              )}

              {oidcEnabled && (
                <div className={passwordLoginEnabled ? 'mt-5 space-y-3' : 'space-y-4'}>
                  {!passwordLoginEnabled && (
                    <div className="mb-5 flex flex-col items-center text-center">
                      <span className="grid h-16 w-16 place-items-center rounded-full border border-white/10 bg-bg-primary shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
                        <ShieldCheck size={30} className="text-brand-red" aria-hidden="true" />
                      </span>
                    </div>
                  )}
                  <SignInWithProvider
                    label={t('auth.signInWith')}
                    provider={providerName}
                    prominent={!passwordLoginEnabled}
                  />
                  <p className="text-center text-xs leading-relaxed text-text-muted">
                    {t('auth.providerRedirectNote')}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  )
}
