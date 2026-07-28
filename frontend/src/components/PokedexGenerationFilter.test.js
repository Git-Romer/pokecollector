import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import PokedexGenerationFilter from './PokedexGenerationFilter'

const translations = {
  'pokedex.generationFilter': 'Pokédex region',
  'pokedex.national': 'National',
}
const t = key => translations[key] || key

describe('PokedexGenerationFilter', () => {
  it('renders a labelled mobile select and a non-shrinking desktop control', () => {
    const markup = renderToStaticMarkup(createElement(PokedexGenerationFilter, {
      generation: 3,
      onSelectGeneration: vi.fn(),
      t,
    }))

    expect(markup).toContain('<label class="block sm:hidden">')
    expect(markup).toContain('<span class="sr-only">Pokédex region</span>')
    expect(markup).toContain('<select class="select w-full">')
    expect((markup.match(/aria-label="Pokédex region"/g) || [])).toHaveLength(1)
    expect(markup).toContain('class="-mx-1 hidden gap-2 overflow-x-auto px-1 pb-1 sm:flex"')
    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="Pokédex region"')
    expect(markup).toContain('shrink-0 whitespace-nowrap')
  })

  it('exposes all generations and the selected desktop state', () => {
    const markup = renderToStaticMarkup(createElement(PokedexGenerationFilter, {
      generation: 2,
      onSelectGeneration: vi.fn(),
      t,
    }))

    expect((markup.match(/<option/g) || [])).toHaveLength(10)
    expect(markup).toContain('<option value="2" selected="">Gen 2 · Johto · #152–251</option>')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('Gen 2 · Johto')
  })

  it('selects National consistently when no generation is active', () => {
    const markup = renderToStaticMarkup(createElement(PokedexGenerationFilter, {
      generation: null,
      onSelectGeneration: vi.fn(),
      t,
    }))

    expect(markup).toContain('<option value="" selected="">National</option>')
    expect(markup).toContain('<button type="button" aria-pressed="true"')
  })
})
