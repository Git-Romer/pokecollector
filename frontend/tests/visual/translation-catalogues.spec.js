import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const codes = ['en', 'de', 'zh', 'zh-cn', 'sv', 'fr', 'nl', 'es', 'es-mx', 'it', 'pt', 'pt-br', 'pt-pt', 'pl', 'ru', 'ja', 'ko', 'id', 'th', 'zh-tw', 'da']
const aliases = { 'zh-cn': 'zh', 'pt-br': 'pt', 'pt-pt': 'pt' }
const catalog = code => JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${aliases[code] || code}.json`, import.meta.url), 'utf8'))
const english = catalog('en')

for (const language of codes) {
  test(`${language} loads its catalogue and keeps English fallback for missing text`, async ({ page }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const user = { id: 1, username: 'Translation reader', role: 'trainer', is_active: true, must_change_password: false }
    await page.addInitScript(({ language, user }) => {
      localStorage.setItem('token', 'synthetic-translation-token')
      localStorage.setItem('user', JSON.stringify(user))
      localStorage.setItem('app_language', language)
    }, { language, user })
    const settings = { language, currency: 'EUR', hidden_set_ids: '[]', set_overview_filters: '{}' }
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname
      if (!path.startsWith('/api/')) return route.continue()
      if (path === '/api/settings/' && route.request().method() === 'PUT') {
        Object.assign(settings, route.request().postDataJSON())
      }
      const responses = {
        '/api/auth/mode': { multi_user: true }, '/api/auth/me': user,
        '/api/settings/': settings,
        '/api/settings/tcgdex-filter-languages': ['en', 'de'],
        '/api/sets/': [],
      }
      return route.fulfill({ json: responses[path] ?? [] })
    })
    await page.goto('/sets')
    const messages = catalog(language)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.sets.title)
    const ascending = messages.common.sortAscending || english.common.sortAscending
    const descending = messages.common.sortDescending || english.common.sortDescending
    // These newer labels are intentionally absent from many incomplete catalogues.
    const toggle = page.getByRole('button', { name: ascending, exact: true })
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(page.getByRole('button', { name: descending, exact: true })).toBeVisible()
    await expect.poll(() => JSON.parse(settings.set_overview_filters).sortOrder).toBe('asc')
    await page.waitForLoadState('networkidle')
    await page.reload()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.sets.title)
    await page.waitForLoadState('networkidle')
    expect(errors).toEqual([])
  })
}
