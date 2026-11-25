import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ options: [] }))
vi.mock('@tanstack/react-virtual', async importOriginal => ({
  ...await importOriginal(),
  useVirtualizer: options => { hooks.options.push(options); return {} },
}))
import WindowedCardGrid from '../components/WindowedCardGrid'

const source = file => readFileSync(new URL(file, import.meta.url), 'utf8')

describe('artist grid performance contract', () => {
  it('windows both grouped and ungrouped checklist cards through the shared renderer', () => {
    const text = source('./ArtistChecklist.jsx')
    expect(text.match(/<WindowedCardGrid\b/g)).toHaveLength(2)
    expect(text).toContain('items={group.cards}')
    expect(text).toContain('items={cards}')
    expect(text.match(/renderItem={renderCard}/g)).toHaveLength(2)
    expect(text).not.toMatch(/cards\.map\(renderCard\)/)
    expect(text).not.toMatch(/import UnifiedCard/)
  })

  it('windows artist tiles with measured rows and identity keys, leaving list view available', () => {
    const text = source('./Artists.jsx')
    expect(text).toContain('<WindowedCardGrid')
    expect(text).toContain('items={artists}')
    expect(text).toContain('getKey={artistKey}')
    expect(text).toContain('measureRows')
    expect(text).toContain('overscanItems={12}')
    expect(text).toContain('<ArtistRow')
  })

  it('keeps the full data and accessible positions in the initial render', () => {
    const items = Array.from({ length: 50 }, (_, n) => ({ id: `artist-${n}` }))
    const markup = renderToStaticMarkup(<WindowedCardGrid items={items} renderItem={item => <a href={`/${item.id}`}>{item.id}</a>} />)
    expect(markup.match(/role="listitem"/g)).toHaveLength(50)
    expect(markup).toContain('href="/artist-49"')
  })

  it('uses the existing default buffer but supports composite artwork tiles', () => {
    renderToStaticMarkup(<WindowedCardGrid items={[]} renderItem={() => null} />)
    expect(hooks.options.at(-1).overscan).toBe(14)
    renderToStaticMarkup(<WindowedCardGrid items={[]} renderItem={() => null} overscanItems={12} />)
    expect(hooks.options.at(-1).overscan).toBe(4)
  })
})
