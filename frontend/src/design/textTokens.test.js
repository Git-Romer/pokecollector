import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const indexCss = readFileSync(resolve(here, '../index.css'), 'utf-8')
const tailwind = readFileSync(resolve(here, '../../tailwind.config.js'), 'utf-8')

const RAMP = ['--color-text-primary', '--color-text-secondary', '--color-text-muted']
const DARK_CANVAS = '#000000'

const rootBlock = indexCss.match(/:root \{[\s\S]*?\n\}/)[0]

const declarations = (text) =>
    Object.fromEntries(
        [...text.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()])
    )

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

describe('colour tokens', () => {
    it('are read from variables, not frozen as literals', () => {
        const text = tailwind.match(/text:\s*\{[^}]*\}/)[0]
        RAMP.forEach((name) => expect(text).toContain(`var(${name})`))

        const border = tailwind.match(/border:\s*\{[^}]*\}/)[0]
        expect(border).toContain('var(--color-border-hairline)')
    })

    it('does not define alternate theme blocks', () => {
        expect(indexCss).not.toContain("[data-theme='light']")
    })

    it('keeps dark-mode text legible on the dark canvas', () => {
        const root = declarations(rootBlock)
        RAMP.forEach((name) => {
            const ratio = contrast(root[name], DARK_CANVAS)
            expect(ratio, `${name} scores ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        })
    })

    it('keeps the dark surface distinguishable from its border', () => {
        const root = declarations(rootBlock)
        const ratio = contrast(root['--color-border'], root['--color-surface'])
        expect(ratio, `border scores ${ratio.toFixed(2)}:1 on the surface`).toBeGreaterThanOrEqual(1.3)
    })
})
