import { describe, expect, it } from 'vitest'
import { buildTradeUpdatePayload, findNewTradeDraftItem, isCashTradeItem, tradeToDraft } from './tradeDraft'

const trade = {
  id: 7,
  partner_name: 'Misty',
  trade_date: '2026-08-08',
  notes: 'Original note',
  items: [
    {
      id: 11,
      direction: 'outgoing',
      card_id: 'sv1-1_en',
      original_collection_item_id: 21,
      card_name: 'Sprigatito',
      set_id: 'sv1',
      card_number: '1',
      quantity: 2,
      value_per_card: 9,
      variant: 'Normal',
      condition: 'NM',
      lang: 'en',
      notes: 'Keep this snapshot',
    },
    {
      id: 12,
      direction: 'incoming',
      card_id: 'sv1-2_en',
      card_name: 'Floragato',
      set_id: 'sv1',
      card_number: '2',
      quantity: 1,
      value_per_card: 14,
      variant: 'Holo',
      condition: 'LP',
      lang: 'en',
    },
    {
      id: 13,
      direction: 'incoming',
      card_id: null,
      card_name: 'Cash',
      set_id: 'cash',
      card_number: 'cash',
      value_total: 5,
    },
  ],
}

describe('trade edit drafts', () => {
  it('separates cash and preserves existing trade item identities', () => {
    const draft = tradeToDraft(trade, 1)

    expect(draft.partnerName).toBe('Misty')
    expect(draft.incomingCash).toBe('5.00')
    expect(draft.outgoing).toHaveLength(1)
    expect(draft.outgoing[0]).toMatchObject({ trade_item_id: 11, quantity: 2, value_per_card: '9.00' })
    expect(draft.incoming[0]).toMatchObject({ trade_item_id: 12, condition: 'LP', variant: 'Holo' })
  })

  it('builds mixed existing and newly-added item references without editable values', () => {
    const draft = tradeToDraft(trade, 1)
    draft.outgoing.push({
      key: 'out-99',
      collectionItem: { id: 99 },
      quantity: 1,
      notes: 'Forgotten card',
    })
    draft.incoming.push({
      key: 'in-custom',
      card: { id: 'custom-1', lang: 'en' },
      quantity: 2,
      condition: 'NM',
      variant: 'Normal',
      lang: 'en',
    })

    const payload = buildTradeUpdatePayload(draft, 1)

    expect(payload.outgoing).toEqual([
      { trade_item_id: 11, quantity: 2, condition: 'NM', notes: 'Keep this snapshot' },
      { collection_item_id: 99, quantity: 1, notes: 'Forgotten card' },
    ])
    expect(payload.incoming[0].trade_item_id).toBe(12)
    expect(payload.incoming[1]).toMatchObject({ card_id: 'custom-1', quantity: 2 })
    expect(payload.outgoing[0]).not.toHaveProperty('value_per_card')
    expect(payload.incoming[0]).not.toHaveProperty('value_per_card')
  })

  it('does not misclassify a deleted custom card named Cash', () => {
    expect(isCashTradeItem({ card_id: null, card_name: 'Cash', set_id: 'cash', card_number: 'promo' })).toBe(false)
  })

  it('never merges a newly added copy into a historical value snapshot', () => {
    const historical = { trade_item_id: 11, card: { id: 'same-card' } }
    const newlyAdded = { key: 'new-card', card: { id: 'same-card' } }

    expect(findNewTradeDraftItem(
      [historical, newlyAdded],
      item => item.card.id === 'same-card',
    )).toBe(newlyAdded)
    expect(findNewTradeDraftItem(
      [historical],
      item => item.card.id === 'same-card',
    )).toBeUndefined()
  })
})
