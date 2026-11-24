import { describe, expect, it, vi } from 'vitest'
import { applyDebugParams, debugFlag } from './debug.js'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
    removeItem: key => { delete data[key] },
  }
}

const fakeHistory = () => ({ state: null, replaceState: vi.fn() })

describe('debug flags', () => {
  it('reads only allow-listed names set to "1"', () => {
    const storage = memoryStorage({ 'pc.debug.forceQuota': '1', 'pc.debug.other': '1', 'pc.debug.forceUnreachable': '0' })
    expect(debugFlag('forceQuota', storage)).toBe(true)
    expect(debugFlag('forceUnreachable', storage)).toBe(false)
    expect(debugFlag('other', storage)).toBe(false)
  })

  it('is false when storage throws or is missing', () => {
    expect(debugFlag('forceQuota', { getItem() { throw new Error('denied') } })).toBe(false)
    expect(debugFlag('forceQuota', null)).toBe(false)
  })

  it('sets known flags, ignores unknown ones and strips the parameter', () => {
    const storage = memoryStorage()
    const history = fakeHistory()
    const applied = applyDebugParams({
      location: { href: 'https://cards.example.com/scans?x=1&pc_debug=forceLostResponse,forceQuota,bogus#top' },
      history,
      storage,
    })
    expect(applied).toEqual(['forceLostResponse', 'forceQuota'])
    expect(storage.data).toEqual({ 'pc.debug.forceLostResponse': '1', 'pc.debug.forceQuota': '1' })
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/scans?x=1#top')
  })

  it('"off" clears every flag', () => {
    const storage = memoryStorage({
      'pc.debug.forceLostResponse': '1', 'pc.debug.forceQuota': '1', 'pc.debug.forceUnreachable': '1',
    })
    applyDebugParams({ location: { href: 'https://x.test/?pc_debug=off' }, history: fakeHistory(), storage })
    expect(storage.data).toEqual({})
  })

  it('does nothing without the parameter', () => {
    const history = fakeHistory()
    expect(applyDebugParams({ location: { href: 'https://x.test/' }, history, storage: memoryStorage() })).toEqual([])
    expect(history.replaceState).not.toHaveBeenCalled()
  })

  it('survives a throwing storage', () => {
    const storage = { setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
    const history = fakeHistory()
    expect(() => applyDebugParams({ location: { href: 'https://x.test/?pc_debug=forceQuota' }, history, storage })).not.toThrow()
    expect(history.replaceState).toHaveBeenCalled()
  })
})
