/* PokéCollector kill worker (docs/PWA_OFFLINE_DESIGN.md §6.3.4).
   Served at /sw.js when PWA_ENABLED is off: it removes any earlier worker and its caches.
   It has no fetch handler and never touches IndexedDB. */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      for (const name of await caches.keys()) {
        if (name.startsWith('pc-')) await caches.delete(name)
      }
    } catch (error) { /* ignore */ }
    try { await self.registration.unregister() } catch (error) { /* ignore */ }
    try {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        try { await client.navigate(client.url) } catch (error) { /* ignore */ }
      }
    } catch (error) { /* ignore */ }
  })())
})
