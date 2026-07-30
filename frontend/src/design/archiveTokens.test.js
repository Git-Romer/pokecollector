import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const archiveCss = readFileSync(resolve(here, './archive.css'), 'utf-8')

const rootBlock = archiveCss.match(/:root \{[\s\S]*?\n\}/)[0]

const declarations = (text) =>
    Object.fromEntries(
        [...text.matchAll(/(--archive-[a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()])
    )

const TOKENS = declarations(rootBlock)

const GLYPH = archiveCss
    .match(/\.archive-wordmark span, \.john-john-mark \{[^}]*\}/)[0]
    .match(/color:\s*(#[0-9a-f]{6})/i)[1]

const BACKDROPS = ['--archive-canvas', '--archive-surface', '--archive-surface-raised']

function luminance(hex) {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const [r, g, b] = channels.map((c) =>
        c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    )
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
}

describe('archive signal tokens', () => {
    it('does not define alternate theme blocks', () => {
        expect(archiveCss).not.toContain("[data-theme='light']")
    })

    it('defines the dark-mode signal text role', () => {
        expect(TOKENS['--archive-signal-text']).toBeTruthy()
    })

    it('keeps the signal legible as text on every dark surface', () => {
        const ink = TOKENS['--archive-signal-text']
        BACKDROPS.forEach((backdrop) => {
            const ratio = contrast(ink, TOKENS[backdrop])
            expect(ratio, `${ink} on ${backdrop} scores ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        })
    })

    it('keeps the wordmark glyph legible on the signal fill', () => {
        const ratio = contrast(GLYPH, TOKENS['--archive-signal'])
        expect(ratio, `glyph ${GLYPH} on --archive-signal scores ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    })
})

describe('radius scale', () => {
    const TIERS = ['--r-chip', '--r-control', '--r-surface', '--r-panel']

    it('defines every tier', () => {
        TIERS.forEach((tier) => {
            expect(rootBlock, `${tier} is not defined`).toContain(`${tier}:`)
        })
    })

    it('rounds every corner from the scale', () => {
        const allowed = /^(var\(--r-(chip|control|surface|panel)\)|999px|50%|inherit)$/
        const body = archiveCss.slice(rootBlock.length)

        const strays = [...body.matchAll(/border-radius:\s*([^;]+);/g)]
            .map(([, value]) => value.trim())
            .filter((value) => !allowed.test(value))

        expect(strays, `ad hoc radii: ${[...new Set(strays)].join(', ')}`).toEqual([])
    })
})
