import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './CardSearch.jsx'), 'utf-8')

test('Card Search opens as full catalog instead of showing stale no-query prompt', () => {
    expect(source).toContain('enabled: true')
    expect(source).toContain('data.data?.map')
    expect(source).not.toContain('!hasQuery && !data?.items?.length')
    expect(source).not.toContain("{t('cardSearch.trySearch')}")
})
