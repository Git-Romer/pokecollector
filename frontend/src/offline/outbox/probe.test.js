import { describe, expect, it, vi } from 'vitest'
import { createReachability, probe } from './probe.js'

const HEALTH = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noDebug = () => false

describe('probe', () => {
  it('is reachable on the health payload and records serverInfo; sends no Authorization', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(HEALTH))
    const result = await probe({ fetchImpl, now: () => 123, debug: noDebug })
    expect(result).toEqual({
      state: 'reachable',
      serverInfo: { version: '1.51.6', apiLevel: 1, features: ['idempotency-v1'], fetchedAt: 123 },
    })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/health')
    expect(init.cache).toBe('no-store')
    expect(init.headers?.Authorization).toBeUndefined()
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('an older server (no api_level / features) is reachable with empty features', async () => {
    const result = await probe({ fetchImpl: async () => json({ status: 'ok', service: 'pokemon-tcg-collection', version: '1.50' }), debug: noDebug })
    expect(result.serverInfo).toMatchObject({ apiLevel: 0, features: [] })
  })

  it('an HTML 200 is captive', async () => {
    const fetchImpl = async () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect(await probe({ fetchImpl, debug: noDebug })).toEqual({ state: 'captive' })
  })

  it.each([
    [{ status: 'ok', service: 'something-else' }],
    [{ status: 'degraded', service: 'pokemon-tcg-collection' }],
    [null],
  ])('wrong JSON %j is captive', async body => {
    expect(await probe({ fetchImpl: async () => json(body), debug: noDebug })).toEqual({ state: 'captive' })
  })

  it('an opaque redirect and non-200 non-5xx answers are captive', async () => {
    expect((await probe({ fetchImpl: async () => ({ type: 'opaqueredirect', status: 0 }), debug: noDebug })).state).toBe('captive')
    expect((await probe({ fetchImpl: async () => json({}, 404), debug: noDebug })).state).toBe('captive')
  })

  it('5xx and rejected requests are unreachable', async () => {
    expect((await probe({ fetchImpl: async () => json({}, 503), debug: noDebug })).state).toBe('unreachable')
    expect((await probe({ fetchImpl: async () => { throw new TypeError('Failed to fetch') }, debug: noDebug })).state).toBe('unreachable')
  })

  it('a hanging request times out as unreachable', async () => {
    const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    expect(await probe({ fetchImpl, timeoutMs: 20, debug: noDebug })).toEqual({ state: 'unreachable' })
  })

  it('forceUnreachable never touches the network', async () => {
    const fetchImpl = vi.fn()
    expect(await probe({ fetchImpl, debug: name => name === 'forceUnreachable' })).toEqual({ state: 'unreachable' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('createReachability', () => {
  it('shows the banner after two non-reachable results and clears on the first reachable one', () => {
    const onlineManager = { setOnline: vi.fn() }
    const r = createReachability({ onlineManager, isOnLine: () => true })
    expect(r.record({ state: 'unreachable' }).bannerVisible).toBe(false)
    expect(r.record({ state: 'captive' }).bannerVisible).toBe(true)
    expect(r.record({ state: 'reachable' })).toMatchObject({ bannerVisible: false, consecutiveFailures: 0, state: 'reachable' })
    expect(onlineManager.setOnline.mock.calls.map(call => call[0])).toEqual([false, false, true])
  })

  it('navigator.onLine === false shows the banner immediately but never declares reachability', () => {
    const r = createReachability({ isOnLine: () => false })
    expect(r.snapshot()).toMatchObject({ state: 'unknown', bannerVisible: true })
  })

  it('walks PROBE_BACKOFF_MS and resets after a reachable probe', () => {
    const r = createReachability({ isOnLine: () => true })
    const delays = []
    for (let i = 0; i < 6; i += 1) {
      r.record({ state: 'unreachable' })
      delays.push(r.nextDelayMs())
    }
    expect(delays).toEqual([15000, 30000, 60000, 120000, 120000, 120000])
    r.record({ state: 'reachable' })
    r.record({ state: 'unreachable' })
    expect(r.nextDelayMs()).toBe(15000)
  })

  it('lengthens the interval while the browser says it is offline', () => {
    const r = createReachability({ isOnLine: () => false })
    r.record({ state: 'unreachable' })
    expect(r.nextDelayMs()).toBe(120000)
  })
})
