import { describe, expect, it } from 'vitest'
import { sortBinderCards } from './binderCards'

const card = (overrides = {}) => ({
  binder_card_id: 1,
  name: 'Kokuna',
  set_name: 'Wachsendes Chaos',
  number: '2',
  variant: 'Normal',
  quantity: 1,
  price_market: 1,
  ...overrides,
})

describe('sortBinderCards', () => {
  it('preserves the API order for the recent option', () => {
    const cards = [card({ name: 'Second' }), card({ name: 'First' })]
    expect(sortBinderCards(cards, 'recent').map(item => item.name)).toEqual(['Second', 'First'])
    expect(sortBinderCards(cards, 'recent')).not.toBe(cards)
  })

  it('uses natural collector ordering across sets and variants', () => {
    const cards = [
      card({ set_name: 'Set B', number: '1' }),
      card({ set_name: 'Set A', number: '10' }),
      card({ set_name: 'Set A', number: '2', variant: 'Reverse Holo' }),
      card({ set_name: 'Set A', number: '2', variant: 'Normal' }),
    ]

    expect(sortBinderCards(cards, 'number').map(item => `${item.set_name}-${item.number}-${item.variant}`)).toEqual([
      'Set A-2-Normal',
      'Set A-2-Reverse Holo',
      'Set A-10-Normal',
      'Set B-1-Normal',
    ])
  })

  it('sorts by name, price, quantity, and variant with deterministic fallbacks', () => {
    const cards = [
      card({ name: 'Vulpix', number: '8', variant: 'Reverse Holo', quantity: 1, price_market: 4 }),
      card({ name: 'Kokuna', number: '2', variant: 'Normal', quantity: 3, price_market: 2 }),
      card({ name: 'Fynx', number: '11', variant: 'Holo', quantity: 2, price_market: 7 }),
    ]

    expect(sortBinderCards(cards, 'name_asc').map(item => item.name)).toEqual(['Fynx', 'Kokuna', 'Vulpix'])
    expect(sortBinderCards(cards, 'name_desc').map(item => item.name)).toEqual(['Vulpix', 'Kokuna', 'Fynx'])
    expect(sortBinderCards(cards, 'price_desc').map(item => item.name)).toEqual(['Fynx', 'Vulpix', 'Kokuna'])
    expect(sortBinderCards(cards, 'price_asc').map(item => item.name)).toEqual(['Kokuna', 'Vulpix', 'Fynx'])
    expect(sortBinderCards(cards, 'quantity_desc').map(item => item.name)).toEqual(['Kokuna', 'Fynx', 'Vulpix'])
    expect(sortBinderCards(cards, 'variant_asc').map(item => item.variant)).toEqual(['Holo', 'Normal', 'Reverse Holo'])
  })

  it('sorts wishlist quantities by required copies instead of owned copies', () => {
    const cards = [
      card({ name: 'Needs one', quantity: 0, owned_quantity: 0, required_quantity: 1 }),
      card({ name: 'Needs four', quantity: 0, owned_quantity: 0, required_quantity: 4 }),
    ]

    expect(sortBinderCards(cards, 'quantity_desc', { isWishlist: true }).map(item => item.name)).toEqual([
      'Needs four',
      'Needs one',
    ])
  })

  it('places missing prices last and uses binder card ids to break exact ties', () => {
    const cards = [
      card({ binder_card_id: 12, name: 'Missing price', price_market: 0 }),
      card({ binder_card_id: 11, name: 'Known price', price_market: 2 }),
      card({ binder_card_id: 10, name: 'Known price', price_market: 2 }),
    ]

    expect(sortBinderCards(cards, 'price_asc').map(item => item.binder_card_id)).toEqual([10, 11, 12])
    expect(sortBinderCards(cards, 'price_desc').map(item => item.binder_card_id)).toEqual([10, 11, 12])
  })
})
