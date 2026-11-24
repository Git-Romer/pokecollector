// Explicit originals are separate from the bounded, opportunistic browsing cache.
// Only public artwork lives here. Ownership/collection metadata stays in IndexedDB.
export const COLLECTION_IMAGE_CACHE = 'pc-collection-originals-v1'
export const COLLECTION_POLICY_CACHE = 'pc-offline-policy-v1'
export const COLLECTION_POLICY_PATH = '/__pc_offline_collection_policy__'

export async function setCollectionCachePolicy(enabled, { cachesImpl = globalThis.caches, origin = globalThis.location?.origin } = {}) {
  const policy = await cachesImpl.open(COLLECTION_POLICY_CACHE)
  await policy.put(new URL(COLLECTION_POLICY_PATH, origin).href, new Response(enabled ? 'on' : 'off'))
}

// Keep the installed shell, push registration and unsent-photo database intact.
export async function clearCollectionArtwork({ cachesImpl = globalThis.caches } = {}) {
  for (const name of await cachesImpl.keys()) {
    if (name.startsWith('pc-collection-originals-') || name.startsWith('pc-images-')) await cachesImpl.delete(name)
  }
}

export async function downloadCollection({
  manifest, userId, origin = globalThis.location?.origin,
  cachesImpl = globalThis.caches, fetchImpl = globalThis.fetch?.bind(globalThis),
  saveMetadata, onProgress = () => {}, isCurrentUser = () => true, signal,
  timeoutMs = 20000, storage = globalThis.navigator?.storage,
}) {
  if (!manifest || manifest.version !== 1 || manifest.user_id !== userId
    || !Array.isArray(manifest.items) || !Array.isArray(manifest.image_urls)) {
    throw new Error('invalid_manifest')
  }
  const urls = [...new Set(manifest.image_urls)]
  if (urls.some(path => typeof path !== 'string'
    || !(path === '/cardback.jpg' || /^\/api\/images\/card\/[^/?#]+\/large(?:\?v=[a-f0-9]{16})?$/.test(path)))) {
    throw new Error('invalid_manifest')
  }
  const checkActive = () => {
    signal?.throwIfAborted()
    if (!isCurrentUser()) throw new Error('account_changed')
  }
  checkActive()
  const cache = await cachesImpl.open(COLLECTION_IMAGE_CACHE)
  const previousByPath = new Map()
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname
    const previous = previousByPath.get(path) || []
    previous.push(request)
    previousByPath.set(path, previous)
  }
  const checkSpace = async () => {
    const estimate = await storage?.estimate?.()
    if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)
      && estimate.quota - estimate.usage < 32 * 1024 * 1024) throw new Error('storage_low')
  }
  await checkSpace()
  checkActive()
  if (await saveMetadata(manifest.items) !== true) throw new Error('metadata_not_saved')
  checkActive()
  let completed = 0
  const state = complete => ({ completed, total: urls.length, complete, missingArtwork: manifest.missing_artwork_card_ids?.length || 0 })
  onProgress(state(false))
  for (const path of urls) {
    checkActive()
    const url = new URL(path, origin).href
    if (!(await cache.match(url))) {
      if (completed % 10 === 0) await checkSpace()
      const controller = new AbortController()
      let timer
      let onAbort
      const deadline = new Promise((_, reject) => {
        onAbort = () => { controller.abort(signal.reason); reject(signal.reason) }
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => { controller.abort(); reject(new Error('download_timeout')) }, timeoutMs)
      })
      try {
        await Promise.race([deadline, (async () => {
          const networkUrl = new URL(url)
          networkUrl.searchParams.set('pc_sw', 'download')
          const response = await fetchImpl(networkUrl.href, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, redirect: 'error' })
          if (response.status !== 200 || response.redirected || response.type !== 'basic'
            || !/^image\//i.test(response.headers.get('Content-Type') || '')
            || /private|no-store/i.test(response.headers.get('Cache-Control') || '')
            || /authorization/i.test(response.headers.get('Vary') || '')) throw new Error('image_unavailable')
          const reader = response.clone().body.getReader()
          let bytes = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > 8 * 1024 * 1024) throw new Error('image_too_large')
          }
          controller.signal.throwIfAborted()
          checkActive()
          await cache.put(url, response)
          for (const previous of previousByPath.get(new URL(url).pathname) || []) {
            if (previous.url !== url) await cache.delete(previous)
          }
        })()])
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        controller.abort()
      }
    }
    checkActive()
    completed += 1
    onProgress(state(false))
  }
  const result = state(true)
  onProgress(result)
  return result
}
