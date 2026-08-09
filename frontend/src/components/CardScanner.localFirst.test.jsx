import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

test('keeps scanning local-first and leaves HoloDex as the phone scanner', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const scanner = readFileSync(resolve(here, './CardScanner.jsx'), 'utf-8')
    const en = readFileSync(resolve(here, '../i18n/en.js'), 'utf-8')

    expect(scanner).not.toContain('recognizeCard')
    expect(scanner).not.toContain('type="file"')
    expect(scanner).not.toContain('External scan is opt-in')
    expect(en).toContain('Scanner Boundary')
    expect(en).toContain('Use HoloDex on your phone for scanning and AI grading')
    expect(en).toContain("never treats a scan as owned")
    expect(en).not.toMatch(/Gemini|External scanner API key|Photos leave this local app only when you choose to scan/)
})
