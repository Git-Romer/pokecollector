import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './Discover.jsx'), 'utf-8')

test('Discover uses Chase Cards language, not legacy wishlist copy', () => {
    expect(source).toContain('Open Chase Cards')
    expect(source).toContain('Track, Chase, and Grail cards')
    expect(source).not.toContain('Open wishlist')
    expect(source).not.toContain('Open\n            wishlist')
})
