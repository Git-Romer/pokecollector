import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, resolve} from 'node:path'
import {describe, expect, it} from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(resolve(here, './App.jsx'), 'utf-8')

describe('route contracts', () => {
    it('mounts Collection Overview at root and redirects the legacy dashboard there', () => {
        expect(appSource).toContain('<Route index element={<Home/>}/>')
        expect(appSource).toContain('<Route path="dashboard" element={<Navigate replace to="/"/>}/>')
        expect(appSource).toContain('<Route path="collection" element={<Collection/>}/>')
    })

    it('keeps old Sets and Analytics paths as aliases for the current primary nav', () => {
        expect(appSource).toContain('<Route path="all-cards" element={<Sets/>}/>')
        expect(appSource).toContain('<Route path="sets" element={<Navigate replace to="/all-cards"/>}/>')
        expect(appSource).toContain('<Route path="sets/:setId" element={<SetRedirect/>}/>')
        expect(appSource).toContain('return <Navigate replace to={`/all-cards/${setId}`}/>')
        expect(appSource).toContain('<Route path="trends" element={<Analytics/>}/>')
        expect(appSource).toContain('<Route path="analytics" element={<Navigate replace to="/trends"/>}/>')
    })

    it('keeps Binders as direct routes without replacing them with Boxes', () => {
        expect(appSource).toContain('<Route path="binders" element={lazyRoute(<Binders/>)}/>')
        expect(appSource).toContain('<Route path="binders/:binderId" element={lazyRoute(<BinderDetail/>)}/>')
        expect(appSource).not.toContain('<Route path="boxes"')
        expect(appSource).not.toContain('to="/boxes"')
        expect(appSource).not.toContain('to={`/boxes/${binderId}`}')
    })

    it('does not lazy-load the retired dashboard implementation', () => {
        expect(appSource).not.toContain("lazy(() => import('./pages/Dashboard'))")
        expect(appSource).toContain('<Route path="dashboard" element={<Navigate replace to="/"/>}/>')
    })
})
