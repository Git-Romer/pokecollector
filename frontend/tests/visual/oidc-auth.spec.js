import { expect, test } from '@playwright/test'

const admin = {
  id: 1,
  username: 'admin',
  role: 'admin',
  avatar_id: null,
  must_change_password: false,
}

const mixedMode = {
  multi_user: true,
  locked: true,
  auth_mode: 'mixed',
  password_login_enabled: true,
  oidc_enabled: true,
  oidc_display_name: 'Authelia',
}

const oidcOnlyMode = {
  multi_user: true,
  locked: true,
  auth_mode: 'oidc-only',
  password_login_enabled: false,
  oidc_enabled: true,
  oidc_display_name: 'Authelia',
}

async function mockApi(page, { mode = mixedMode, me = null, onRequest } = {}) {
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url())
    if (onRequest && await onRequest(route, url)) return

    if (url.pathname === '/api/auth/mode') {
      return route.fulfill({ json: mode })
    }
    if (url.pathname === '/api/auth/me') {
      return me
        ? route.fulfill({ json: me })
        : route.fulfill({ status: 401, json: { detail: 'Not authenticated' } })
    }
    if (url.pathname === '/api/auth/oidc/identity') {
      return route.fulfill({ json: { linked: false, display_name: 'Authelia', unlink_permitted: false } })
    }

    // Minimal settings/dashboard responses so navigation away from the login
    // flow renders without depending on a live backend.
    if (url.pathname === '/api/settings/') {
      return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    }
    if (url.pathname === '/api/settings/exchange-rate') {
      return route.fulfill({ json: { rate: 1 } })
    }
    if (url.pathname === '/api/settings/currencies') {
      return route.fulfill({ json: { currencies: [] } })
    }
    if (url.pathname === '/api/settings/scanner') {
      return route.fulfill({
        json: {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          request_timeout_seconds: 30,
          status: 'ready',
          visual_verification: 'enabled',
          providers: [{
            id: 'gemini',
            label: 'Google Gemini',
            endpoint_type: 'hosted',
            requires_api_key: true,
            api_key_configured: true,
            models: ['gemini-2.5-flash'],
            default_model: 'gemini-2.5-flash',
            custom_model: null,
            custom_model_allowed: false,
          }],
        },
      })
    }
    if (url.pathname.startsWith('/api/settings/') && url.pathname.split('/').length === 4) {
      return route.fulfill({ json: { value: 'false' } })
    }
    if (url.pathname === '/api/profile/') {
      return route.fulfill({ json: {} })
    }
    if (url.pathname === '/api/sync/status') {
      return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    }
    if (url.pathname === '/api/dashboard/') {
      return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    }
    if (url.pathname === '/api/cards/recognize/jobs') {
      return route.fulfill({ json: { jobs: [] } })
    }
    if (url.pathname === '/api/analytics/investment-tracker') {
      return route.fulfill({ json: [] })
    }
    if (url.pathname === '/api/github/contributors' || url.pathname === '/api/community/supporters') {
      return route.fulfill({ json: [] })
    }
    return route.fulfill({ json: {} })
  })
}

test('mixed mode offers password and provider sign-in, then completes through the fixed path', async ({ page }) => {
  const navigations = []
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  })

  await mockApi(page, {
    onRequest: async (route, url) => {
      if (url.pathname === '/api/auth/oidc/start') {
        // Playwright does not route the document reached by a fulfilled 302,
        // so the mock IdP redirect is a client-side meta refresh. This keeps
        // the subsequent /mock-idp navigation interceptable and still models a
        // top-level browser navigation away from the app.
        await route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><meta http-equiv="refresh" content="0;url=/mock-idp">',
        })
        return true
      }
      if (url.pathname === '/api/auth/oidc/complete') {
        await route.fulfill({ json: { access_token: 'app-token', user: admin } })
        return true
      }
      return false
    },
  })

  // Register after mockApi so this more specific navigation wins. The mock
  // document includes a charset: the link label contains a non-ASCII character
  // and must still match the accessible name in the test.
  await page.route(/\/mock-idp$/, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><meta charset="utf-8"><title>Mock provider</title><a href="/auth/oidc/complete">Continue to PokéCollector</a>',
  }))

  await page.goto('/login')

  await expect(page.getByLabel('Password')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in with Authelia' })).toBeVisible()

  await page.getByRole('link', { name: 'Sign in with Authelia' }).click()
  await expect(page).toHaveURL('/mock-idp')
  await page.getByRole('link', { name: 'Continue to PokéCollector' }).click()

  await expect(page.getByText('Hello,')).toBeVisible()
  await expect(page).toHaveURL('/')
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('app-token')

  const completionUrls = [...new Set(
    navigations.filter(url => new URL(url).pathname === '/auth/oidc/complete'),
  )]
  expect(completionUrls).toHaveLength(1)
  // The provider callback hands off through a cookie, never query parameters.
  expect(new URL(completionUrls[0]).search).toBe('')
})

test('OIDC-only mode shows no password form or user switcher', async ({ page }) => {
  await mockApi(page, { mode: oidcOnlyMode })

  await page.goto('/')

  await expect(page).toHaveURL('/login')
  await expect(page.getByRole('link', { name: 'Sign in with Authelia' })).toBeVisible()
  await expect(page.getByLabel('Password')).toHaveCount(0)
  await expect(page.getByLabel('Username')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Switch User' })).toHaveCount(0)
})

test('a failed completion keeps the existing local session', async ({ page }) => {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'valid-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, admin)

  await mockApi(page, {
    me: admin,
    onRequest: async (route, url) => {
      if (url.pathname === '/api/auth/oidc/complete') {
        await route.fulfill({ status: 401, json: { detail: 'Handoff expired' } })
        return true
      }
      return false
    },
  })

  await page.goto('/auth/oidc/complete')

  await expect(page.getByRole('heading', { name: 'Sign-in could not be completed' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('valid-token')
  expect(await page.evaluate(() => localStorage.getItem('user'))).toContain('admin')
  await expect(page).toHaveURL('/auth/oidc/complete')
})

test('a linked completion keeps the current token and returns to settings', async ({ page }) => {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'existing-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, admin)

  await mockApi(page, {
    me: admin,
    onRequest: async (route, url) => {
      if (url.pathname === '/api/auth/oidc/complete') {
        await route.fulfill({ json: { linked: true } })
        return true
      }
      if (url.pathname === '/api/auth/oidc/identity') {
        await route.fulfill({ json: { linked: true, display_name: 'Authelia', unlink_permitted: true } })
        return true
      }
      return false
    },
  })

  await page.goto('/auth/oidc/complete')

  await expect(page).toHaveURL('/settings')
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('existing-token')
  expect(await page.evaluate(() => localStorage.getItem('user'))).toContain('admin')
  await expect(page.getByText('Linked', { exact: true })).toBeVisible()
})

test('only allowlisted provider errors are explained, unknown values fall back', async ({ page }) => {
  await mockApi(page)
  await page.goto('/login?oidc_error=access_denied')
  await expect(page.getByRole('alert')).toContainText('Sign-in was cancelled at the identity provider.')

  await page.goto('/login?oidc_error=%3Cscript%3Eprovider%20detail%3C%2Fscript%3E')
  await expect(page.getByRole('alert')).toContainText('Sign-in could not be completed. Please try again.')
  await expect(page.getByRole('alert')).not.toContainText('provider detail')
})

// `constructor`, `__proto__` and `toString` are inherited by every plain
// object. A prototype-unsafe allowlist lookup returned them instead of a
// translation key, and the translation helper then called `.split` on a
// function/object and crashed the login page. Each one must fall back to the
// generic message without a page error or a console error.
for (const code of ['constructor', '__proto__', 'toString']) {
  test(`oidc_error=${code} falls back to the generic message without crashing`, async ({ page }) => {
    const consoleErrors = []
    const pageErrors = []
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', error => pageErrors.push(error.message))

    await mockApi(page)
    await page.goto(`/login?oidc_error=${encodeURIComponent(code)}`)

    // The generic message renders instead of the value being trusted.
    await expect(page.getByRole('alert')).toContainText('Sign-in could not be completed. Please try again.')
    // The rest of the form still rendered, so React did not crash.
    await expect(page.getByLabel('Password')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in with Authelia' })).toBeVisible()

    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  })
}

test('settings names AUTH_MODE as the pin when the mode is not local', async ({ page }) => {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'valid-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, admin)

  await mockApi(page, { me: admin, mode: mixedMode })

  await page.goto('/settings')

  await expect(page.getByText('Managed by the AUTH_MODE environment variable; change it there and restart.')).toBeVisible()
  await expect(page.getByText('Pinned by the USER_MODE environment variable; change it there and restart.')).toHaveCount(0)
})

test('an unavailable identity endpoint leaves settings explanatory rather than broken', async ({ page }) => {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'valid-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, admin)

  await mockApi(page, {
    me: admin,
    onRequest: async (route, url) => {
      if (url.pathname === '/api/auth/oidc/identity') {
        await route.fulfill({ status: 404, json: { detail: 'Not found' } })
        return true
      }
      return false
    },
  })

  await page.goto('/settings')

  await expect(page.getByText('Sign-in details are unavailable right now.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
})
