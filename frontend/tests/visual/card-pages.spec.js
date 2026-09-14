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

const plannedBinder = {
  id: 10,
  name: 'Visual Planned Binder',
  description: 'A planned collection fixture',
  color: '#eab308',
  binder_type: 'wishlist',
  card_count: 0,
  unique_card_count: 0,
  is_public: false,
  created_at: '2026-08-27T12:00:00',
  updated_at: '2026-08-27T12:00:00',
}

const cardLists = deckSummaries.map(item => ({
  id: item.id,
  name: item.name,
  description: item.description,
  color: '#8b5cf6',
  binder_type: 'deck',
  format: item.format,
  target_size: item.target_size,
  card_count: item.current_card_count,
  unique_card_count: 3,
  is_public: false,
  created_at: '2026-08-27T12:00:00',
  updated_at: '2026-08-27T12:00:00',
})).concat(plannedBinder)

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
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
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
      '/api/binders/': cardLists,
      '/api/binders/1/cards': { binder: cardLists[0], cards: [] },
      '/api/binders/10/cards': { binder: plannedBinder, cards: [], available_collection_item_quantities: {} },
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

async function expandDeckPicker(page) {
  const expand = page.getByRole('button', { name: 'Add cards' })
  if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click()
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

test('legacy physical-deck workflow redirects to the unified Deck editor', async ({ page }) => {
  await page.goto('/decks/1/build')
  await page.waitForURL('**/decks/1')
  await expect(page.getByRole('heading', { name: 'Visual Practice Deck' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Make Real Deck' })).toBeVisible()
})

test('Real Deck uses the unified editor without a manual assignment step', async ({ page }) => {
  const realDeck = {
    ...deck,
    binder_type: 'physical_deck',
    missing_copy_count: 0,
    shared_missing_copy_count: 0,
    entries: deck.entries.map(entry => ({ ...entry, shortage: 0, allocated_quantity: entry.required_quantity })),
  }
  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(realDeck) }))
  await page.goto('/decks/1')
  await expect(page.getByText('Real Deck', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Make Planned Deck' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Physical deck (optional)' })).toHaveCount(0)
  await expect(page.locator('header').getByRole('button', { name: 'Add missing to wishlist' })).toHaveCount(0)
})

test('deck editor expands structured validation details', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('button', { name: /Deck Validation/ }).click()
  await expect(page.getByText('Visual card 1: 8')).toBeVisible()
  await expect(page.getByText('Visual card 2: 1 Missing')).toBeVisible()
})

test('deck gallery uses the same progress and price captions as a Planned Binder', async ({ page }) => {
  await page.goto('/decks/1')
  await expect(page.getByLabel('Progress: 8/8')).toBeVisible()
  await expect(page.getByLabel('Progress: 8/8').locator('.lucide-check')).toBeVisible()
  await expect(page.getByLabel('Progress: 9/10')).toHaveText('9/10')
  await expect(page.getByText('€5.00', { exact: true })).toBeVisible()
})

test('deck editor dims a card when no required copy is owned', async ({ page }) => {
  const missingDeck = JSON.parse(JSON.stringify(deck))
  missingDeck.entries[1].owned_quantity = 0
  missingDeck.entries[1].shortage = missingDeck.entries[1].required_quantity
  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(missingDeck) }))
  await page.goto('/decks/1')
  const missingCard = page.locator('.unified-card-frame').filter({ has: page.getByRole('button', { name: /Open Pikachu with a deliberately long aligned card name/ }) })
  await expect(missingCard.locator('.unified-card-missing-overlay')).toBeVisible()
})

test('deck editor renders quantity-weighted analytics on desktop and mobile', async ({ page }) => {
  const localizedTypesDeck = JSON.parse(JSON.stringify(deck))
  localizedTypesDeck.analysis.pokemon.types = { water: 3, Wasser: 5 }
  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(localizedTypesDeck) }))
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await expect(page.getByText('Card diversity')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Deck composition' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Deck composition' }).getByText('24', { exact: true })).toBeVisible()
  await expect(page.locator('.recharts-tooltip-wrapper')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Pokemon' }).click()
  await expect(page.getByText('Water')).toBeVisible()
  await expect(page.locator('[data-analytics-row="Water"] [data-analytics-color="#3b82f6"]')).toBeVisible()
  await expect(page.locator('[data-analytics-row="Water"] strong')).toHaveText('8')
  await expect(page.getByText('other_unknown', { exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: 'Attacks' }).click()
  await expect(page.getByText('Fixed-damage attacks')).toBeVisible()
  await expect(page.getByText(/Shows the attacks available/)).toBeVisible()
})

test('deck analytics consistency shows non-zero effects and expandable sources', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await page.getByRole('tab', { name: 'Consistency' }).click()
  await expect(page.getByText('What is shown here?')).toBeVisible()
  await expect(page.getByText('Key consistency tools')).toBeVisible()
  await expect(page.getByText(/not probabilities or a quality score/)).toBeVisible()
  await expect(page.getByText('Switching', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /Pokemon Search.*7 copies.*2 different cards/ }).first().click()
  await expect(page.getByText('Ultra Ball')).toBeVisible()
})

test('deck analytics explains an empty consistency result', async ({ page }) => {
  const noEffectsDeck = JSON.parse(JSON.stringify(deck))
  noEffectsDeck.analysis.effects = { coverage: {}, outs: {}, unclassified_cards: { cards: 1, unique_sources: 1 } }
  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(noEffectsDeck) }))
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await page.getByRole('tab', { name: 'Consistency' }).click()
  await expect(page.getByText(/No recognized consistency effects were found/)).toBeVisible()
})

test('deck analytics probability calculates opening, outs, key-card, and prize views', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await page.getByRole('tab', { name: 'Probability' }).click()
  await expect(page.getByText('Basic Pokemon')).toBeVisible()
  await expect(page.getByText('95.0%')).toBeVisible()
  await page.getByLabel('Key card').selectOption({ label: 'Visual card 1' })
  await expect(page.getByText('Key card among the Prize cards')).toBeVisible()
  await page.getByLabel('Extra draws').fill('2')
  await expect(page.getByText('Chance after all selected draws')).toBeVisible()
})

test('deck comparison presents card deltas and compact mobile-safe sections', async ({ page }) => {
  await page.goto('/decks/compare?left=1&right=2')
  await expect(page.getByTestId('deck-comparison-hero')).toBeVisible()
  await expect(page.locator('[data-comparison-deck]')).toHaveCount(2)
  await expect(page.getByText('Card Changes')).toBeVisible()
  await expect(page.locator('section').filter({ hasText: 'Card Changes' }).locator('span').filter({ hasText: 'Visual card 1' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Composition' })).toBeVisible()
  const compositionSection = page.getByRole('heading', { name: 'Composition' }).locator('xpath=ancestor::section[1]')
  await expect(compositionSection.locator('[data-comparison-metric="Pokemon"]')).toBeVisible()
  await expect(compositionSection.locator('[data-comparison-metric="Trainer"]')).toBeVisible()
  await expect(compositionSection.locator('[data-deck-pair="left"]').first()).toBeVisible()
  await expect(compositionSection.locator('[data-deck-pair="right"]').first()).toBeVisible()
  await expect(page.getByText('Collection & Deck checks')).toBeVisible()
  const ownershipSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Collection & Deck checks' }) })
  await expect(ownershipSection.locator('[data-deck-pair="left"]').first()).toBeVisible()
  await expect(ownershipSection.locator('[data-deck-pair="right"]').first()).toBeVisible()
  await page.getByLabel('Show unchanged').check()
  await page.getByLabel('Key card').selectOption('Visual card 1')
  const keyCardRow = page.locator('[data-comparison-metric="key-card"]')
  await expect(keyCardRow).toContainText('Opening 7')
  await expect(keyCardRow).toContainText('22.0%')
  await expect(keyCardRow).toContainText('40.0%')
  await page.getByRole('button', { name: 'Swap decks' }).click()
  await expect(page.getByLabel('Deck A')).toHaveValue('2')
  await expect(page.getByLabel('Deck B')).toHaveValue('1')
})

test('deck editor duplicates a deck into an independent editor route', async ({ page }) => {
  await page.goto('/decks/1')
  await page.locator('header').getByRole('button', { name: 'Duplicate' }).click()
  await page.waitForURL('**/decks/99')
  await expect(page.getByRole('heading', { name: 'Visual Practice Deck (Copy)' })).toBeVisible()
})

test('legacy deck inventory route returns to Card Lists', async ({ page }) => {
  await page.goto('/decks/inventory')
  await page.waitForURL('**/binders')
  await expect(page.getByRole('heading', { name: 'Card Lists' })).toBeVisible()
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
  await expect(page.getByRole('button', { name: 'Increase Visual card 1 quantity' })).toHaveCount(0)
  await expect(page.getByLabel('Progress: 9/10')).toHaveText('9/10')
  await page.getByRole('button', { name: /Deck Validation/ }).click()
  await expect(page.getByText('One or more cards exceed the four-copy limit.', { exact: true })).toBeVisible()
  await expect(page.getByText('Visual card 1: 8', { exact: true })).toBeVisible()
  await expect(page.getByText('svgUltra Ball', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Open Visual card 1' }).click()
  const cardDialog = page.getByRole('dialog', { name: 'Visual card 1' })
  await expect(cardDialog).toBeVisible()
  await expect(cardDialog.locator('.unified-card-art')).toBeVisible()
  await expect(cardDialog.getByRole('tab', { name: 'Deck' })).toBeVisible()
  await expect(cardDialog.getByRole('tab', { name: 'Equivalent prints' })).toBeVisible()
  await expect(cardDialog.getByRole('button', { name: 'Increase Visual card 1 quantity' })).toBeVisible()
  await page.getByRole('button', { name: 'Next card' }).click()
  await expect(page.getByRole('dialog', { name: 'Pikachu with a deliberately long aligned card name' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: 'Visual card 1' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('Card Lists overview includes deck metadata without technical inventory controls', async ({ page }) => {
  await page.goto('/binders')
  await expect(page.getByRole('heading', { name: 'Card Lists' })).toBeVisible()
  await expect(page.getByText('Visual Practice Deck')).toBeVisible()
  await expect(page.getByText('Planned Deck', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Casual · 40 cards').first()).toBeVisible()
  await expect(page.getByText('24 cards')).toBeVisible()
  const deckCard = page.locator('.card').filter({ hasText: 'Visual Practice Deck' }).first()
  const titleBox = await deckCard.getByRole('heading', { name: 'Visual Practice Deck' }).boundingBox()
  const typeBox = await deckCard.getByText('Planned Deck', { exact: true }).boundingBox()
  expect(typeBox.y).toBeGreaterThan(titleBox.y)
  await expect(page.getByRole('button', { name: 'Export Inventory CSV' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Compare Decks' })).toHaveCount(0)
  await page.getByRole('button', { name: 'New Card List' }).click()
  await expect(page.getByRole('button', { name: 'Planned Binder', exact: true })).toBeVisible()
})

test('Deck comparison starts from the current Deck Analytics tab', async ({ page }) => {
  await page.goto('/decks/1')
  await page.getByRole('tab', { name: 'Analytics' }).click()
  await page.getByRole('tab', { name: 'Compare Decks' }).click()
  await expect(page.getByLabel('Deck A')).toHaveText('Visual Practice Deck')
  await page.getByLabel('Deck B').selectOption('2')
  await page.getByRole('button', { name: 'Compare Decks' }).click()
  await expect(page).toHaveURL(/\/decks\/compare\?left=1&right=2$/)
})

test('Planned Binder uses the advanced shared card picker controls', async ({ page }) => {
  await page.goto('/binders/10')
  await expect(page.getByText('Deck-style binder')).toHaveCount(0)
  await page.getByRole('button', { name: 'Add cards' }).click()
  await expect(page.getByRole('tab', { name: 'My collection' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'All cards' })).toBeVisible()
  await expect(page.getByLabel('Filter by card type')).toBeVisible()
  await expect(page.getByLabel('Filter by language')).toBeVisible()
  await expect(page.getByText('Visual card 1', { exact: true })).toBeVisible()
  await page.getByLabel('Filter by card type').selectOption('Trainer')
  await expect(page.getByText('Pikachu with a deliberately long aligned card name', { exact: true })).toBeVisible()
  await expect(page.getByText('Visual card 1', { exact: true })).toHaveCount(0)
})

test('Deck CSV import explains the format before choosing a file', async ({ page }) => {
  await page.goto('/decks/1')
  await page.locator('header').getByRole('button', { name: 'Import deck list (CSV)' }).click()
  await expect(page.getByRole('heading', { name: 'Card List CSV import' })).toBeVisible()
  await expect(page.getByText('Import cards and required quantities into this deck from a CSV file.')).toBeVisible()
  await expect(page.getByText('set_code,number,required_quantity,lang,variant,condition,collection_item_id')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose CSV file' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download template' })).toBeVisible()
})

test('Deck and Card List controls are translated in German', async ({ page }) => {
  await page.route('**/api/settings/', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      language: 'de',
      price_primary: 'trend',
      price_display: '["trend","avg","avg1","avg7","avg30","low"]',
      tcgdex_sync_languages: 'en,de',
      currency: 'EUR',
    }),
  }))
  await page.goto('/decks/1')
  await expect(page.getByRole('button', { name: 'In echtes Deck umwandeln' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Karten hinzufügen' })).toBeVisible()
  await page.getByRole('button', { name: /Deckprüfung/ }).click()
  await expect(page.getByText('Das Deck enthält 24 von 40 Karten.')).toBeVisible()
  await expect(page.getByText('One or more cards exceed the 4-copy limit.')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Analyse' }).click()
  await page.getByRole('tab', { name: 'Pokémon' }).click()
  await expect(page.getByText('Elektro', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Zuverlässigkeit' }).click()
  await expect(page.getByText('Was wird hier gezeigt?')).toBeVisible()
  await page.locator('header').getByRole('button', { name: 'Deckliste importieren (CSV)' }).click()
  await expect(page.getByRole('heading', { name: 'Kartenliste aus CSV importieren' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'CSV-Datei auswählen' })).toBeVisible()
})

test('legacy Binder URL for a Deck redirects to the Deck editor', async ({ page }) => {
  await page.goto('/binders/1')
  await page.waitForURL('**/decks/1')
  await expect(page.getByRole('heading', { name: 'Visual Practice Deck' })).toBeVisible()
})

test('Deck editor refetches after a failed quantity mutation', async ({ page }) => {
  await page.route('**/api/decks/1/entries/1', route => route.fulfill({
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Quantity update rejected' }),
  }))
  await page.goto('/decks/1')
  await page.getByRole('button', { name: 'Open Visual card 1' }).click()
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
  await page.getByRole('button', { name: 'Open Visual card 1' }).click()
  const increase = page.getByRole('button', { name: 'Increase Visual card 1 quantity' })
  await increase.evaluate(button => { for (let count = 0; count < 5; count += 1) button.click() })
  await expect.poll(() => requests).toEqual([55])
  await increase.evaluate(button => { for (let count = 0; count < 5; count += 1) button.click() })
  await expect(page.getByRole('dialog').locator('[aria-live="polite"]')).toHaveText('60')
  await expect.poll(() => requests).toEqual([55, 60])
  await expect(page.getByRole('dialog').locator('[aria-live="polite"]')).toHaveText('60')

  const decrease = page.getByRole('button', { name: 'Decrease Visual card 1 quantity' })
  await decrease.evaluate(button => { for (let count = 0; count < 15; count += 1) button.click() })
  await expect(page.getByRole('dialog').locator('[aria-live="polite"]')).toHaveText('45')
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
  await page.getByRole('button', { name: 'Open Visual card 1' }).click()
  const increase = page.getByRole('button', { name: 'Increase Visual card 1 quantity' })
  await increase.evaluate(button => { for (let count = 0; count < 20; count += 1) button.click() })
  await expect(page.getByRole('dialog').locator('[aria-live="polite"]')).toHaveText('70')
  await expect.poll(() => requests).toEqual([70])

  const decrease = page.getByRole('button', { name: 'Decrease Visual card 1 quantity' })
  await decrease.evaluate(button => { for (let count = 0; count < 15; count += 1) button.click() })
  await expect(page.getByRole('dialog').locator('[aria-live="polite"]')).toHaveText('55')
  await expect.poll(() => requests).toEqual([70, 55])
})

test('Deck picker adds a selected card with its chosen quantity without detail refetches', async ({ page }) => {
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
  await expandDeckPicker(page)
  await page.getByRole('button', { name: 'Select Visual card 4' }).click()
  await page.getByRole('button', { name: 'Add (1)' }).click()
  await page.getByLabel('Quantity: Visual card 4').fill('30')
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click()
  await expect(page.getByLabel('Progress: 2/30')).toBeVisible()
  await expect.poll(() => requests).toEqual([30])
  expect(detailGets).toBe(1)
})

test('Deck picker reports a rate-limit response and remains usable', async ({ page }) => {
  await page.route('**/api/decks/1/entries', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Rate limit exceeded: 60 per 1 minute' }) }))
  await page.goto('/decks/1')
  await expandDeckPicker(page)
  await page.getByRole('button', { name: 'Select Visual card 4' }).click()
  await page.getByRole('button', { name: 'Add (1)' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Too many requests. Please wait a moment and try again.')).toBeVisible()
  await expect(page.getByLabel('Deck composition')).toBeVisible()
})

test('Deck editor filters the owned-card browser and requires an explicit add action', async ({ page }) => {
  const updatedDeck = JSON.parse(JSON.stringify(deck))
  await page.route('**/api/decks/1/entries', async route => {
    const payload = route.request().postDataJSON()
    updatedDeck.entries.push({ id: 4, card_id: payload.card_id, required_quantity: payload.required_quantity, owned_quantity: 1, shortage: 0, card: collection[3].card })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updatedDeck) })
  })
  await page.goto('/decks/1')
  await expandDeckPicker(page)

  await page.getByLabel('Filter by card type').selectOption('Trainer')
  await expect(page.getByRole('button', { name: 'Select Pikachu with a deliberately long aligned card name' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select Pikachu with a deliberately long aligned card name' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Select Visual card 1' })).toHaveCount(0)

  await page.getByLabel('Filter by card type').selectOption('Pokemon')
  await page.getByRole('button', { name: 'Select Visual card 4' }).click()
  await expect(page.getByRole('button', { name: 'Add (1)' })).toBeVisible()
  const addRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/decks/1/entries'))
  await page.getByRole('button', { name: 'Add (1)' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click()
  expect((await addRequest).postDataJSON()).toEqual({ card_id: 'visual-card-4', required_quantity: 1 })
})

test('Deck picker preserves card proportions for a large scrollable collection', async ({ page }) => {
  const largeCollection = Array.from({ length: 80 }, (_, index) => ({
    ...collection[index % collection.length],
    id: 1000 + index,
    card_id: `bulk-card-${index + 1}`,
    card: card(index + 1, { id: `bulk-card-${index + 1}`, card_id: `bulk-card-${index + 1}`, name: `Bulk card ${index + 1}` }),
  }))
  await page.route('**/api/collection/', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(largeCollection),
  }))
  await page.goto('/decks/1')
  await expandDeckPicker(page)
  const firstArtwork = page.getByRole('button', { name: 'Select Bulk card 1', exact: true }).locator('..').locator('.unified-card-art')
  const laterArtwork = page.getByRole('button', { name: 'Select Bulk card 25', exact: true }).locator('..').locator('.unified-card-art')
  await expect(firstArtwork).toBeVisible()
  await expect(laterArtwork).toHaveCount(0)
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(laterArtwork).toBeVisible()
  for (const artwork of [firstArtwork, laterArtwork]) {
    const box = await artwork.boundingBox()
    expect(box.height / box.width).toBeGreaterThan(1.3)
  }
})


test('Deck editor supports multi-select and quantity entry on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/decks/1')
  await expandDeckPicker(page)

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Select Visual card 4' }).click()
  await page.getByRole('button', { name: 'Select Visual card 5' }).click()
  await expect(page.getByLabel('Selected')).toHaveCount(2)
  await page.getByRole('button', { name: 'Add (2)' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add · Quantity' })
  await expect(dialog.getByLabel('Quantity: Visual card 4')).toBeVisible()
  await expect(dialog.getByLabel('Quantity: Visual card 5')).toBeVisible()
})

test('shared Card List picker preserves failed Deck selections after a partial batch', async ({ page }) => {
  const updatedDeck = JSON.parse(JSON.stringify(deck))
  await page.route('**/api/decks/1/entries', async route => {
    const payload = route.request().postDataJSON()
    if (payload.card_id === 'visual-card-5') {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Card is unavailable' }) })
      return
    }
    updatedDeck.entries.push({ id: 4, card_id: payload.card_id, required_quantity: payload.required_quantity, owned_quantity: 1, shortage: 0, card: collection[3].card })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updatedDeck) })
  })

  await page.goto('/decks/1')
  await expandDeckPicker(page)
  await page.getByRole('button', { name: 'Select Visual card 4' }).click()
  await page.getByRole('button', { name: 'Select Visual card 5' }).click()
  await page.getByRole('button', { name: 'Add (2)' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click()

  await expect(page.getByRole('button', { name: 'Add (1)' })).toBeVisible()
  await expect(page.getByLabel('Selected')).toHaveCount(1)
})

test('Planned Binder and Deck share the same 24-card incremental picker', async ({ page }) => {
  const largeCollection = Array.from({ length: 80 }, (_, index) => ({
    ...collection[index % collection.length],
    id: 2000 + index,
    card_id: `shared-card-${index + 1}`,
    card: card(index + 1, { id: `shared-card-${index + 1}`, card_id: `shared-card-${index + 1}`, name: `Shared card ${index + 1}` }),
  }))
  await page.route('**/api/collection/', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(largeCollection) }))

  await page.goto('/binders/10')
  await page.getByRole('button', { name: 'Add cards' }).click()
  await expect(page.getByTestId('card-list-picker-grid').locator('.unified-card-frame')).toHaveCount(24)
  await expect(page.getByRole('button', { name: 'Select Shared card 25' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page.getByRole('button', { name: 'Select Shared card 25' })).toBeVisible()
})

test('shared picker keeps exact physical Binder copies independently selectable', async ({ page }) => {
  const secondCopy = { ...collection[0], id: 99, quantity: 2, variant: 'Reverse Holo' }
  const physicalBinder = { ...plannedBinder, id: 11, name: 'Physical Binder', binder_type: 'collection' }
  await page.route('**/api/collection/', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([collection[0], secondCopy]) }))
  await page.route('**/api/binders/11/cards**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      binder: physicalBinder,
      cards: [{ ...collection[0].card, binder_card_id: 110, collection_item_id: 1, required_quantity: 1, quantity: 1, owned_quantity: 1 }],
      available_collection_item_quantities: { 1: 0, 99: 2 },
      unavailable_collection_item_ids: [1],
    }),
  }))

  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Add cards' }).click()
  const copies = page.getByRole('button', { name: 'Select Visual card 1' })
  await expect(copies).toHaveCount(2)
  await expect(copies.nth(0)).toBeDisabled()
  await expect(copies.nth(1)).toBeEnabled()
})
