import { describe, it, expect, vi, afterEach } from 'vitest'
import { searchPublicCards } from './publicCardSearch'
afterEach(() => vi.unstubAllGlobals())
describe('public catalogue uses app search semantics', () => {
 it('matches accentless names, hyphenated names and one-character searches', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok:true, json:async () => [
   { id:'test-1', name:'Flabébé' }, { id:'test-2', name:'Ho-Oh' }, { id:'test-3', name:'Porygon-Z' },
  ] })))
  expect((await searchPublicCards('Flabebe','en')).map(c=>c.id)).toEqual(['test-1'])
  expect((await searchPublicCards('Ho-Oh','en')).map(c=>c.id)).toEqual(['test-2'])
  expect((await searchPublicCards('Porygon-Z','en')).map(c=>c.id)).toEqual(['test-3'])
  expect((await searchPublicCards('f','en')).map(c=>c.id)).toEqual(['test-1'])
  expect(fetch).toHaveBeenCalledTimes(1)
 })
 it('resolves real official abbreviations without English-only heuristics and ignores leading zeros', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => {
   if(url.endsWith('/sets/ssp')) return {status:404}
   const data=url.includes('abbreviation.official') ? [{id:'sv08'}] : {id:'sv08',name:'Stürmische Funken',cards:[{id:'sv08-136',localId:'136',name:'Test'}]}
   return {ok:true,json:async()=>data}
  }))
  const cards=await searchPublicCards('SSP 0136','de')
  expect(cards.map(c=>c.id)).toEqual(['sv08-136'])
  expect(fetch.mock.calls.every(([url])=>url.includes('/de/'))).toBe(true)
 })
 it('does not retain a failed index load, and rejects unsupported languages', async () => {
  // A different exact card path is intentionally not covered by the EN index cache.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ok:true,json:async()=>({id:'retry-9',name:'Retry'})}))
  await expect(searchPublicCards('retry-9','en')).rejects.toThrow('offline')
  expect((await searchPublicCards('retry-9','en'))[0].id).toBe('retry-9')
  await expect(searchPublicCards('test','xx')).rejects.toThrow('Unsupported')
 })
})
