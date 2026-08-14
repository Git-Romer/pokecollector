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
    },
    {
      id: 'openai',
      label: 'OpenAI-compatible',
      models: ['vision-fast', 'vision-accurate'],
      default_model: 'vision-fast',
      selected_model: 'vision-fast',
      requires_api_key: false,
      api_key_configured: false,
    },
  ],
}

async function installApi(page) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'scanner-settings-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  let savedBody = null
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: USER })
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
  await expect(page.getByLabel('Model')).toBeDisabled()
  await expect(page.getByText('Visual verification is automatic.', { exact: false })).toBeVisible()
  await expect(page.getByText('Base URL', { exact: true })).toHaveCount(0)

  await page.getByLabel('Scanner provider').selectOption('openai')
  await expect(page.getByLabel('Model')).toBeEnabled()
  await page.getByLabel('Model').selectOption('vision-accurate')
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Scanner connection is ready')).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).click()

  await expect.poll(savedBody).toEqual({
    provider: 'openai',
    model: 'vision-accurate',
    api_key: null,
    clear_api_key: false,
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
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
  await expect(page.getByRole('option', { name: 'OpenAI-compatible' })).toHaveCount(0)
})
