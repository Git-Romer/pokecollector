import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import CollectionSpeciesView from './CollectionSpeciesView'

vi.mock('./WindowedCardGrid', () => ({ default: ({ items, renderItem }) => <div data-windowed-count={items.length}>{items.map(renderItem)}</div> }))
const t = key => key
const items = [
  { id: 1, card_id: 'pika', quantity: 2, card: { dex_ids: [25, 6], name: 'Pikachu' } },
  { id: 2, card_id: 'char', quantity: 3, card: { dex_ids: [6], name: 'Charizard' } },
  { id: 3, card_id: 'energy', quantity: 4, card: { dex_ids: [], name: 'Energy' } },
]
const render = (rows = items) => renderToStaticMarkup(<CollectionSpeciesView items={rows} speciesByDexId={new Map()} language="en" t={t} formatPrice={v => `€${v}`} itemValue={item => item.quantity * 2} renderItem={item => <div key={item.id} data-card={item.id}>{item.card.name}</div>} />)

describe('CollectionSpeciesView', () => {
  it('opens every group initially and passes full group rows to the shared windowed grid', () => {
    const html = render()
    expect(html).toContain('Pikachu')
    expect(html).toContain('Charizard')
    expect(html).toContain('collection.otherCards')
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(3)
    expect(html).toContain('data-card="2"')
    expect(html).toContain('data-card="1"')
    expect(html).toContain('data-card="3"')
    expect(html).toContain('€6')
    expect(html).toContain('data-windowed-count="1"')
  })
  it('keeps a collection containing only other cards usable', () => {
    const html = render([items[2]])
    expect(html).toContain('data-card="3"')
    expect(html).toContain('€8')
  })
  it('does not truncate a large species group before passing it to the windowed grid', () => {
    const rows = Array.from({ length: 1500 }, (_, id) => ({ ...items[0], id, card_id: `card-${id}` }))
    expect(render(rows)).toContain('data-windowed-count="1500"')
  })
})
