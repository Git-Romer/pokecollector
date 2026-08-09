import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

test('uses Chase Cards language instead of legacy wish language', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './ArchiveCommandBar.jsx'), 'utf-8')
    expect(source).toContain('open Chase Cards')
    expect(source).not.toMatch(/saved\s+wish/)
})
