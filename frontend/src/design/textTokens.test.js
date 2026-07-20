import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const indexCss = readFileSync(resolve(here, '../index.css'), 'utf-8')
const tailwind = readFileSync(resolve(here, '../../tailwind.config.js'), 'utf-8')

const RAMP = ['--color-text-primary', '--color-text-secondary', '--color-text-muted']

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

function declared(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`))
  return match && match[1]
}

describe('text colour tokens', () => {
  it('are read from variables, not frozen as literals', () => {
    // A literal here cannot switch with the theme, which is how
    // .text-text-primary came to be a hardcoded white in both themes.
    const group = tailwind.match(/text:\s*\{[^}]*\}/)[0]
    RAMP.forEach((name) => expect(group).toContain(`var(${name})`))
  })

  it('defines the whole ramp for both themes', () => {
    const light = indexCss.match(/\[data-theme='light'\]\s*\{[^}]*\}/)[0]
    const root = indexCss.match(/:root\s*\{[^}]*\}/)[0]
    RAMP.forEach((name) => {
      expect(declared(root, name), `${name} missing from :root`).toBeTruthy()
      expect(declared(light, name), `${name} missing from light theme`).toBeTruthy()
    })
  })

  it('keeps light-theme text legible on the light canvas', () => {
    const light = indexCss.match(/\[data-theme='light'\]\s*\{[^}]*\}/)[0]
    const canvas = '#FFF9F4'
    RAMP.forEach((name) => {
      const ratio = contrast(declared(light, name), canvas)
      expect(ratio, `${name} scores ${ratio.toFixed(2)}:1 on ${canvas}`).toBeGreaterThanOrEqual(4.5)
    })
  })
})
