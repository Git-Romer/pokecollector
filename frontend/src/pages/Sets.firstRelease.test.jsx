import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import en from '../i18n/en'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './Sets.jsx'), 'utf-8')

test('All Cards uses Fluent neutral progress instead of HP-style bars', () => {
    expect(source).toContain("import {ProgressBar} from '@fluentui/react-components'")
    expect(source).toContain('<ProgressBar value={Math.min(1, Math.max(0, pct / 100))}/>')
    expect(source).not.toMatch(/hp-bar-track|hp-bar-fill|HP-style progress/)
    expect(en.sets.refreshFailed).toBe('Failed to refresh expansions')
    expect(en.achievements.setMaster5Desc).toContain('expansions')
    expect(en.achievements.diversifierDesc).toContain('expansions')
})
