import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'
import en from './en'
import de from './de'
import {APP_LANGUAGES} from '../utils/appLanguages'

const here = dirname(fileURLToPath(import.meta.url))
const context = readFileSync(resolve(here, '../contexts/SettingsContext.jsx'), 'utf-8')

/** Mirrors the resolver in SettingsContext so the contract is testable. */
function makeT(msgs) {
    return (path, params) => {
        const read = (source) => {
            let val = source
            for (const part of path.split('.')) {
                val = val?.[part]
                if (val === undefined) return undefined
            }
            return val
        }
        const val = read(msgs) ?? read(en) ?? path
        if (typeof val !== 'string' || !params) return val
        return val.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
    }
}

describe('translation resolver', () => {
    it('never falls back to German', () => {
        // A key missing from the active locale used to resolve against German,
        // so any gap served German text to every user — reported as #283, #285.
        const sparse = {common: {}}
        const t = makeT(sparse)
        expect(t('common.error')).toBe(en.common.error)
        expect(t('common.error')).not.toBe(de.common.error)
    })

    it('returns the key path when a string is missing everywhere', () => {
        expect(makeT({})('nope.not.here')).toBe('nope.not.here')
    })

    it('fills placeholders from params', () => {
        const t = makeT(en)
        const out = t('binders.deleteConfirm', {name: 'Base Set Holos'})
        expect(out).toContain('Base Set Holos')
        expect(out).not.toContain('{name}')
    })

    it('leaves unknown placeholders untouched rather than printing undefined', () => {
        expect(makeT({a: {b: 'hi {who}'}})('a.b', {other: 1})).toBe('hi {who}')
    })

    it('defaults a fresh install to English, not German', () => {
        expect(context).toMatch(/language: 'en'/)
        expect(context).not.toMatch(/language: 'de'/)
        expect(context).not.toMatch(/translations\.de/)
    })



    it('keeps the first-release product UI English-only', () => {
        expect(APP_LANGUAGES).toEqual([{value: 'en', label: "John John's PC · English"}])
        expect(context).toContain("const APP_UI_LANGUAGE = 'en'")
        expect(context).toContain('language: APP_UI_LANGUAGE')
    })

    it('keeps destructive confirmations specific about the object', () => {
        // "Delete?" with no object was the worst offender.
        ;['collection.removeConfirm', 'wishlist.removeConfirm',
            'binders.deleteConfirm', 'products.deleteConfirm'].forEach((key) => {
            const raw = key.split('.').reduce((o, k) => o[k], en)
            expect(raw, `${key} should name what is being acted on`).toContain('{name}')
        })
    })
})
