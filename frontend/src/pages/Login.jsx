import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { login } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

export default function Login() {
  const [username, setUsername] = useState('')
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
      loginUser(data.access_token, data.user)
      navigate('/')
    } catch (err) {
      toast.error(err.response?.data?.detail || t('auth.loginFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm bg-bg-card border border-border rounded-xl p-6 shadow-xl">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-text-primary">PokéCollector</h1>
          <p className="text-text-muted text-sm mt-1">{t('auth.signInToCollection')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{t('auth.username')}</label>
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
            <label className="text-xs text-text-secondary mb-1 block">{t('auth.password')}</label>
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
      </div>
    </div>
  )
}
