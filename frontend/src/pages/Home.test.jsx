import { COLLECTION_OVERVIEW_COPY } from './Home'

test('uses Collection Overview language for the root surface', () => {
  expect(COLLECTION_OVERVIEW_COPY.kicker).toBe('COLLECTION OVERVIEW')
  expect(COLLECTION_OVERVIEW_COPY.title).toBe('Collection Overview')
  expect(COLLECTION_OVERVIEW_COPY.notesTitle).toBe('John John’s Notes')
  expect(Object.values(COLLECTION_OVERVIEW_COPY).join(' ')).not.toMatch(/portfolio|P&L|market/i)
})
