import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8')
const manifest = readFileSync(resolve(__dirname, '../public/manifest.json'), 'utf-8')

describe('runtime metadata', () => {
    it("brands the app as John John's PC with local Pokémon TCG archive metadata", () => {
        expect(indexHtml).toContain("<title>John John's PC</title>")
        expect(indexHtml).toContain('name="description"')
        expect(indexHtml).toContain('locally hosted Pokémon TCG collection archive')
        expect(indexHtml).toContain("property=\"og:title\" content=\"John John's PC\"")
        expect(indexHtml).toContain("name=\"twitter:title\" content=\"John John's PC\"")
        expect(manifest).toContain("\"name\": \"John John's PC\"")
        expect(manifest).toContain('locally hosted Pokémon TCG collection')
    })
})
