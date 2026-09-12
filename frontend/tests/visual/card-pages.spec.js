import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'Visual Reviewer',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

const card = (index, overrides = {}) => ({
  id: `visual-card-${index}`,
  card_id: `visual-card-${index}`,
  name: index === 2 ? 'Pikachu with a deliberately long aligned card name' : `Visual card ${index}`,
  number: String(index).padStart(3, '0'),
  set_id: 'visual-set_en',
  set_name: 'Visual Set',
  set_ref: { id: 'visual-set_en', name: 'Visual Set', abbreviation: 'VIS' },
  rarity: index % 2 ? 'Illustration Rare' : 'Rare Holo',
  supertype: 'Pokemon',
  types: ['Lightning'],
  price_market: 4 + index,
  price_trend: 4 + index,
  variants_normal: true,
  variants_reverse: true,
  ...overrides,
})

const collection = Array.from({ length: 8 }, (_, offset) => {
  const index = offset + 1
  const variant = index % 3 === 0 ? 'Reverse Holo' : index % 2 === 0 ? 'Holo' : 'Normal'
  return {
    id: index,
    card_id: `visual-card-${index}`,
    quantity: index % 3 + 1,
    variant,
    condition: index % 2 ? 'NM' : 'Mint',
    lang: index % 4 === 0 ? 'de' : 'en',
    purchase_price: 2 + index / 2,
    added_at: `2026-07-${String(20 + index).padStart(2, '0')}T12:00:00`,
    card: card(index, index === 1 ? {
      custom_image_url: 'https://example.test/manual-card.webp',
    } : index === 2 ? {
      supertype: 'Trainer',
    } : index === 3 ? {
      supertype: 'Energy',
    } : index === 4 ? {
      set_id: 'second-set_en',
      set_name: 'Second Set',
      set_ref: { id: 'second-set_en', name: 'Second Set', abbreviation: 'SEC' },
    } : {}),
  }
})

const duplicates = collection.map(item => ({
  ...item.card,
  id: item.card_id,
  quantity: item.quantity + 1,
  total_value: (item.card.price_market || 0) * (item.quantity + 1),
}))

const deck = {
  id: 1,
  name: 'Visual Practice Deck',
  target_size: 40,
  description: 'A visual deck fixture',
  current_card_count: 24,
  remaining_to_target: 16,
  over_target_by: 0,
  missing_copy_count: 1,
  status: 'under',
  composition_counts: { Pokemon: 8, Trainer: 10, Energy: 6, Other: 0 },
  entries: [
    { id: 1, card_id: 'visual-card-1', required_quantity: 8, owned_quantity: 8, shortage: 0, card: card(1, { supertype: 'Pokemon' }) },
    { id: 2, card_id: 'visual-card-2', required_quantity: 10, owned_quantity: 9, shortage: 1, card: card(2, { supertype: 'Trainer' }) },
    { id: 3, card_id: 'visual-card-3', required_quantity: 6, owned_quantity: 6, shortage: 0, card: card(3, { supertype: 'Energy' }) },
  ],
  copy_limit_warnings: [{ name: 'Ultra Ball', quantity: 5 }],
  format: 'Casual',
  validation: {
    valid: false,
    errors: [{ code: 'deck_size', status: 'fail', severity: 'error', message: 'Deck contains 24 of 40 cards.', details: { current: 24, target: 40 } }, { code: 'basic_pokemon', status: 'pass', severity: 'error', message: 'Deck contains a Basic Pokemon.', details: { count: 1 } }],
    warnings: [{ code: 'ownership', status: 'fail', severity: 'warning', message: 'Missing 1 copies from your collection.', details: { missing: 1, cards: [{ entry_id: 2, name: 'Visual card 2', missing: 1 }] } }],
    checks: [{ code: 'deck_size', status: 'fail', severity: 'error', message: 'Deck contains 24 of 40 cards.', details: { current: 24, target: 40 } }, { code: 'basic_pokemon', status: 'pass', severity: 'error', message: 'Deck contains a Basic Pokemon.', details: { count: 1 } }, { code: 'copy_limit', status: 'fail', severity: 'error', message: 'One or more cards exceed the 4-copy limit.', details: { violations: [{ name: 'Visual card 1', quantity: 8 }] } }, { code: 'ownership', status: 'fail', severity: 'warning', message: 'Missing 1 copies from your collection.', details: { missing: 1, cards: [{ entry_id: 2, name: 'Visual card 2', missing: 1 }] } }],
  },
  analysis: {
    composition: { total_cards: 24, pokemon_count: 8, trainer_count: 10, energy_count: 6, other_count: 0, pokemon_percent: 33.333, trainer_percent: 41.667, energy_percent: 25, other_percent: 0 },
    pokemon: { stages: { Basic: 8, 'Stage 1': 0, 'Stage 2': 0, other_unknown: 0 }, types: { Lightning: 8 }, hp: { count: 8, min: 60, max: 60, average: 60, median: 60, missing_hp: 0 }, retreat: { count: 8, min: 1, max: 1, average: 1, median: 1, distribution: { 0: 0, 1: 8, 2: 0, '3+': 0 }, missing_retreat: 0 } },
    trainers: { Item: 10, Supporter: 0, Stadium: 0, Tool: 0, other_unknown: 0 },
    energy: { basic: 6, special: 0, other_unknown: 0, types: { Lightning: 6 } },
    attacks: { fixed_attack_count: 8, variable_attack_count: 1, non_damage_attack_count: 1, unknown_attack_count: 0, unparseable_attack_count: 0, fixed_damage: { count: 8, min: 30, max: 30, average: 30, median: 30 }, cost_distribution: { 0: 0, 1: 8, 2: 0, 3: 0, '4+': 0, unknown: 0 } },
    diversity: { total_cards: 24, unique_printings: 3, unique_card_names: 3 },
    effects: {
      coverage: { draw: { cards: 4, unique_sources: 1, sources: [{ card_id: 'research', name: "Professor's Research", quantity: 4 }] }, pokemon_search: { cards: 7, unique_sources: 2, sources: [{ card_id: 'ultra', name: 'Ultra Ball', quantity: 4 }, { card_id: 'nest', name: 'Nest Ball', quantity: 3 }] }, discard: { cards: 8, unique_sources: 2, sources: [{ card_id: 'ultra', name: 'Ultra Ball', quantity: 4 }, { card_id: 'research', name: "Professor's Research", quantity: 4 }] }, switching: { cards: 0, unique_sources: 0, sources: [] } },
      outs: { draw_outs: { cards: 4, unique_sources: 1, sources: [{ card_id: 'research', name: "Professor's Research", quantity: 4 }] }, pokemon_search_outs: { cards: 7, unique_sources: 2, sources: [{ card_id: 'ultra', name: 'Ultra Ball', quantity: 4 }, { card_id: 'nest', name: 'Nest Ball', quantity: 3 }] }, energy_access_outs: { cards: 0, unique_sources: 0, sources: [] }, switching_outs: { cards: 0, unique_sources: 0, sources: [] }, recovery_outs: { cards: 0, unique_sources: 0, sources: [] } },
      unclassified_cards: { cards: 13, unique_sources: 2 },
    },
  },
}

const deckSummary = { ...deck, entries: [], copy_limit_warnings: [] }
const deckSummaries = [
  deckSummary,
  { ...deckSummary, id: 2, name: 'Complete Deck', current_card_count: 40, remaining_to_target: 0, status: 'complete', composition_counts: { Pokemon: 12, Trainer: 15, Energy: 13, Other: 0 }, validation: { valid: true, errors: [], warnings: [], checks: [] } },
  { ...deckSummary, id: 3, name: 'Over Deck', current_card_count: 41, remaining_to_target: 0, over_target_by: 1, status: 'over', composition_counts: { Pokemon: 12, Trainer: 15, Energy: 14, Other: 0 } },
  { ...deckSummary, id: 4, name: 'Large Over Deck', current_card_count: 55, remaining_to_target: 0, over_target_by: 15, status: 'over', composition_counts: { Pokemon: 26, Trainer: 15, Energy: 14, Other: 0 } },
]

const trades = [{
  id: 7,
  partner_name: 'Misty',
  trade_date: '2026-08-08',
  notes: 'Original trade note',
  outgoing_value: 9,
  incoming_value: 14,
  value_delta: 5,
  items: [
    {
      id: 71,
      trade_id: 7,
      direction: 'outgoing',
      card_id: collection[0].card_id,
      original_collection_item_id: collection[0].id,
      quantity: 1,
      value_per_card: 9,
      value_total: 9,
      card_name: collection[0].card.name,
      set_id: collection[0].card.set_id,
      card_number: collection[0].card.number,
      variant: collection[0].variant,
      condition: collection[0].condition,
      lang: collection[0].lang,
      notes: 'Outgoing note',
      card: collection[0].card,
    },
    {
      id: 72,
      trade_id: 7,
      direction: 'incoming',
      card_id: collection[1].card_id,
      created_collection_item_id: collection[1].id,
      quantity: 1,
      value_per_card: 14,
      value_total: 14,
      card_name: collection[1].card.name,
      set_id: collection[1].card.set_id,
      card_number: collection[1].card.number,
      variant: collection[1].variant,
      condition: collection[1].condition,
      lang: collection[1].lang,
      card: collection[1].card,
    },
  ],
}]

async function installApiFixtures(page) {
  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  let assemblyProgress = []

  await page.addInitScript(user => {
    localStorage.setItem('token', 'visual-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname

    // The Vite source path /src/api/client.js also matches the broad glob.
    // Only mock actual backend requests.
    if (!path.startsWith('/api/')) {
      await route.continue()
      return
    }

    if (path.startsWith('/api/images/card/')) {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
      return
    }

    if (path === '/api/decks/1/assembly-progress') {
      if (route.request().method() === 'PUT') {
        const next = route.request().postDataJSON()
        assemblyProgress = assemblyProgress.filter(item => item.entry_id !== next.entry_id).concat(next)
      } else if (route.request().method() === 'DELETE') {
        assemblyProgress = []
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().method() === 'DELETE' ? { message: 'reset' } : route.request().method() === 'PUT' ? assemblyProgress.at(-1) : assemblyProgress) })
      return
    }

    if (path === '/api/decks/1/probability') {
      const selected = url.searchParams.get('card_name')
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        deck_size: 24,
        opening_hand_size: Number(url.searchParams.get('hand') || 7),
        subsequent_draws: Number(url.searchParams.get('draws') || 0),
        cards_seen: Number(url.searchParams.get('hand') || 7) + Number(url.searchParams.get('draws') || 0),
        prize_count: Number(url.searchParams.get('prize_count') || 6),
        basic_pokemon: { count: 8, at_least_one: 0.95, none: 0.05 },
        outs: { draw_outs: { count: 4, opening_probability: 0.75, cards_seen_probability: 0.82 }, pokemon_search_outs: { count: 7, opening_probability: 0.91, cards_seen_probability: 0.96 }, energy_access_outs: { count: 0, opening_probability: 0, cards_seen_probability: 0 }, switching_outs: { count: 0, opening_probability: 0, cards_seen_probability: 0 }, recovery_outs: { count: 0, opening_probability: 0, cards_seen_probability: 0 } },
        key_card: selected ? { name: selected, copies: 4, opening_probability: 0.75, cards_seen_probability: 0.82, prize_risk: { at_least_one: 0.7, all_copies: 0.01, expected_copies: 1 } } : null,
      }) })
      return
    }

    if (path === '/api/decks/compare') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        decks: { left: deck, right: { ...deck, id: 2, name: 'Complete Deck', current_card_count: 40, validation: { valid: true, errors: [], warnings: [], checks: [] } } },
        cards: { changes: [{ name: 'Visual card 1', left: 8, right: 6, delta: -2, status: 'changed', printings: { left: [], right: [] } }, { name: 'Ultra Ball', left: 0, right: 2, delta: 2, status: 'added', printings: { left: [], right: [] } }] },
        composition: [{ metric: 'Pokemon', left: 8, right: 6, delta: -2 }, { metric: 'Trainer', left: 10, right: 12, delta: 2 }],
        validation: { left: deck.validation, right: { valid: true, errors: [], warnings: [], checks: [] }, changes: [{ code: 'deck_size', left: { status: 'fail' }, right: { status: 'pass' } }] },
        ownership: { left: 1, right: 0, delta: -1 },
        effects: { left: deck.analysis.effects, right: deck.analysis.effects, changes: [{ metric: 'draw', left: 4, right: 6, delta: 2 }] },
        probability: { left: { basic_pokemon: { at_least_one: 0.7 }, key_card: { copies: 2, opening_probability: 0.22 } }, right: { basic_pokemon: { at_least_one: 0.8 }, key_card: { copies: 4, opening_probability: 0.4 } } },
      }) })
      return
    }

    if (path === '/api/decks/allocation/export.csv') {
      const mode = url.searchParams.get('mode') || 'all'
      const filename = mode === 'free' ? 'pokecollector-free-inventory-2026-08-27.csv' : mode === 'conflicts' ? 'pokecollector-inventory-conflicts-2026-08-27.csv' : 'pokecollector-inventory-2026-08-27.csv'
      await route.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${filename}"` }, body: 'card_id,name\nvisual-card-1,"Pikachu, Pokémon"\n' })
      return
    }

    if (path === '/api/decks/allocation') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary: { reserved_decks: 1, conflicting_cards: 1, missing_copies: 1 }, items: [{ card_id: 'visual-card-1', name: 'Visual card 1', owned: 3, reserved: 4, free: 0, shortage: 1, decks: [{ deck_id: 1, name: 'Visual Practice Deck', quantity: 4 }] }] }) })
      return
    }

    if (path === '/api/decks/1/duplicate') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...deck, id: 99, name: 'Visual Practice Deck (Copy)' }) })
      return
    }

    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': USER,
      '/api/settings/': {
        language: 'en',
        price_primary: 'trend',
        price_display: '["trend","avg","avg1","avg7","avg30","low"]',
        tcgdex_sync_languages: 'en,de',
        currency: 'EUR',
      },
      '/api/settings/tcgdex-filter-languages': ['en', 'de'],
      '/api/collection/': collection,
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/analytics/duplicates': duplicates,
      '/api/analytics/top-movers': [],
      '/api/analytics/rarity-stats': [],
      '/api/analytics/investment-tracker': [],
      '/api/analytics/trades-summary': { trade_count: 0 },
      '/api/analytics/new-sets': [],
      '/api/products/': [],
      '/api/trades/': trades,
      '/api/decks/': deckSummaries,
      '/api/decks/1': deck,
      '/api/decks/99': { ...deck, id: 99, name: 'Visual Practice Deck (Copy)' },
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] ?? {}),
    })
  })
}

async function expectVisibleArtwork(page) {
  const artwork = page.locator('.unified-card-compact-artwork:visible')
  await expect(artwork.first()).toBeVisible()
  await expect.poll(async () => artwork.locator('img').evaluateAll(images => (
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)
  ))).toBe(true)
  await expect(artwork.locator('.unified-card-skeleton')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await installApiFixtures(page)
})

test('deck assembly supports desktop and mobile pulled-copy workflow', async ({ page }) => {
  await page.goto('/decks/1/build')
  await expect(page.getByRole('heading', { name: 'Build Deck: Visual Practice Deck' })).toBeVisible()
  await expect(page.getByText('2 validation errors')).toBeVisible()
  await expect(page.getByText('Missing Cards')).toBeVisible()
  await page.getByRole('button', { name: 'Add pulled copy' }).first().click()
  await expect(page.getByRole('progressbar', { name: 'Pulled progress' })).toHaveAttribute('aria-valuenow', '1')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Add pulled copy' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Mark all owned copies pulled' }).first().click()
  await expect(page.getByRole('button', { name: 'Remove pulled copy' }).first()).toBeVisible()
})

test('deck editor expands structured validation details', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('button', { name: /Deck Validation/ }).click()
  await expect(page.getByText('Visual card 1: 8')).toBeVisible()
  await expect(page.getByText('Visual card 2: 1 Missing')).toBeVisible()
})

test('deck editor renders quantity-weighted analytics on desktop and mobile', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await expect(page.getByText('Card diversity')).toBeVisible()
  await expect(page.getByText('24')).toBeVisible()
  await page.getByRole('tab', { name: 'Pokemon' }).click()
  await expect(page.getByText('Lightning')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: 'Attacks' }).click()
  await expect(page.getByText('Fixed-damage attacks')).toBeVisible()
})

test('deck analytics consistency shows non-zero effects and expandable sources', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await page.getByRole('tab', { name: 'Consistency' }).click()
  await expect(page.getByText('Functional Coverage')).toBeVisible()
  await expect(page.getByText('Switching', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /Pokemon Search.*7 cards.*2 sources/ }).first().click()
  await expect(page.getByText('Ultra Ball')).toBeVisible()
})

test('deck analytics probability calculates opening, outs, key-card, and prize views', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await page.getByRole('tab', { name: 'Probability' }).click()
  await expect(page.getByText('Basic Pokemon')).toBeVisible()
  await expect(page.getByText('95.0%')).toBeVisible()
  await page.getByLabel('Key card').selectOption({ label: 'Visual card 1' })
  await expect(page.getByText('Prize risk')).toBeVisible()
  await page.getByLabel('Extra draws').fill('2')
  await expect(page.getByText('Cards seen').first()).toBeVisible()
})

test('deck comparison presents card deltas and compact mobile-safe sections', async ({ page }) => {
  await page.goto('/decks/compare?left=1&right=2')
  await expect(page.getByText('Card Changes')).toBeVisible()
  await expect(page.locator('section').filter({ hasText: 'Card Changes' }).locator('span').filter({ hasText: 'Visual card 1' })).toBeVisible()
  await expect(page.getByText('Composition')).toBeVisible()
  await expect(page.getByText('Ownership & Validation')).toBeVisible()
  await page.getByLabel('Show unchanged').check()
  await page.getByLabel('Key card').selectOption('Visual card 1')
  await expect(page.getByText('Copies: 2 → 4; Opening 7: 22.0% → 40.0%')).toBeVisible()
})

test('deck editor duplicates a deck into an independent editor route', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('button', { name: 'Duplicate' }).click()
  await page.waitForURL('**/decks/99')
  await expect(page.locator('input[name="name"]')).toHaveValue('Visual Practice Deck (Copy)')
})

test('deck inventory export menu downloads server-named CSV files', async ({ page }) => {
  await page.goto('/decks')
  await page.getByRole('button', { name: 'Export Inventory CSV' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'All inventory' }).click()
  await expect((await download).suggestedFilename()).toBe('pokecollector-inventory-2026-08-27.csv')
  await page.goto('/decks/inventory')
  await page.getByRole('button', { name: 'Export Inventory CSV' }).click()
  const conflicts = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Conflicts only' }).click()
  await expect((await conflicts).suggestedFilename()).toBe('pokecollector-inventory-conflicts-2026-08-27.csv')
})

test('real Collection list keeps shared artwork, identity, and fallback treatment', async ({ page }) => {
  await page.goto('/collection')
  await page.getByTitle('List view').click()
  await expectVisibleArtwork(page)

  await expect(page.locator(
    '.unified-card-frame[style*="--pc-card-border-image"]:visible',
  ).first()).toBeVisible()
  await expect(page.locator('main')).toHaveScreenshot('collection-list.png')
})

test('real Analytics duplicate list stays visually aligned with Collection', async ({ page }) => {
  await page.goto('/analytics')
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()
  await expectVisibleArtwork(page)
  await expect(page.locator('main')).toHaveScreenshot('analytics-duplicates.png')
})

test('trade history opens a prefilled edit draft and submits immutable values', async ({ page }) => {
  await page.goto('/trades')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('Misty')).toBeVisible()
  await page.getByRole('button', { name: 'Edit' }).click()

  await expect(page.locator('input[placeholder="Trade partner"]')).toHaveValue('Misty')
  await expect(page.getByText('Edit: #7')).toBeVisible()
  await expect(page.locator('input[type="number"]:disabled')).toHaveCount(2)

  // Adding the same card again must create a new row. The backend then gives
  // that row a current-value snapshot instead of extending the historical row.
  await page.getByRole('button', { name: 'Add' }).first().click()

  // The mobile review shortcut must not cover the final fields or save action.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByRole('button', { name: 'Review trade' })).toBeVisible()
  await page.locator('#trade-finalize').scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Review trade' })).toBeHidden()

  const updateRequest = page.waitForRequest(request => (
    request.method() === 'PUT' && request.url().endsWith('/api/trades/7?price_field=price_trend')
  ))
  await page.locator('#trade-finalize').getByRole('button', { name: 'Save' }).click()
  const request = await updateRequest
  const payload = request.postDataJSON()

  expect(payload.outgoing[0]).toMatchObject({ trade_item_id: 71, quantity: 1, notes: 'Outgoing note' })
  expect(payload.outgoing[1]).toMatchObject({ collection_item_id: collection[0].id, quantity: 1 })
  expect(payload.outgoing).toHaveLength(2)
  expect(payload.incoming[0]).toMatchObject({ trade_item_id: 72, quantity: 1 })
  expect(payload.outgoing[0]).not.toHaveProperty('value_per_card')
  expect(payload.incoming[0]).not.toHaveProperty('value_per_card')
})

test('Deck editor presents a segmented gallery and keyboard-navigable viewer', async ({ page }) => {
  await page.goto('/decks/1')
  await expect(page.getByLabel('Deck composition').first()).toBeVisible()
  await expect(page.getByText('Pokemon 8')).toBeVisible()
  await expect(page.getByText('Trainer 10')).toBeVisible()
  await expect(page.getByText('Energy 6')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Visual card 1' })).toHaveCount(1)
  await expect(page.getByText('Missing: 1')).toBeVisible()
  await expect(page.getByText('Ultra Ball: 5 copies may exceed the normal 4-copy limit.', { exact: true })).toBeVisible()
  await expect(page.getByText('svgUltra Ball', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Open Visual card 1' }).click()
  await expect(page.getByRole('dialog', { name: 'Visual card 1' })).toBeVisible()
  await page.getByRole('button', { name: 'Next card' }).click()
  await expect(page.getByRole('dialog', { name: 'Pikachu with a deliberately long aligned card name' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: 'Visual card 1' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('Deck list uses the shared segmented composition summary', async ({ page }) => {
  await page.goto('/decks')
  await expect(page.getByText('Visual Practice Deck')).toBeVisible()
  await expect(page.getByLabel('Deck composition').first()).toBeVisible()
  await expect(page.getByText('Pokemon 8')).toBeVisible()
  await expect(page.getByText('Trainer 10')).toBeVisible()
  await expect(page.getByText('Energy 6')).toBeVisible()
  await expect(page.getByText('16 remaining')).toBeVisible()
  await expect(page.getByText('2 validation errors').first()).toBeVisible()
  await expect(page.getByText('Valid deck')).toBeVisible()
  await expect(page.getByText('40/40')).toBeVisible()
  await expect(page.getByText('41/40')).toBeVisible()
  await expect(page.getByText('55/40')).toBeVisible()
  await expect(page.getByText('15 over target')).toBeVisible()
  await expect(page.getByText('Pokemon 26')).toBeVisible()
  await expect(page.getByLabel('Deck composition')).toHaveCount(4)
})

test('Deck editor refetches after a failed quantity mutation', async ({ page }) => {
  await page.route('**/api/decks/1/entries/1', route => route.fulfill({
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Quantity update rejected' }),
  }))
  await page.goto('/decks/1')
  await page.getByRole('button', { name: 'Increase Visual card 1 quantity' }).click()
  await expect(page.getByText('Quantity update rejected')).toBeVisible()
  await expect(page.getByLabel('Deck composition')).toBeVisible()
})

test('Deck editor batches rapid quantity changes and ignores stale responses', async ({ page }) => {
  const rapidDeck = JSON.parse(JSON.stringify(deck))
  rapidDeck.entries[0].required_quantity = 50
  rapidDeck.current_card_count = 66
  rapidDeck.over_target_by = 26
  rapidDeck.status = 'over'
  const requests = []

  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) }))
  await page.route('**/api/decks/1/entries/1', async route => {
    const quantity = route.request().postDataJSON().required_quantity
    requests.push(quantity)
    if (requests.length === 1) await new Promise(resolve => setTimeout(resolve, 300))
    rapidDeck.entries[0].required_quantity = quantity
    rapidDeck.current_card_count = quantity + 16
    rapidDeck.over_target_by = rapidDeck.current_card_count - 40
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) })
  })

  await page.goto('/decks/1')
  const increase = page.getByRole('button', { name: 'Increase Visual card 1 quantity' })
  await increase.evaluate(button => { for (let count = 0; count < 5; count += 1) button.click() })
  await expect.poll(() => requests).toEqual([55])
  await increase.evaluate(button => { for (let count = 0; count < 5; count += 1) button.click() })
  await expect(page.getByText('x60', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([55, 60])
  await expect(page.getByText('x60', { exact: true })).toBeVisible()

  const decrease = page.getByRole('button', { name: 'Decrease Visual card 1 quantity' })
  await decrease.evaluate(button => { for (let count = 0; count < 15; count += 1) button.click() })
  await expect(page.getByText('x45', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([55, 60, 45])
})

test('Deck editor preserves rapid quantity changes above a 60-card target', async ({ page }) => {
  const rapidDeck = JSON.parse(JSON.stringify(deck))
  rapidDeck.target_size = 60
  rapidDeck.entries[0].required_quantity = 50
  rapidDeck.current_card_count = 66
  rapidDeck.over_target_by = 6
  rapidDeck.status = 'over'
  const requests = []

  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) }))
  await page.route('**/api/decks/1/entries/1', async route => {
    const quantity = route.request().postDataJSON().required_quantity
    requests.push(quantity)
    rapidDeck.entries[0].required_quantity = quantity
    rapidDeck.current_card_count = quantity + 16
    rapidDeck.over_target_by = Math.max(rapidDeck.current_card_count - 60, 0)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) })
  })

  await page.goto('/decks/1')
  const increase = page.getByRole('button', { name: 'Increase Visual card 1 quantity' })
  await increase.evaluate(button => { for (let count = 0; count < 20; count += 1) button.click() })
  await expect(page.getByText('x70', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([70])

  const decrease = page.getByRole('button', { name: 'Decrease Visual card 1 quantity' })
  await decrease.evaluate(button => { for (let count = 0; count < 15; count += 1) button.click() })
  await expect(page.getByText('x55', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([70, 55])
})

test('Deck picker batches rapid adds without detail refetches', async ({ page }) => {
  const updatedDeck = JSON.parse(JSON.stringify(deck))
  const requests = []
  let detailGets = 0
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/decks/1') detailGets += 1
  })
  await page.route('**/api/decks/1/entries', async route => {
    const quantity = route.request().postDataJSON().required_quantity
    requests.push(quantity)
    updatedDeck.entries.push({ id: 4, card_id: 'visual-card-4', required_quantity: quantity, owned_quantity: 2, shortage: Math.max(quantity - 2, 0), card: collection[3].card })
    updatedDeck.current_card_count = 24 + quantity
    updatedDeck.over_target_by = Math.max(updatedDeck.current_card_count - 40, 0)
    updatedDeck.status = updatedDeck.over_target_by ? 'over' : 'under'
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updatedDeck) })
  })
  await page.goto('/decks/1')
  const add = page.getByRole('button', { name: 'Add Visual card 4' })
  await add.evaluate(button => { for (let count = 0; count < 30; count += 1) button.click() })
  await expect(page.getByText('In deck: 30', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([30])
  expect(detailGets).toBe(1)
})

test('Deck picker reports a rate-limit response and remains usable', async ({ page }) => {
  await page.route('**/api/decks/1/entries', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Rate limit exceeded: 60 per 1 minute' }) }))
  await page.goto('/decks/1')
  await page.getByRole('button', { name: 'Add Visual card 4' }).click()
  await expect(page.getByText('Too many requests. Please wait a moment and try again.')).toBeVisible()
  await expect(page.getByLabel('Deck composition')).toBeVisible()
})

test('Deck editor filters the owned-card browser and requires an explicit add action', async ({ page }) => {
  await page.goto('/decks/1')

  await page.getByLabel('Filter by type').selectOption('Trainer')
  await expect(page.getByRole('button', { name: 'Preview Pikachu with a deliberately long aligned card name' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview Visual card 1' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Preview Pikachu with a deliberately long aligned card name' }).click()
  await expect(page.getByRole('button', { name: 'Add to deck' })).toBeVisible()
  const addRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/api/decks/1/entries/2'))
  await page.getByRole('button', { name: 'Add to deck' }).click()
  expect((await addRequest).postDataJSON()).toEqual({ required_quantity: 11 })
})

test('Deck editor opens a selected card preview in a mobile sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/decks/1')

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Preview Visual card 1' }).click()
  await expect(page.getByRole('dialog', { name: 'Visual card 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add to deck' })).toBeVisible()
})
