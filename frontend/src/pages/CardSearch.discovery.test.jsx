import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

test('explains live, cached, and unavailable PokéBeach discovery states', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './CardSearch.jsx'), 'utf-8')
    expect(source).toContain('discoveryFeedLabel')
    expect(source).toContain('Live PokéBeach signal.')
    expect(source).toContain('Showing cached PokéBeach signal.')
    expect(source).toContain('PokéBeach signal unavailable')
    expect(source).toContain("John John's PC remains the collection source of truth")
})
