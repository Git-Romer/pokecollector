import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(resolve(here, './App.jsx'), 'utf-8')

describe('route contracts', () => {
    it('enters My Collection from root and legacy dashboard routes', () => {
        expect(appSource).toContain('<Route index element={<Navigate replace to="/collection"/>}/>')
        expect(appSource).toContain('<Route path="dashboard" element={<Navigate replace to="/collection"/>}/>')
    })

    it('keeps old Sets and Analytics paths as aliases for the current primary nav', () => {
        expect(appSource).toContain('<Route path="all-cards" element={<Sets/>}/>')
        expect(appSource).toContain('<Route path="sets" element={<Navigate replace to="/all-cards"/>}/>')
        expect(appSource).toContain('<Route path="sets/:setId" element={<SetRedirect/>}/>')
        expect(appSource).toContain('return <Navigate replace to={`/all-cards/${setId}`}/>')
        expect(appSource).toContain('<Route path="trends" element={<Analytics/>}/>')
        expect(appSource).toContain('<Route path="analytics" element={<Navigate replace to="/trends"/>}/>')
    })

    it('keeps old Binders paths as aliases for Boxes without dropping ids', () => {
        expect(appSource).toContain('<Route path="boxes" element={lazyRoute(<Boxes/>)} />'.replace(' />', '/>'))
        expect(appSource).toContain('<Route path="binders" element={<Navigate replace to="/boxes"/>}/>')
        expect(appSource).toContain('<Route path="binders/:binderId" element={<BinderRedirect/>}/>')
        expect(appSource).toContain('return <Navigate replace to={`/boxes/${binderId}`}/>')
    })
})
