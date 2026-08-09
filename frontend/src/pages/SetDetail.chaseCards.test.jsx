import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import en from '../i18n/en'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, './SetDetail.jsx'), 'utf-8')

test('set detail uses real set heading and manual missing-to-Chase Cards action', () => {
    expect(source).toContain('text={set?.name || ""}')
    expect(source).toContain('const missingCards = cards.filter(card => !card.owned)')
    expect(source).toContain('addMissingToChaseCards')
    expect(source).toContain("queryClient.invalidateQueries({queryKey: ['set-checklist', setId]})")
    expect(source).toContain('Add ${missingCount} missing to Chase Cards')
    expect(source).toContain('Manual action. Owned cards stay owned; missing cards become Chase Cards.')
})

test('all cards hero uses expansion language', () => {
    expect(en.sets.topSet).toBe('Closest Expansion')
})
