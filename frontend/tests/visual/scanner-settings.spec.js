import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'admin',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

const scannerConfiguration = {
  provider: 'gemini',
  model: 'gemini-flash-latest',
  status: 'ready',
  visual_verification: 'automatic',
  providers: [
    {
      id: 'gemini',
      label: 'Gemini',
      models: ['gemini-flash-latest'],
      default_model: 'gemini-flash-latest',
      selected_model: 'gemini-flash-latest',
      requires_api_key: true,
      api_key_configured: true,
      endpoint_type: 'hosted',
      key_help_url: 'https://aistudio.google.com/apikey',
      setup_help_url: 'https://github.com/Git-Romer/pokecollector/blob/main/docs/scanner-providers.md',
    },
    {
      id: 'openai',
      label: 'Local Ollama',
      models: ['vision-fast', 'vision-accurate'],
      default_model: 'vision-fast',
      selected_model: 'vision-fast',
      requires_api_key: false,
      api_key_configured: false,
      endpoint_type: 'custom',
      key_help_url: null,
      setup_help_url: 'https://github.com/Git-Romer/pokecollector/blob/main/docs/scanner-providers.md',
    },
  ],
  administrator: {
    setup_guide_url: 'https://github.com/Git-Romer/pokecollector/blob/main/docs/scanner-providers.md',
    providers: [
      {
        id: 'gemini', label: 'Gemini', enabled: true, endpoint_type: 'hosted',
        endpoint: 'Google Gemini API', models: ['gemini-flash-latest'], requires_api_key: true,
      },
      {
        id: 'openai', label: 'Local Ollama', enabled: true, endpoint_type: 'custom',
        endpoint: 'http://ollama:11434', models: ['vision-fast', 'vision-accurate'], requires_api_key: false,
      },
    ],
  },
}

async function installApi(page, user = USER) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'scanner-settings-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, user)

  let savedBody = null
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: user })
    if (path === '/api/settings/scanner' && request.method() === 'GET') {
      return route.fulfill({ json: scannerConfiguration })
    }
    if (path === '/api/settings/scanner' && request.method() === 'PUT') {
      savedBody = request.postDataJSON()
      const chosen = scannerConfiguration.providers.find(item => item.id === savedBody.provider)
      return route.fulfill({ json: {
        ...scannerConfiguration,
        provider: savedBody.provider,
        model: savedBody.model,
        status: 'ready',
        providers: scannerConfiguration.providers.map(item => ({
          ...item,
          selected_model: item.id === chosen.id ? savedBody.model : item.selected_model,
        })),
      } })
    }
    if (path === '/api/settings/scanner/test') return route.fulfill({ json: { status: 'ready' } })
    if (path === '/api/settings/') return route.fulfill({ json: {
      language: 'en', currency: 'EUR', price_primary: 'trend',
      price_display: '["trend"]', scan_diagnostics_available: 'false',
      scan_diagnostics_deletion_available: 'false',
    } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/profile/') return route.fulfill({ json: { is_profile_public: false, public_show_values: false } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.includes('contributors') || path.includes('supporters') || path.includes('custom-matches')) {
      return route.fulfill({ json: [] })
    }
    if (path.includes('donations')) return route.fulfill({ json: { total: 0, donations: [] } })
    if (path === '/api/users/') return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  return () => savedBody
}

test('guides provider selection and saves one guarded configuration', async ({ page }) => {
  const savedBody = await installApi(page)
  await page.goto('/settings')

  await expect(page.getByText('Card scanner', { exact: true })).toBeVisible()
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Scanner provider')).toHaveValue('gemini')
  await expect(page.getByLabel('Model')).toHaveCount(0)
  await expect(page.getByText('Cloud service. Card photos are sent to the provider', { exact: false })).toBeVisible()
  await expect(page.getByText('Your personal API key is required.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://aistudio.google.com/apikey')
  await expect(page.getByRole('link', { name: /Provider setup guide/ })).toHaveAttribute('href', /scanner-providers\.md/)
  await expect(page.getByText('Visual verification is automatic.', { exact: false })).toBeVisible()
  await expect(page.getByText('The connection test sends a tiny image', { exact: false })).toBeVisible()
  await expect(page.getByText('Server setup details', { exact: true })).toBeVisible()
  await expect(page.getByText('http://ollama:11434', { exact: false })).toBeHidden()
  await expect(page.getByText('Base URL', { exact: true })).toHaveCount(0)
  await page.getByText('Server setup details', { exact: true }).click()
  await expect(page.getByText('http://ollama:11434', { exact: false })).toBeVisible()

  await page.getByLabel('Scanner provider').selectOption('openai')
  await expect(page.getByText('Administrator-configured service.', { exact: false })).toBeVisible()
  await expect(page.getByText('No personal API key is required.')).toBeVisible()
  await expect(page.getByLabel('Model')).toBeEnabled()
  await page.getByLabel('Model').selectOption('vision-accurate')
  await page.getByRole('button', { name: 'Test and save' }).click()
  await expect(page.getByText('Scanner configuration saved')).toBeVisible()
  await expect(page.getByText('Last test in this session: connection ready.')).toBeVisible()

  await expect.poll(savedBody).toEqual({
    provider: 'openai',
    model: 'vision-accurate',
    api_key: null,
    clear_api_key: false,
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('uses the same test-and-save flow for Gemini', async ({ page }) => {
  const savedBody = await installApi(page)
  await page.route('**/api/settings/scanner', route => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ json: {
      ...scannerConfiguration,
      status: 'api_key_required',
      providers: scannerConfiguration.providers.map(item => item.id === 'gemini'
        ? { ...item, api_key_configured: false }
        : item),
    } })
  })
  await page.goto('/settings')

  await expect(page.getByText('API key required', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enter an API key to continue' })).toBeDisabled()
  await page.getByLabel('API key').fill('new-gemini-key')
  await page.getByRole('button', { name: 'Test and save' }).click()

  await expect.poll(savedBody).toEqual({
    provider: 'gemini',
    model: 'gemini-flash-latest',
    api_key: 'new-gemini-key',
    clear_api_key: false,
  })
  await expect(page.getByText('Last test in this session: connection ready.')).toBeVisible()
})

test('lets a user intentionally remove a configured key without a connection test', async ({ page }) => {
  const savedBody = await installApi(page)
  let testRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/settings/scanner/test') testRequests += 1
  })
  await page.goto('/settings')

  await page.getByRole('button', { name: 'Remove configured key' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect.poll(savedBody).toEqual({
    provider: 'gemini',
    model: 'gemini-flash-latest',
    api_key: null,
    clear_api_key: true,
  })
  expect(testRequests).toBe(0)
})

test('offers save without a successful test only after a provider failure', async ({ page }) => {
  const savedBody = await installApi(page)
  await page.route('**/api/settings/scanner/test', route => route.fulfill({
    status: 503,
    json: { detail: 'Provider temporarily unavailable.' },
  }))
  await page.goto('/settings')

  await page.getByLabel('Scanner provider').selectOption('openai')
  await page.getByRole('button', { name: 'Test and save' }).click()
  await expect(page.getByText('Last test in this session: connection failed.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save without a successful test' })).toBeVisible()
  expect(savedBody()).toBeNull()

  await page.getByRole('button', { name: 'Save without a successful test' }).click()
  await expect.poll(savedBody).toEqual({
    provider: 'openai',
    model: 'vision-fast',
    api_key: null,
    clear_api_key: false,
  })
})

test('does not expose providers the administrator left disabled', async ({ page }) => {
  await installApi(page)
  await page.route('**/api/settings/scanner', route => route.fulfill({ json: {
    ...scannerConfiguration,
    providers: [scannerConfiguration.providers[0]],
  } }))
  await page.goto('/settings')

  await expect(page.getByText('Card scanner', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Scanner provider')).toHaveCount(0)
  await expect(page.getByRole('option', { name: 'Local Ollama' })).toHaveCount(0)
})

test('keeps administrator-only server details away from normal users', async ({ page }) => {
  const trainer = { ...USER, username: 'trainer', role: 'trainer' }
  await installApi(page, trainer)
  await page.route('**/api/settings/scanner', route => route.fulfill({ json: {
    ...scannerConfiguration,
    administrator: undefined,
  } }))
  await page.goto('/settings')

  await expect(page.getByText('Card scanner', { exact: true })).toBeVisible()
  await expect(page.getByText('Server setup details', { exact: true })).toHaveCount(0)
  await expect(page.getByText('http://ollama:11434', { exact: false })).toHaveCount(0)
})
