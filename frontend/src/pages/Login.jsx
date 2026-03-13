import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { User } from 'lucide-react'
import toast from 'react-hot-toast'
import { login } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

export default function Login() {
  const [lastUser] = useState(() => localStorage.getItem('lastUser') || '')
  const [lastUserAvatar] = useState(() => localStorage.getItem('lastUserAvatar') || '')
  const [showSwitchUser, setShowSwitchUser] = useState(() => !localStorage.getItem('lastUser'))
  const [username, setUsername] = useState(() => localStorage.getItem('lastUser') || '')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { user, loginUser } = useAuth()
  const { t } = useSettings()
  const navigate = useNavigate()

  if (user) {
    return <Navigate to="/" replace />
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

  return (
    <div className="relative min-h-screen overflow-hidden bg-bg-primary">
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
              {lastUser && !showSwitchUser ? t('auth.welcomeBack') : t('auth.login')}
            </h1>
            <p className="mt-2 text-sm text-text-muted">{t('auth.signInToCollection')}</p>
          </div>

          {lastUser && !showSwitchUser ? (
            <form onSubmit={handleSubmit} className="space-y-5">
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
                    <User size={40} className="text-text-primary" />
                  )}
                </div>
                <p className="mt-4 text-xl font-semibold text-text-primary">{lastUser}</p>
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-secondary">{t('auth.password')}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input w-full"
                  autoFocus
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading || !password}
                className="btn-primary w-full"
              >
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
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs text-text-secondary">{t('auth.username')}</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="input w-full"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-text-secondary">{t('auth.password')}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input w-full"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading || !username || !password}
                className="btn-primary w-full"
              >
                {loading ? t('auth.signingIn') : t('auth.login')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
