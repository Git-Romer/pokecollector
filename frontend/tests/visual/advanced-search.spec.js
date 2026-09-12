import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'Search Reviewer',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

const SEARCH_CARD = {
  id: 'search-card_en',
  card_id: 'search-card_en',
  name: 'Rule Text Result',
  number: '001',
  set_id: 'search-set_en',
  set_name: 'Search Set',
  set_ref: { id: 'search-set_en', name: 'Search Set', abbreviation: 'SRC' },
  rarity: 'Rare Holo',
  supertype: 'Pokemon',
  types: ['Lightning'],
  attacks: [{ name: 'Helpful Draw', effect: 'Draw 3 cards.' }],
  variants_normal: true,
}

const OTHER_CARD = {
  ...SEARCH_CARD,
  id: 'other-card_en',
  card_id: 'other-card_en',
  name: 'Other Collection Card',
  number: '002',
  rarity: 'Common',
  attacks: [],
}

const collectionItem = (card, id) => ({
  id,
  card_id: card.id,
  quantity: 1,
  variant: 'Normal',
  condition: 'NM',
  lang: 'en',
  added_at: '2026-09-12T12:00:00',
  card,
})

async function installApi(page) {
  const requests = { search: [], collection: [] }

  await page.addInitScript(user => {
    localStorage.setItem('token', 'advanced-search-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()

    if (path.startsWith('/api/images/card/')) {
      return route.fulfill({ status: 404, json: { detail: 'No test artwork' } })
    }
    if (path === '/api/cards/search') {
      const ruleText = url.searchParams.get('rule_text')
      requests.search.push(ruleText)
      const cards = ruleText === 'draw 3 cards' ? [SEARCH_CARD] : []
      return route.fulfill({ json: { data: cards, total_count: cards.length, page: 1, page_size: 20 } })
    }
    if (path === '/api/collection/') {
      const ruleText = url.searchParams.get('rule_text')
      requests.collection.push(ruleText)
      if (ruleText === 'fail request') {
        return route.fulfill({ status: 503, json: { detail: 'Temporary search failure' } })
      }
      const items = ruleText && ruleText !== 'draw 3 cards'
        ? []
        : ruleText
          ? [collectionItem(SEARCH_CARD, 1)]
          : [collectionItem(SEARCH_CARD, 1), collectionItem(OTHER_CARD, 2)]
      return route.fulfill({ json: items })
    }

    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': USER,
      '/api/settings/': {
        language: 'en',
        price_primary: 'trend',
        price_display: '["trend"]',
        tcgdex_sync_languages: 'en',
        currency: 'EUR',
      },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/sets/': [{ id: 'search-set_en', name: 'Search Set', series: 'Review' }],
      '/api/cards/custom': [],
      '/api/cards/recognize/jobs': { jobs: [] },
      '/api/wishlist/': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })

  return requests
}

test('applies a complete Card Search filter draft only when saved', async ({ page }) => {
  const requests = await installApi(page)
  await page.goto('/search')

  await page.getByRole('button', { name: 'Filters' }).click()
  await expect(page.getByRole('heading', { name: 'Normal filters' })).toBeVisible()
  const advanced = page.getByRole('button', { name: 'Advanced filters' })
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#card-search-rule-text')).toHaveCount(0)

  await advanced.click()
  const ruleText = page.locator('#card-search-rule-text')
  await ruleText.pressSequentially('  draw 3 cards  ', { delay: 20 })
  await page.getByLabel('Rarity').selectOption('Rare Holo')

  await expect(ruleText).toHaveValue('  draw 3 cards  ')
  await expect(page).not.toHaveURL(/rule_text=/)
  expect(requests.search).toEqual([])

  await page.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page).toHaveURL(/rule_text=draw(?:\+|%20)3(?:\+|%20)cards/)
  await expect(page.getByRole('button', { name: 'Rule Text Result', exact: true })).toBeVisible()
  expect(requests.search).not.toHaveLength(0)
  expect(requests.search.every(value => value === 'draw 3 cards')).toBe(true)

  await page.getByRole('button', { name: 'Filters' }).click()
  await expect(page.getByRole('button', { name: 'Advanced filters' })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#card-search-rule-text')).toHaveValue('draw 3 cards')

  await page.locator('#card-search-rule-text').fill('stale draft')
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).not.toHaveURL(/rule_text=/)
  await page.goForward()
  await page.getByRole('button', { name: 'Filters' }).click()
  await expect(page.locator('#card-search-rule-text')).toHaveValue('draw 3 cards')
  const overflow = await page.locator('main').evaluate(main => Array.from(main.querySelectorAll('*'))
    .filter(element => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && (rect.right > document.documentElement.clientWidth + 1 || rect.left < -1)
    })
    .slice(0, 10)
    .map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.trim().slice(0, 60) })))
  expect(overflow).toEqual([])
})

test('keeps Collection advanced filters compact and ignores blank rule text', async ({ page }) => {
  const requests = await installApi(page)
  await page.goto('/collection')
  await expect(page.getByRole('button', { name: 'Rule Text Result', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Filter' }).click()
  await expect(page.getByRole('heading', { name: 'Normal filters' })).toBeVisible()
  const advanced = page.getByRole('button', { name: 'Advanced filters' })
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#collection-filter-rule-text')).toHaveCount(0)

  await page.locator('#collection-filter-rarity').selectOption('Common')
  await advanced.click()
  const initialRequests = requests.collection.length
  const ruleText = page.locator('#collection-filter-rule-text')
  await ruleText.fill('   ')
  await page.waitForTimeout(400)
  expect(requests.collection).toHaveLength(initialRequests)

  await ruleText.pressSequentially('draw 3 cards', { delay: 20 })
  await expect.poll(() => requests.collection.at(-1)).toBe('draw 3 cards')
  await expect(page.locator('#collection-filter-rarity')).toHaveValue('Common')
  await page.locator('#collection-filter-rarity').selectOption('Rare Holo')
  await expect(page.getByRole('button', { name: 'Rule Text Result', exact: true })).toBeVisible()
  expect(requests.collection.filter(Boolean).every(value => value === 'draw 3 cards')).toBe(true)

  await ruleText.fill('fail request')
  await expect(page.getByRole('alert')).toContainText('Please try again')
  expect(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})
