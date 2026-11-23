// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(resolve(import.meta.dirname, 'sw.js'), 'utf8')
const ORIGIN = 'https://pc.test'

function res(body, { status = 200, type = 'basic', headers = {}, redirected = false } = {}) {
  const r = new Response(body, { status, headers })
  Object.defineProperty(r, 'type', { value: type })
  Object.defineProperty(r, 'redirected', { value: redirected })
  return r
}

class FakeCache {
  constructor() { this.map = new Map() }
  async put(key, response) { const k = String(key?.url ?? key); this.map.delete(k); this.map.set(k, response) }
  async match(key, options = {}) {
    const k = String(key?.url ?? key)
    if (!options.ignoreSearch) return this.map.get(k)?.clone()
    const bare = u => u.split('?')[0]
    for (const [stored, response] of this.map) if (bare(stored) === bare(k)) return response.clone()
  }
  async keys() { return [...this.map.keys()].map(url => ({ url })) }
  async delete(key) { return this.map.delete(String(key?.url ?? key)) }
}

function load({ precache = [], fetchImpl, existingCaches = {}, windowClients = [] } = {}) {
  const store = new Map(Object.entries(existingCaches))
  const caches = {
    open: async name => { if (!store.has(name)) store.set(name, new FakeCache()); return store.get(name) },
    keys: async () => [...store.keys()],
    delete: async name => store.delete(name),
    has: async name => store.has(name),
    match: async (key, options = {}) => {
      for (const [name, cache] of store.entries()) {
        if (options.cacheName && options.cacheName !== name) continue
        const hit = await cache.match(key)
        if (hit) return hit
      }
    },
  }
  const listeners = {}
  const calls = { skipWaiting: 0, claim: 0, notifications: [], opened: [] }
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    __PC_SW_TEST_MODE__: true,
    addEventListener: (type, fn) => { listeners[type] = fn },
    skipWaiting: () => { calls.skipWaiting += 1 },
    registration: { showNotification: async (title, options) => { calls.notifications.push({ title, options }) } },
    clients: {
      claim: () => { calls.claim += 1 },
      matchAll: async () => windowClients,
      openWindow: async url => { calls.opened.push(url) },
    },
  }
  const code = SOURCE.replace('/*__PRECACHE__*/ []', JSON.stringify(precache)).replace("'__BUILD_ID__'", "'b2'")
  const context = vm.createContext({
    self, caches, Response, Request, Headers, URL, Promise, Set, Map, Array, JSON, setTimeout, clearTimeout,
    fetch: fetchImpl || (async () => { throw new Error('offline') }),
  })
  vm.runInContext(code, context)
  return { api: self.__PC_SW_TEST__, listeners, store, calls, caches }
}

const req = (path, init = {}) => {
  const { mode, ...rest } = init
  const request = new Request(ORIGIN + path, rest)
  if (mode) Object.defineProperty(request, 'mode', { value: mode })
  return request
}
const classifyPath = (api, path, init) => api.classify(req(path, init), new URL(ORIGIN + path))

describe('offline collection preference', () => {
  it.each(['pc-images-v1', 'pc-collection-originals-v1'])('does not recreate %s when disabled while opening the cache', async name => {
    const policy = new FakeCache()
    await policy.put(ORIGIN + '/__pc_offline_collection_policy__', new Response('on'))
    const { listeners, store, caches } = load({
      existingCaches: { 'pc-offline-policy-v1': policy, [name]: new FakeCache() },
      fetchImpl: async () => res('network', { headers: { 'Content-Type': 'image/jpeg' } }),
    })
    const open = caches.open
    caches.open = async cacheName => {
      if (cacheName === name) {
        await policy.put(ORIGIN + '/__pc_offline_collection_policy__', new Response('off'))
        store.delete(cacheName)
      }
      return open(cacheName)
    }
    let response
    const waits = []
    listeners.fetch({ request: req('/api/images/card/c1/large'), respondWith: p => { response = p }, waitUntil: p => waits.push(p) })
    expect(await (await response).text()).toBe('network')
    await Promise.all(waits)
    expect(store.has(name)).toBe(false)
  })

  it('does not serve or recreate image caches when automatic offline storage is off', async () => {
    const policy = new FakeCache()
    await policy.put(ORIGIN + '/__pc_offline_collection_policy__', new Response('off'))
    const originals = new FakeCache()
    await originals.put(ORIGIN + '/api/images/card/c1/large', res('saved', { headers: { 'Content-Type': 'image/jpeg' } }))
    const { listeners, store } = load({
      existingCaches: { 'pc-offline-policy-v1': policy, 'pc-collection-originals-v1': originals },
      fetchImpl: async () => res('network', { headers: { 'Content-Type': 'image/jpeg' } }),
    })
    let response
    const waits = []
    listeners.fetch({ request: req('/api/images/card/c1/large'), respondWith: p => { response = p }, waitUntil: p => waits.push(p) })
    expect(await (await response).text()).toBe('network')
    await Promise.all(waits)
    expect(store.has('pc-images-v1')).toBe(false)
  })
})

describe('placeholders', () => {
  it('is valid JS unreplaced and exposes helpers only in test mode', () => {
    const { api } = load()
    expect(Object.keys(api).sort()).toEqual(['classify', 'isCacheableImage', 'smallImagePath', 'trimCache', 'validatePrecache', 'validateShell'])
    expect(SOURCE).not.toMatch(/\bimport\s/)
    expect(SOURCE.split('\n').length).toBeLessThanOrEqual(350)
  })
})

describe('classify', () => {
  const precache = [{ url: '/assets/app-abc.js', revision: null }, { url: '/icons/a.png', revision: 'x' }]
  const { api } = load({ precache })

  it('routes precache, navigation and image requests', () => {
    expect(classifyPath(api, '/assets/app-abc.js')).toBe('precache')
    expect(classifyPath(api, '/icons/a.png')).toBe('precache')
    expect(classifyPath(api, '/collection', { mode: 'navigate' })).toBe('navigate')
    expect(classifyPath(api, '/', { mode: 'navigate' })).toBe('navigate')
    expect(classifyPath(api, '/api/images/card/en/x/high')).toBe('image')
    expect(classifyPath(api, '/api/images/set/en/x')).toBe('image')
    expect(classifyPath(api, '/api/pokedex/images/25')).toBe('image')
  })

  it('leaves everything else to the network', () => {
    expect(classifyPath(api, '/api/collection/')).toBe('none')
    expect(classifyPath(api, '/api/public/x')).toBe('none')
    expect(classifyPath(api, '/api/images/product/1')).toBe('none')
    expect(classifyPath(api, '/api/cards', { mode: 'navigate' })).toBe('none')
    expect(classifyPath(api, '/assets/other.js', { mode: 'navigate' })).toBe('none')
    expect(classifyPath(api, '/robots.txt', { mode: 'navigate' })).toBe('none')
    expect(classifyPath(api, '/api/images/card/en/x/high', { method: 'POST' })).toBe('none')
    expect(classifyPath(api, '/api/images/card/en/x/high', { headers: { Range: 'bytes=0-1' } })).toBe('none')
    expect(classifyPath(api, '/api/images/card/en/x/high', { headers: { Authorization: 'Bearer t' } })).toBe('none')
    expect(classifyPath(api, '/sw.js')).toBe('none')
    expect(classifyPath(api, '/sw.real.js')).toBe('none')
    expect(classifyPath(api, '/sw.kill.js')).toBe('none')
    expect(classifyPath(api, '/?pc_sw=off', { mode: 'navigate' })).toBe('none')
    expect(api.classify(req('/assets/app-abc.js'), new URL('https://elsewhere.test/assets/app-abc.js'))).toBe('none')
  })
})

describe('validatePrecache', () => {
  const { api } = load()
  const js = { url: '/assets/a.js' }
  it('accepts correct responses', () => {
    expect(api.validatePrecache(js, res('x', { headers: { 'Content-Type': 'text/javascript' } }))).toBe(true)
    expect(api.validatePrecache({ url: '/assets/a.css' }, res('x', { headers: { 'Content-Type': 'text/css' } }))).toBe(true)
    expect(api.validatePrecache({ url: '/icons/a.png' }, res('x', { headers: { 'Content-Type': 'image/png' } }))).toBe(true)
  })
  it('rejects HTML served as JavaScript, redirects and non-200', () => {
    expect(api.validatePrecache(js, res('<html>', { headers: { 'Content-Type': 'text/html' } }))).toBe(false)
    expect(api.validatePrecache(js, res('x', { headers: { 'Content-Type': 'text/javascript' }, redirected: true }))).toBe(false)
    expect(api.validatePrecache(js, res('x', { status: 404, headers: { 'Content-Type': 'text/javascript' } }))).toBe(false)
    expect(api.validatePrecache({ url: '/manifest.json' }, res('<html>', { headers: { 'Content-Type': 'text/html' } }))).toBe(false)
    expect(api.validatePrecache(js, res('x', { type: 'opaque', headers: { 'Content-Type': 'text/javascript' } }))).toBe(false)
  })
})

describe('validateShell', () => {
  const { api } = load()
  const set = new Set(['/assets/index-1.js', '/assets/index-1.css'])
  const shell = '<div id="root"></div><script src="/assets/index-1.js"></script><link href="/assets/index-1.css">'
  const html = { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  it('accepts a consistent shell', () => {
    expect(api.validateShell(res(shell, html), shell, set)).toBe(true)
  })
  it('rejects shells referencing assets outside the manifest or lacking the root', () => {
    const newer = shell.replace('index-1.js', 'index-2.js')
    expect(api.validateShell(res(newer, html), newer, set)).toBe(false)
    expect(api.validateShell(res('x', html), 'x', set)).toBe(false)
    expect(api.validateShell(res(shell, { headers: { 'Content-Type': 'text/plain' } }), shell, set)).toBe(false)
    expect(api.validateShell(res(shell, { ...html, redirected: true }), shell, set)).toBe(false)
  })
})

describe('smallImagePath', () => {
  const { api } = load()
  it('maps a large card image to its small sibling', () => {
    expect(api.smallImagePath('/api/images/card/sv1-1_en/large')).toBe('/api/images/card/sv1-1_en/small')
    expect(api.smallImagePath('/api/images/card/en/x/large')).toBe('/api/images/card/en/x/small')
  })
  it('returns null for anything else', () => {
    expect(api.smallImagePath('/api/images/card/sv1-1_en/small')).toBeNull()
    expect(api.smallImagePath('/api/images/card/large')).toBeNull()
    expect(api.smallImagePath('/api/images/set/x/large')).toBeNull()
    expect(api.smallImagePath('/api/pokedex/images/25')).toBeNull()
  })
})

describe('large image fallback', () => {
  const png = (body = 'img') => res(body, { headers: { 'Content-Type': 'image/png' } })
  const run = (listeners, request) => {
    const waits = []
    let responded
    listeners.fetch({ request, waitUntil: p => waits.push(p), respondWith: p => { responded = p } })
    return { responded, settle: () => Promise.all(waits) }
  }
  const withSmall = async (fetchImpl, smallUrl = '/api/images/card/c1/small') => {
    const images = new FakeCache()
    await images.put(ORIGIN + smallUrl, png('small'))
    return { images, ...load({ fetchImpl, existingCaches: { 'pc-images-v1': images } }) }
  }

  it.each(['small', 'large'])('serves downloaded originals for %s without another network request', async size => {
    const originals = new FakeCache()
    await originals.put(ORIGIN + '/api/images/card/c1/large', png('original'))
    const fetchImpl = async () => { throw new Error('network must not be used') }
    const { listeners } = load({ fetchImpl, existingCaches: { 'pc-collection-originals-v1': originals } })
    const { responded } = run(listeners, req(`/api/images/card/c1/${size}`))
    expect(await (await responded).text()).toBe('original')
    expect((await originals.keys()).length).toBe(1)
  })

  it('serves the cached small copy when the network fails', async () => {
    const { listeners } = await withSmall(async () => { throw new Error('offline') })
    const { responded } = run(listeners, req('/api/images/card/c1/large'))
    expect(await (await responded).text()).toBe('small')
  })

  it('matches the small copy ignoring the query string', async () => {
    const { listeners } = await withSmall(async () => { throw new Error('offline') }, '/api/images/card/c1/small?v=3')
    const { responded } = run(listeners, req('/api/images/card/c1/large?v=3'))
    expect(await (await responded).text()).toBe('small')
  })

  it('falls back after 4 s when the network hangs, and stores a late answer', async () => {
    let answer
    const { listeners, images } = await withSmall(() => new Promise(resolve => { answer = resolve }))
    const started = Date.now()
    const { responded, settle } = run(listeners, req('/api/images/card/c1/large'))
    expect(await (await responded).text()).toBe('small')
    expect(Date.now() - started).toBeGreaterThanOrEqual(3900)
    answer(png('large'))
    await settle()
    expect(await (await images.match(ORIGIN + '/api/images/card/c1/large')).text()).toBe('large')
  }, 10000)

  it('uses the network answer without delay and caches it', async () => {
    const { listeners, images } = await withSmall(async () => png('large'))
    const started = Date.now()
    const { responded, settle } = run(listeners, req('/api/images/card/c1/large'))
    expect(await (await responded).text()).toBe('large')
    expect(Date.now() - started).toBeLessThan(1000)
    await settle()
    expect(await (await images.match(ORIGIN + '/api/images/card/c1/large')).text()).toBe('large')
  })

  it('without a small copy the network error or late answer is passed through', async () => {
    const failing = load({ fetchImpl: async () => { throw new Error('offline') } })
    await expect(run(failing.listeners, req('/api/images/card/c9/large')).responded).rejects.toThrow('offline')
    const late = load({ fetchImpl: () => new Promise(resolve => setTimeout(() => resolve(png('late')), 4300)) })
    const { responded } = run(late.listeners, req('/api/images/card/c9/large'))
    expect(await (await responded).text()).toBe('late')
  }, 10000)
})

describe('isCacheableImage', () => {
  const { api } = load()
  const ok = { 'Content-Type': 'image/webp' }
  it('accepts plain public images', () => {
    expect(api.isCacheableImage(res('x', { headers: ok }))).toBe(true)
  })
  it('rejects private, no-store, Vary: Authorization, non-images and redirects', () => {
    expect(api.isCacheableImage(res('x', { headers: { ...ok, 'Cache-Control': 'private' } }))).toBe(false)
    expect(api.isCacheableImage(res('x', { headers: { ...ok, 'Cache-Control': 'no-store' } }))).toBe(false)
    expect(api.isCacheableImage(res('x', { headers: { ...ok, Vary: 'Authorization' } }))).toBe(false)
    expect(api.isCacheableImage(res('x', { headers: { 'Content-Type': 'text/html' } }))).toBe(false)
    expect(api.isCacheableImage(res('x', { headers: ok, redirected: true }))).toBe(false)
    expect(api.isCacheableImage(res('x', { headers: ok, status: 206 }))).toBe(false)
  })
})

describe('trimCache', () => {
  it('drops the oldest entries first', async () => {
    const { api } = load()
    const cache = new FakeCache()
    for (let i = 0; i < 805; i += 1) await cache.put(`/i/${i}`, res('x'))
    await api.trimCache(cache, 800)
    const keys = (await cache.keys()).map(k => k.url)
    expect(keys).toHaveLength(800)
    expect(keys[0]).toBe('/i/5')
  })
})

describe('lifecycle', () => {
  const precache = [{ url: '/assets/a.js', revision: null }]
  const shellHtml = '<div id="root"></div><script src="/assets/a.js"></script>'
  const goodFetch = async url => {
    if (url === '/') return res(shellHtml, { headers: { 'Content-Type': 'text/html' } })
    return res('x', { headers: { 'Content-Type': 'text/javascript' } })
  }
  const run = (listeners, type, event) => {
    let pending
    listeners[type]({ ...event, waitUntil: p => { pending = p }, respondWith: p => { pending = p } })
    return pending
  }

  it('installs without skipWaiting and stores precache plus shell', async () => {
    const { listeners, store, calls } = load({ precache, fetchImpl: goodFetch })
    await run(listeners, 'install', {})
    expect([...store.keys()].sort()).toEqual(['pc-precache-b2', 'pc-shell-b2'])
    expect(calls.skipWaiting).toBe(0)
  })

  it('rejects the install when any entry fails validation', async () => {
    const html = async () => res('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })
    const { listeners } = load({ precache, fetchImpl: html })
    await expect(run(listeners, 'install', {})).rejects.toThrow()
  })

  it('rejects the install when the shell references an unknown asset', async () => {
    const fetchImpl = async url => (url === '/'
      ? res('<div id="root"></div><script src="/assets/zzz.js"></script>', { headers: { 'Content-Type': 'text/html' } })
      : goodFetch(url))
    const { listeners } = load({ precache, fetchImpl })
    await expect(run(listeners, 'install', {})).rejects.toThrow()
  })

  it('activate deletes only stale precache and shell caches, and never claims', async () => {
    const existingCaches = {
      'pc-precache-old': new FakeCache(), 'pc-shell-old': new FakeCache(), 'pc-precache-b2': new FakeCache(),
      'pc-shell-b2': new FakeCache(), 'pc-images-v1': new FakeCache(), 'other': new FakeCache(),
    }
    const { listeners, store, calls } = load({ existingCaches })
    await run(listeners, 'activate', {})
    expect([...store.keys()].sort()).toEqual(['other', 'pc-images-v1', 'pc-precache-b2', 'pc-shell-b2'])
    expect(calls.claim).toBe(0)
    expect(calls.skipWaiting).toBe(0)
  })

  it('skipWaiting happens only on the SKIP_WAITING message', () => {
    const { listeners, calls } = load()
    listeners.message({ data: { type: 'GET_VERSION' }, source: { postMessage: () => {} } })
    expect(calls.skipWaiting).toBe(0)
    listeners.message({ data: { type: 'SKIP_WAITING' } })
    expect(calls.skipWaiting).toBe(1)
  })

  it('answers GET_VERSION with the build id', () => {
    const { listeners } = load()
    const messages = []
    listeners.message({ data: { type: 'GET_VERSION' }, source: { postMessage: m => messages.push(m) } })
    expect(messages[0]).toMatchObject({ type: 'VERSION', buildId: 'b2' })
  })

  it('navigation falls back to the stored shell, then to the inline page', async () => {
    const shell = res(shellHtml, { headers: { 'Content-Type': 'text/html' } })
    const stored = new FakeCache()
    await stored.put('/shell', shell)
    const withShell = load({ existingCaches: { 'pc-shell-b2': stored } })
    const nav = { request: req('/collection', { mode: 'navigate' }) }
    const fromShell = await run(withShell.listeners, 'fetch', nav)
    expect(await fromShell.text()).toBe(shellHtml)

    const empty = load()
    const inline = await run(empty.listeners, 'fetch', nav)
    expect(inline.status).toBe(200)
    expect(await inline.text()).toContain('You are offline')
  })

  it('navigation falls back after the 2.5 s timer when the network hangs', async () => {
    const never = () => new Promise(() => {})
    const { listeners } = load({ fetchImpl: never })
    const started = Date.now()
    const inline = await run(listeners, 'fetch', { request: req('/collection', { mode: 'navigate' }) })
    expect(Date.now() - started).toBeGreaterThanOrEqual(2400)
    expect(await inline.text()).toContain('Du bist offline')
  }, 10000)

  it('does not respond to API requests', () => {
    const { listeners } = load()
    let responded = false
    listeners.fetch({ request: req('/api/collection/'), respondWith: () => { responded = true } })
    expect(responded).toBe(false)
  })
})

describe('web push', () => {
  const run = (listeners, type, event) => {
    let pending
    listeners[type]({ ...event, waitUntil: p => { pending = p } })
    return pending
  }
  const pushEvent = payload => ({
    data: payload === null ? null : { json: () => (typeof payload === 'function' ? payload() : payload) },
  })
  const declarative = (notification) => ({ web_push: 8030, notification })

  it('shows the Declarative Web Push notification', async () => {
    const { listeners, calls } = load()
    await run(listeners, 'push', pushEvent(declarative({ title: 'PokéCollector', body: 'Pikachu price alert', navigate: '/wishlist' })))
    expect(calls.notifications).toEqual([{
      title: 'PokéCollector',
      options: { body: 'Pikachu price alert', data: { navigate: '/wishlist' } },
    }])
  })

  it('always shows a notification, falling back to a generic one without a usable title', async () => {
    const payloads = [
      null,
      () => { throw new SyntaxError('not json') },
      {},
      [],
      'text',
      declarative({ body: 'no title', navigate: 'https://evil.test/' }),
      declarative({ title: 42 }),
      declarative({ title: '' }),
    ]
    for (const payload of payloads) {
      const { listeners, calls } = load()
      await run(listeners, 'push', pushEvent(payload))
      expect(calls.notifications).toHaveLength(1)
      expect(calls.notifications[0].title).toBe('PokéCollector')
      expect(calls.notifications[0].options).toEqual({ body: '', data: { navigate: '/' } })
    }
  })

  it('accepts a flat {title, body} payload from older senders', async () => {
    const { listeners, calls } = load()
    await run(listeners, 'push', pushEvent({ title: 'Hi', body: 'There' }))
    expect(calls.notifications[0]).toMatchObject({ title: 'Hi', options: { body: 'There' } })
  })

  const click = (navigate, windowClients) => {
    const { listeners, calls } = load({ windowClients })
    let closed = 0
    const pending = run(listeners, 'notificationclick', {
      notification: { close: () => { closed += 1 }, data: navigate === undefined ? undefined : { navigate } },
    })
    return { pending, calls, closed: () => closed }
  }

  it('opens a same-origin path in a new window when the app is closed', async () => {
    const { pending, calls, closed } = click('/wishlist', [])
    await pending
    expect(closed()).toBe(1)
    expect(calls.opened).toEqual([ORIGIN + '/wishlist'])
  })

  it('focuses and navigates an open app window instead of opening another', async () => {
    const client = { url: ORIGIN + '/collection', focused: 0, navigated: [], focus: async function () { this.focused += 1 }, navigate: async function (u) { this.navigated.push(u) } }
    const { pending, calls } = click('/wishlist', [{ url: 'https://other.test/', focus: async () => { throw new Error('wrong origin') } }, client])
    await pending
    expect(client.focused).toBe(1)
    expect(client.navigated).toEqual([ORIGIN + '/wishlist'])
    expect(calls.opened).toEqual([])
  })

  it('opens a new window when an existing one cannot be navigated', async () => {
    const client = { url: ORIGIN + '/', focus: async () => {}, navigate: async () => { throw new Error('uncontrolled') } }
    const { pending, calls } = click('/wishlist', [client])
    await pending
    expect(calls.opened).toEqual([ORIGIN + '/wishlist'])
  })

  it('never navigates to another origin', async () => {
    for (const target of ['https://evil.test/phish', '//evil.test/x', 'javascript:alert(1)', 'http://pc.test/x']) {
      const { pending, calls } = click(target, [])
      await pending
      expect(calls.opened).toEqual([ORIGIN + '/'])
    }
    const { pending, calls } = click(undefined, [])
    await pending
    expect(calls.opened).toEqual([ORIGIN + '/'])
  })

  it('leaves non-push behaviour alone: no skipWaiting or claim', async () => {
    const { listeners, calls } = load()
    await run(listeners, 'push', pushEvent(declarative({ title: 'x' })))
    expect(calls.skipWaiting).toBe(0)
    expect(calls.claim).toBe(0)
  })
})
