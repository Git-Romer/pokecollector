import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const indexCss = readFileSync(resolve(here, '../index.css'), 'utf-8')
const tailwind = readFileSync(resolve(here, '../../tailwind.config.js'), 'utf-8')

const RAMP = ['--color-text-primary', '--color-text-secondary', '--color-text-muted']
const LIGHT_CANVAS = '#FFF9F4'

const block = (pattern) => indexCss.match(pattern)[0]
const rootBlock = () => block(/:root \{[\s\S]*?\n\}/)
const lightBlock = () => block(/\[data-theme='light'\] \{[\s\S]*?\n\}/)

const declarations = (text) =>
    Object.fromEntries(
        [...text.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()])
    )

/** Relative luminance per WCAG 2.1. */
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
        // A literal cannot switch with the theme, which is how .text-text-primary
        // came to be a hardcoded white and .border-border a white wash.
        const text = tailwind.match(/text:\s*\{[^}]*\}/)[0]
        RAMP.forEach((name) => expect(text).toContain(`var(${name})`))

        const border = tailwind.match(/border:\s*\{[^}]*\}/)[0]
        expect(border).toContain('var(--color-border-hairline)')
    })

    it('gives every themed variable a value in both themes', () => {
        const root = declarations(rootBlock())
        const light = declarations(lightBlock())

        // A variable defined as var(...) inherits its own switching behaviour.
        const owed = Object.entries(root)
            .filter(([, value]) => !value.startsWith('var('))
            .map(([name]) => name)

        const missing = owed.filter((name) => !(name in light))
        expect(missing, `no light value for: ${missing.join(', ')}`).toEqual([])
    })

    it('keeps light-theme text legible on the light canvas', () => {
        const light = declarations(lightBlock())
        RAMP.forEach((name) => {
            const ratio = contrast(light[name], LIGHT_CANVAS)
            expect(ratio, `${name} scores ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        })
    })

    it('keeps the light surface distinguishable from its border', () => {
        const light = declarations(lightBlock())
        const ratio = contrast(light['--color-border'], light['--color-surface'])
        expect(ratio, `border scores ${ratio.toFixed(2)}:1 on the surface`).toBeGreaterThanOrEqual(1.3)
    })
})
