import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './Settings.jsx'), 'utf-8')

describe('Settings first-release surface', () => {
    it('does not expose card-migration developer tooling as a visible settings action', () => {
        expect(source).not.toContain("navigate('/migration')")
        expect(source).not.toContain('getCustomMatches')
        expect(source).not.toContain('migration.title')
    })

    it('links source code to John John AI Platform and hides upstream community support chrome', () => {
        expect(source).toContain('john-john-ai-platform')
        expect(source).not.toContain('Git-Romer/pokecollector')
        expect(source).not.toContain("{key: 'community'")
        expect(source).not.toContain('romerg.de')
        expect(source).not.toContain('info@romerg.de')
    })
})
