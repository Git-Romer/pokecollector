import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const archiveCss = readFileSync(resolve(here, './archive.css'), 'utf-8')

const rootBlock = archiveCss.match(/:root \{[\s\S]*?\n\}/)[0]
const lightBlock = archiveCss.match(/\[data-theme='light'\] \{[\s\S]*?\n\}/)[0]

const declarations = (text) =>
  Object.fromEntries(
    [...text.matchAll(/(--archive-[a-z-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()])
  )

const THEMES = {
  dark: declarations(rootBlock),
  light: declarations(lightBlock),
}

/** The glyph painted on top of the signal fill, read from the rule itself. */
const GLYPH = archiveCss
  .match(/\.archive-wordmark span, \.john-john-mark \{[^}]*\}/)[0]
  .match(/color:\s*(#[0-9a-f]{6})/i)[1]

const BACKDROPS = ['--archive-canvas', '--archive-surface', '--archive-surface-raised']

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

describe('archive signal tokens', () => {
  // --archive-signal and --archive-signal-text are the same accent pulling in
  // opposite directions: one is a fill a dark glyph sits on, the other is ink
  // on a pale page. Collapsing them back into one value breaks whichever role
  // loses the argument, so both roles are pinned here.
  it('defines the text role in both themes', () => {
    Object.entries(THEMES).forEach(([name, tokens]) => {
      expect(tokens['--archive-signal-text'], `${name} has no --archive-signal-text`).toBeTruthy()
    })
  })

  it('keeps the signal legible as text on every surface', () => {
    Object.entries(THEMES).forEach(([name, tokens]) => {
      const ink = tokens['--archive-signal-text']
      BACKDROPS.forEach((backdrop) => {
        const ratio = contrast(ink, tokens[backdrop])
        expect(
          ratio,
          `${name} ${ink} on ${backdrop} scores ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5)
      })
    })
  })

  it('keeps the wordmark glyph legible on the signal fill', () => {
    // Darkening the fill to help the text role would break this one.
    Object.entries(THEMES).forEach(([name, tokens]) => {
      const ratio = contrast(GLYPH, tokens['--archive-signal'])
      expect(
        ratio,
        `${name} glyph ${GLYPH} on --archive-signal scores ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(4.5)
    })
  })
})
