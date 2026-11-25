/* PokéCollector service worker (docs/PWA_OFFLINE_DESIGN.md §6.3). Classic script, no imports.
   Caches only the app's own static files and public card images. It never caches API data. */
const BUILD_ID = '__BUILD_ID__'
const PRECACHE = /*__PRECACHE__*/ []

const PRECACHE_NAME = 'pc-precache-' + BUILD_ID
const SHELL_NAME = 'pc-shell-' + BUILD_ID
const IMAGES_NAME = 'pc-images-v1'
const SHELL_KEY = '/shell'
const IMAGE_CAP = 800
const NAV_TIMEOUT_MS = 2500
const LARGE_IMAGE_TIMEOUT_MS = 4000
const IMAGE_PREFIXES = ['/api/images/card/', '/api/images/set/', '/api/pokedex/images/']

const OFFLINE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>PokéCollector</title></head>'
  + '<body style="margin:0;padding:2rem;background:#08080f;color:#fff;font-family:system-ui,sans-serif">'
  + '<p>You are offline and this page is not saved on this device yet. Reconnect and reload.</p>'
  + '<p>Du bist offline und diese Seite ist noch nicht auf diesem Gerät gespeichert. Verbinde dich und lade neu.</p>'
  + '</body></html>'

const precacheUrls = new Set(PRECACHE.map(entry => entry.url))

function hasExtension(pathname) {
  const last = pathname.split('/').pop() || ''
  return last.includes('.')
}

// Returns 'none' | 'precache' | 'navigate' | 'image'.
function classify(req, url) {
  if (req.method !== 'GET') return 'none'
  if (url.origin !== self.location.origin) return 'none'
  if (req.headers.has('Range') || req.headers.has('Authorization')) return 'none'
  if (url.pathname === '/sw.js' || /^\/sw\.[a-z]+\.js$/.test(url.pathname)) return 'none'
  if (url.searchParams.has('pc_sw')) return 'none'
  if (precacheUrls.has(url.pathname)) return 'precache'
  if (req.mode === 'navigate' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/assets/')
    && !hasExtension(url.pathname)) return 'navigate'
  if (IMAGE_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return 'image'
  return 'none'
}

function extensionOf(url) {
  const match = /\.([a-z0-9]+)$/i.exec(url.split('?')[0])
  return match ? match[1].toLowerCase() : ''
}

function validatePrecache(entry, res) {
  if (!res || !res.ok || res.status !== 200) return false
  if (res.type !== 'basic' || res.redirected) return false
  const type = (res.headers.get('Content-Type') || '').toLowerCase()
  const ext = extensionOf(entry.url)
  if (ext === 'js' || ext === 'mjs') return type.includes('javascript')
  if (ext === 'css') return type.includes('text/css')
  return !type.includes('text/html')
}

function validateShell(res, text, precacheSet) {
  if (!res || res.status !== 200 || res.redirected || res.type !== 'basic') return false
  if (!(res.headers.get('Content-Type') || '').includes('text/html')) return false
  if (!text.includes('id="root"')) return false
  for (const match of text.matchAll(/(?:src|href)="(\/assets\/[^"#?]+)"/g)) {
    if (!precacheSet.has(match[1])) return false
  }
  return true
}

function isCacheableImage(res) {
  if (!res || res.status !== 200 || res.type !== 'basic' || res.redirected) return false
  if (!(res.headers.get('Content-Type') || '').toLowerCase().startsWith('image/')) return false
  const cacheControl = (res.headers.get('Cache-Control') || '').toLowerCase()
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) return false
  if ((res.headers.get('Vary') || '').toLowerCase().includes('authorization')) return false
  return true
}

async function trimCache(cache, max) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i])
}

async function precacheOne(cache, entry) {
  if (entry.url.startsWith('/assets/')) {
    const old = await caches.match(entry.url)
    if (old && validatePrecache(entry, old)) {
      await cache.put(entry.url, old.clone())
      return
    }
  }
  const res = await fetch(entry.url, { cache: 'reload', credentials: 'same-origin' })
  if (!validatePrecache(entry, res)) throw new Error('precache validation failed: ' + entry.url)
  await cache.put(entry.url, res)
}

async function precacheAll() {
  const cache = await caches.open(PRECACHE_NAME)
  const queue = PRECACHE.slice()
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) await precacheOne(cache, entry)
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const res = await fetch('/', { cache: 'reload', credentials: 'same-origin' })
  const text = await res.clone().text()
  if (!validateShell(res, text, precacheUrls)) throw new Error('shell validation failed')
  await (await caches.open(SHELL_NAME)).put(SHELL_KEY, res)
}

async function maybeStoreShell(res) {
  // Only refresh an existing shell: after the kill worker deleted the caches, a late
  // navigation handled by this (unregistered) worker must not recreate them.
  if (!(await caches.has(SHELL_NAME))) return
  const text = await res.clone().text()
  if (validateShell(res, text, precacheUrls)) {
    await (await caches.open(SHELL_NAME)).put(SHELL_KEY, res)
  }
}

async function offlineShell() {
  const shell = await caches.match(SHELL_KEY)
  return shell || new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function handleNavigate(event) {
  const network = fetch(event.request)
  const timer = new Promise(resolve => setTimeout(() => resolve(null), NAV_TIMEOUT_MS))
  const respond = Promise.race([network, timer]).then(async res => {
    if (res) {
      if (res.ok) event.waitUntil(maybeStoreShell(res.clone()).catch(() => {}))
      return res
    }
    // Timer won: keep the network request alive so the shell can refresh later.
    event.waitUntil(network.then(late => (late.ok ? maybeStoreShell(late.clone()) : null)).catch(() => {}))
    return offlineShell()
  }).catch(() => offlineShell())
  event.respondWith(respond)
}

// '/api/images/card/{id}/large' -> '/api/images/card/{id}/small', or null for any other path.
function smallImagePath(pathname) {
  const match = /^(\/api\/images\/card\/.+)\/large$/.exec(pathname)
  return match ? match[1] + '/small' : null
}

async function imageCachingEnabled() {
  try {
    const policy = await caches.match(new URL('/__pc_offline_collection_policy__', self.location.origin).href, { cacheName: 'pc-offline-policy-v1' })
    return !policy || await policy.text() !== 'off'
  } catch {
    return false // Do not retain artwork when its storage preference cannot be read.
  }
}

async function storeImage(cache, request, res) {
  if (!isCacheableImage(res)) return
  const copy = res.clone() // Reserve our stream before the browser consumes its response.
  if (!await imageCachingEnabled()) return
  await cache.put(request, copy)
  await trimCache(cache, IMAGE_CAP)
}

// Offline (or on a hung connection) the detail view's large image falls back to the small copy
// the collection grid already cached. A late network answer is still stored for the next view.
async function fetchLargeImage(event, cache, smallPath) {
  const network = fetch(event.request)
  const store = res => storeImage(cache, event.request, res).catch(() => {})
  const smallCopy = () => cache.match(new URL(smallPath, self.location.origin).href, { ignoreSearch: true })
  const timer = new Promise(resolve => setTimeout(() => resolve(null), LARGE_IMAGE_TIMEOUT_MS))
  let res
  try {
    res = await Promise.race([network, timer])
  } catch (err) {
    const small = await smallCopy()
    if (small) return small
    throw err
  }
  if (res) {
    event.waitUntil(store(res))
    return res
  }
  const small = await smallCopy()
  if (!small) {
    const late = await network
    event.waitUntil(store(late))
    return late
  }
  event.waitUntil(network.then(store, () => {}))
  return small
}

function handleImage(event) {
  event.respondWith((async () => {
    if (!await imageCachingEnabled()) return fetch(event.request, { cache: 'no-store' })
    const originalUrl = new URL(event.request.url)
    if (/^\/api\/images\/card\/.+\/(small|large)$/.test(originalUrl.pathname)
      && await caches.has('pc-collection-originals-v1')) {
      originalUrl.pathname = originalUrl.pathname.replace(/\/(small|large)$/, '/large')
      const originals = await caches.open('pc-collection-originals-v1')
      if (!await imageCachingEnabled()) {
        await caches.delete('pc-collection-originals-v1')
        return fetch(event.request, { cache: 'no-store' })
      }
      const original = await originals.match(originalUrl.href, { ignoreSearch: true })
      if (original) return original
    }
    const cache = await caches.open(IMAGES_NAME)
    if (!await imageCachingEnabled()) {
      await caches.delete(IMAGES_NAME)
      return fetch(event.request, { cache: 'no-store' })
    }
    const hit = await cache.match(event.request)
    if (hit) return hit
    const smallPath = smallImagePath(new URL(event.request.url).pathname)
    if (smallPath) return fetchLargeImage(event, cache, smallPath)
    const res = await fetch(event.request)
    event.waitUntil(storeImage(cache, event.request, res).catch(() => {}))
    return res
  })())
}

self.addEventListener('install', event => {
  event.waitUntil(precacheAll())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      const stale = (name.startsWith('pc-precache-') && name !== PRECACHE_NAME)
        || (name.startsWith('pc-shell-') && name !== SHELL_NAME)
      if (stale) await caches.delete(name)
    }
  })())
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const kind = classify(event.request, url)
  if (kind === 'precache') {
    event.respondWith(caches.match(url.pathname, { cacheName: PRECACHE_NAME })
      .then(hit => hit || fetch(event.request)))
  } else if (kind === 'navigate') {
    handleNavigate(event)
  } else if (kind === 'image') {
    handleImage(event)
  }
})

self.addEventListener('message', event => {
  const data = event.data || {}
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  } else if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', buildId: BUILD_ID, appVersion: self.__PC_APP_VERSION__ || null })
  }
})

// Web push (docs/PWA_OFFLINE_DESIGN.md §6.7). Always shows a notification: Apple revokes the
// subscription of sites that receive pushes without showing one. The payload is Declarative
// Web Push JSON ({web_push, notification:{title, body, navigate}}); only a string title and
// body are used, anything else falls back to a generic notification.
const DEFAULT_NOTIFICATION_TITLE = 'PokéCollector'

function pushPayload(event) {
  try {
    const data = event.data ? event.data.json() : null
    const note = data && typeof data === 'object' ? (data.notification || data) : null
    if (note && typeof note.title === 'string' && note.title) {
      return {
        title: note.title.slice(0, 120),
        body: typeof note.body === 'string' ? note.body.slice(0, 300) : '',
        navigate: typeof note.navigate === 'string' ? note.navigate : '',
      }
    }
  } catch {
    // Not JSON: fall through to the generic notification.
  }
  return { title: DEFAULT_NOTIFICATION_TITLE, body: '', navigate: '' }
}

// Same-origin target only; anything else opens the app root.
function safeNavigateUrl(navigate) {
  try {
    const url = new URL(navigate || '/', self.location.origin)
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href
  } catch {
    return new URL('/', self.location.origin).href
  }
}

async function focusOrOpen(target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find(client => new URL(client.url).origin === self.location.origin)
  if (open) {
    try {
      await open.focus()
      if (typeof open.navigate === 'function') await open.navigate(target)
      return
    } catch {
      // Fall through and open a new window.
    }
  }
  await self.clients.openWindow(target)
}

self.addEventListener('push', event => {
  const { title, body, navigate } = pushPayload(event)
  const options = { body, data: { navigate: navigate || '/' } }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(focusOrOpen(safeNavigateUrl(event.notification.data && event.notification.data.navigate)))
})

if (self.__PC_SW_TEST_MODE__) {
  self.__PC_SW_TEST__ = { classify, validatePrecache, validateShell, isCacheableImage, trimCache, smallImagePath }
}
