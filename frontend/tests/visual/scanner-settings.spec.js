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
      custom_model_allowed: true,
      custom_model: '',
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
      custom_model_allowed: true,
      custom_model: '',
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
  let testedBody = null
  let currentConfiguration = structuredClone(scannerConfiguration)
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: user })
    if (path === '/api/settings/scanner' && request.method() === 'GET') {
      const visible = user.role === 'admin'
        ? currentConfiguration
        : {
            ...currentConfiguration,
            administrator: undefined,
            providers: currentConfiguration.providers.map(({ custom_model_allowed, custom_model, ...item }) => item),
          }
      return route.fulfill({ json: visible })
    }
    if (path === '/api/settings/scanner' && request.method() === 'PUT') {
      savedBody = request.postDataJSON()
      const chosen = currentConfiguration.providers.find(item => item.id === savedBody.provider)
      currentConfiguration = {
        ...currentConfiguration,
        provider: savedBody.provider,
        model: savedBody.model,
        status: 'ready',
        providers: currentConfiguration.providers.map(item => ({
          ...item,
          selected_model: item.id === chosen.id ? savedBody.model : item.selected_model,
          custom_model: item.id === chosen.id && savedBody.custom_model ? savedBody.model : item.custom_model,
        })),
      }
      return route.fulfill({ json: currentConfiguration })
    }
    if (path === '/api/settings/scanner/test') {
      testedBody = request.postDataJSON()
      if (testedBody.save_on_success) {
        savedBody = testedBody
        const chosen = currentConfiguration.providers.find(item => item.id === testedBody.provider)
        currentConfiguration = {
          ...currentConfiguration,
          provider: testedBody.provider,
          model: testedBody.model,
          status: 'ready',
          providers: currentConfiguration.providers.map(item => ({
            ...item,
            selected_model: item.id === chosen.id ? testedBody.model : item.selected_model,
            custom_model: item.id === chosen.id && testedBody.custom_model ? testedBody.model : item.custom_model,
          })),
        }
      }
      return route.fulfill({ json: {
        status: 'ready',
        saved: Boolean(testedBody.save_on_success),
        visual_verification: true,
      } })
    }
    if (path === '/api/settings/') return route.fulfill({ json: {
      language: 'en', currency: 'EUR', price_primary: 'trend',
      price_display: '["trend"]', scan_diagnostics_available: 'false',
      scan_diagnostics_deletion_available: 'false',
    } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }] } })
    if (path === '/api/sets/') return route.fulfill({ json: [] })
    if (path === '/api/cards/custom') return route.fulfill({ json: [] })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/profile/') return route.fulfill({ json: { is_profile_public: false, public_show_values: false } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.includes('contributors') || path.includes('supporters') || path.includes('custom-matches')) {
      return route.fulfill({ json: [] })
    }
    if (path.includes('donations')) return route.fulfill({ json: { total: 0, donations: [] } })
    if (path === '/api/users/') return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  return {
    savedBody: () => savedBody,
    testedBody: () => testedBody,
  }
}

test('guides provider selection and saves one guarded configuration', async ({ page }) => {
  const api = await installApi(page)
  await page.goto('/settings')

  await expect(page.getByText('Card scanner', { exact: true })).toBeVisible()
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Scanner provider')).toHaveValue('gemini')
  await expect(page.getByRole('combobox', { name: /^Model/ })).toHaveCount(0)
  await expect(page.getByText('Cloud service. Card photos are sent to the provider', { exact: false })).toBeVisible()
  await expect(page.getByText('Your personal API key is required.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Get a key/ })).toHaveAttribute('href', 'https://aistudio.google.com/apikey')
  await expect(page.getByRole('link', { name: /Provider setup guide/ })).toHaveAttribute('href', /scanner-providers\.md/)
  await expect(page.getByText('Visual verification is automatic when', { exact: false })).toBeVisible()
  await expect(page.getByText('The connection test sends two tiny real images', { exact: false })).toBeVisible()
  await expect(page.getByText('Server setup details', { exact: true })).toBeVisible()
  await expect(page.getByText('http://ollama:11434', { exact: false })).toBeHidden()
  await expect(page.getByText('Base URL', { exact: true })).toHaveCount(0)
  await page.getByText('Server setup details', { exact: true }).click()
  await expect(page.getByText('http://ollama:11434', { exact: false })).toBeVisible()

  await page.getByLabel('Scanner provider').selectOption('openai')
  await expect(page.getByText('Retest required', { exact: true })).toBeVisible()
  await expect(page.getByText('Administrator-configured service.', { exact: false })).toBeVisible()
  await expect(page.getByText('No personal API key is required.')).toBeVisible()
  await expect(page.getByRole('combobox', { name: /^Model/ })).toBeEnabled()
  await expect(page.getByRole('combobox', { name: /^Model/ }).locator('option').first()).toHaveText('vision-fast · Recommended')
  await page.getByRole('combobox', { name: /^Model/ }).selectOption('vision-accurate')
  await page.getByRole('button', { name: 'Test and save' }).click()
  await expect(page.getByText('Scanner configuration saved')).toBeVisible()
  await expect(page.getByText('Last test in this session: connection ready.')).toBeVisible()

  await expect.poll(api.savedBody).toEqual({
    provider: 'openai',
    model: 'vision-accurate',
    api_key: null,
    clear_api_key: false,
    custom_model: false,
    save_on_success: true,
    accept_degraded_visual_verification: false,
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('uses the same test-and-save flow for Gemini', async ({ page }) => {
  const api = await installApi(page)
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

  await expect.poll(api.savedBody).toEqual({
    provider: 'gemini',
    model: 'gemini-flash-latest',
    api_key: 'new-gemini-key',
    clear_api_key: false,
    custom_model: false,
    save_on_success: true,
    accept_degraded_visual_verification: false,
  })
  await expect(page.getByText('Last test in this session: connection ready.')).toBeVisible()
})

test('lets a user intentionally remove a configured key without a connection test', async ({ page }) => {
  const api = await installApi(page)
  let testRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/settings/scanner/test') testRequests += 1
  })
  await page.goto('/settings')

  await page.getByRole('button', { name: 'Remove configured key' }).click()
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect.poll(api.savedBody).toEqual({
    provider: 'gemini',
    model: 'gemini-flash-latest',
    api_key: null,
    clear_api_key: true,
    custom_model: false,
    save_on_success: false,
    accept_degraded_visual_verification: false,
  })
  expect(testRequests).toBe(0)
})

test('keeps configuration unchanged after a provider test failure', async ({ page }) => {
  const api = await installApi(page)
  await page.route('**/api/settings/scanner/test', route => route.fulfill({
    status: 503,
    json: { detail: 'Provider temporarily unavailable.' },
  }))
  await page.goto('/settings')

  await page.getByLabel('Scanner provider').selectOption('openai')
  await page.getByRole('button', { name: 'Test and save' }).click()
  await expect(page.getByText('Last test in this session: connection failed.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save without a successful test' })).toHaveCount(0)
  expect(api.savedBody()).toBeNull()
})

test('lets only an administrator test and save a custom model', async ({ page }) => {
  const api = await installApi(page)
  await page.goto('/settings')

  await page.getByText('Advanced model', { exact: true }).click()
  await page.getByLabel('Use a custom model').check()
  await page.getByRole('textbox', { name: 'Model' }).fill('future-vision-model')
  await page.getByRole('button', { name: 'Test and save' }).click()

  await expect.poll(api.testedBody).toEqual({
    provider: 'gemini',
    model: 'future-vision-model',
    api_key: null,
    clear_api_key: false,
    custom_model: true,
    save_on_success: true,
    accept_degraded_visual_verification: false,
  })
  await expect.poll(api.savedBody).toEqual(api.testedBody())
  await expect(page.getByText('Scanner configuration saved')).toBeVisible()
})

test('does not offer an untested custom model save bypass', async ({ page }) => {
  const api = await installApi(page)
  await page.route('**/api/settings/scanner/test', route => route.fulfill({
    status: 502,
    json: { detail: 'Multi-image test failed.' },
  }))
  await page.goto('/settings')

  await page.getByText('Advanced model', { exact: true }).click()
  await page.getByLabel('Use a custom model').check()
  await page.getByRole('textbox', { name: 'Model' }).fill('untested-model')
  await page.getByRole('button', { name: 'Test and save' }).click()

  await expect(page.getByRole('button', { name: 'Save without a successful test' })).toHaveCount(0)
  expect(api.savedBody()).toBeNull()
})

test('requires an explicit administrator acknowledgment before saving limited mode', async ({ page }) => {
  const api = await installApi(page)
  let attempts = 0
  await page.route('**/api/settings/scanner/test', async route => {
    attempts += 1
    const body = route.request().postDataJSON()
    if (attempts <= 2) {
      expect(body.accept_degraded_visual_verification).toBe(false)
      return route.fulfill({ json: {
        status: 'degraded_confirmation_required',
        saved: false,
        visual_verification: false,
      } })
    }
    expect(body.accept_degraded_visual_verification).toBe(true)
    return route.fulfill({ json: {
      status: 'degraded',
      saved: true,
      visual_verification: false,
    } })
  })
  await page.goto('/settings')

  await page.getByLabel('Scanner provider').selectOption('openai')
  await page.getByRole('button', { name: 'Test and save' }).click()
  const acknowledgment = page.getByLabel(/I understand that this model cannot compare multiple images/)
  await expect(acknowledgment).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  await acknowledgment.check()
  await page.getByRole('combobox', { name: /^Model/ }).selectOption('vision-accurate')
  await expect(acknowledgment).toBeHidden()
  await expect(page.getByRole('button', { name: 'Test and save' })).toBeEnabled()
  await page.getByRole('button', { name: 'Test and save' }).click()
  await expect(acknowledgment).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  await acknowledgment.check()
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect.poll(() => attempts).toBe(3)
  await expect(page.getByText('Scanner configuration saved')).toBeVisible()
  expect(api.savedBody()).toBeNull()
})

test('shows a persistent warning for an active limited scanner model', async ({ page }) => {
  await installApi(page)
  await page.route('**/api/settings/scanner', route => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ json: {
      ...scannerConfiguration,
      provider: 'openai',
      model: 'vision-fast',
      visual_verification: 'disabled',
      providers: scannerConfiguration.providers.map(item => item.id === 'openai'
        ? { ...item, selected_model: 'vision-fast' }
        : item),
    } })
  })
  await page.goto('/settings')

  await expect(page.getByText('Limited scanner mode', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('AI comparison with reference images is disabled', { exact: false }).first()).toBeVisible()
  await page.getByRole('combobox', { name: /^Model/ }).selectOption('vision-accurate')
  await expect(page.getByText('Retest required', { exact: true })).toBeVisible()
  await expect(page.getByText('Limited scanner mode', { exact: true }).first()).toBeVisible()
})

test('shows the limited-mode warning inside the card scanner', async ({ page }) => {
  await installApi(page)
  await page.route('**/api/settings/scanner', route => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ json: {
      ...scannerConfiguration,
      provider: 'openai',
      model: 'vision-fast',
      visual_verification: 'disabled',
    } })
  })
  await page.goto('/search')

  await page.getByRole('button', { name: 'Scan card' }).click()
  await expect(page.getByText('Limited scanner mode', { exact: true })).toBeVisible()
  await expect(page.getByText('AI comparison with reference images is disabled', { exact: false })).toBeVisible()
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
  await page.goto('/settings')

  await expect(page.getByText('Card scanner', { exact: true })).toBeVisible()
  await expect(page.getByText('Server setup details', { exact: true })).toHaveCount(0)
  await expect(page.getByText('http://ollama:11434', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Advanced model', { exact: true })).toHaveCount(0)
})
