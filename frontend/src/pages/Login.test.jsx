import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-router-dom', () => ({ Navigate: () => null, useNavigate: () => () => {} }))
vi.mock('react-hot-toast', () => ({ default: { error: () => {} } }))
vi.mock('../api/client', () => ({ login: () => {} }))
vi.mock('../components/AuthStartupScreen', () => ({ default: () => null }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false, multiUser: true, loginUser: () => {} }),
}))
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => ({ t: (key) => key }) }))

import Login from './Login'

function attrs(tag) {
  const out = {}
  for (const m of tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1].toLowerCase()] = m[2] ?? ''
  return out
}

function renderLogin(lastUser) {
  vi.stubGlobal('localStorage', { getItem: (k) => (k === 'lastUser' ? lastUser : null), setItem() {} })
  const html = renderToStaticMarkup(<Login />)
  const tags = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => attrs(m[0]))
  return {
    html,
    form: attrs(html.match(/<form\b[^>]*>/)[0]),
    username: tags.find((a) => a.autocomplete === 'username'),
    password: tags.find((a) => a.type === 'password'),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Login Password AutoFill markup (iOS home-screen app)', () => {
  for (const [label, lastUser] of [['username + password form', ''], ['welcome-back form', 'ash']]) {
    it(`${label} is a recognisable login form`, () => {
      const { html, form, username, password } = renderLogin(lastUser)
      expect(form.method).toBe('post')
      expect(form.action).toBeTruthy()
      expect(html).toContain('type="submit"')
      expect(username.name).toBe('username')
      expect(username.id).toBeTruthy()
      expect(username.autocapitalize).toBe('none')
      expect(username.autocorrect).toBe('off')
      expect(username.spellcheck).toBe('false')
      expect(password.name).toBe('password')
      expect(password.id).toBeTruthy()
      expect(password.autocomplete).toBe('current-password')
      expect(html).not.toMatch(/autocomplete="off"|readonly/i)
    })
  }

  it('welcome-back form still carries the saved username', () => {
    const { username } = renderLogin('ash')
    expect(username.value).toBe('ash')
  })
})

describe('password-change inputs', () => {
  it('use new-password / current-password', () => {
    const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('./Settings.jsx', import.meta.url), 'utf8')
    expect(app.match(/autoComplete="new-password"/g)).toHaveLength(2)
    expect(app).toContain('autoComplete="username"')
    expect(settings).toContain('autoComplete="current-password"')
    expect(settings.match(/autoComplete="new-password"/g)).toHaveLength(2)
  })
})
