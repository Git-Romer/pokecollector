// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { COLLECTION_IMAGE_CACHE, downloadCollection } from './collectionDownload'

const origin = 'https://pc.test'
const image = () => {
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp' } })
  Object.defineProperty(response, 'type', { value: 'basic' })
  return response
}
function fixture(count = 2) {
  const stored = new Map()
  const cache = { match: vi.fn(async key => stored.get(key)?.clone()), put: vi.fn(async (key, response) => stored.set(key, response.clone())), keys: async () => [...stored.keys()].map(url => ({ url })), delete: async key => stored.delete(key?.url || key) }
  const cachesImpl = { open: vi.fn(async () => cache) }
  const manifest = { version: 1, user_id: 7, items: [{ id: 1 }], missing_artwork_card_ids: [], image_urls: Array.from({ length: count }, (_, i) => `/api/images/card/card-${i}_en/large`) }
  const fetchImpl = vi.fn(async () => image())
  const saveMetadata = vi.fn(async () => true)
  return { manifest, stored, cache, options: { manifest, userId: 7, origin, cachesImpl, fetchImpl, saveMetadata, isCurrentUser: () => true } }
}

describe('complete collection downloads', () => {
  it('fetches changed artwork without the service worker and replaces its old revision', async () => {
    const { options, stored } = fixture(1)
    stored.set(origin + '/api/images/card/card-0_en/large?v=0000000000000000', image())
    options.manifest.image_urls = ['/api/images/card/card-0_en/large?v=1111111111111111']
    await downloadCollection(options)
    expect(new URL(options.fetchImpl.mock.calls[0][0]).searchParams.get('pc_sw')).toBe('download')
    expect(stored.size).toBe(1)
    expect(stored.has(origin + options.manifest.image_urls[0])).toBe(true)
  })
  it.each([
    ['wrong owner', { user_id: 8 }],
    ['unsupported version', { version: 2 }],
    ['external URL', { image_urls: ['https://outside.test/card.webp'] }],
    ['private photo', { image_urls: ['/api/collection/1/photo'] }],
    ['API metadata', { image_urls: ['/api/collection/'] }],
    ['redirect-shaped path', { image_urls: ['//outside.test/api/images/card/1/large'] }],
  ])('rejects %s before any download or metadata write', async (_label, change) => {
    const { options } = fixture()
    await expect(downloadCollection({ ...options, manifest: { ...options.manifest, ...change } })).rejects.toThrow()
    expect(options.fetchImpl).not.toHaveBeenCalled()
    expect(options.saveMetadata).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTP failure', () => new Response('gone', { status: 404 })],
    ['HTML login page', () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['private image', () => { const r = image(); r.headers.set('Cache-Control', 'private'); return r }],
  ])('does not mark %s as saved artwork', async (_label, response) => {
    const { options, stored } = fixture(1)
    const onProgress = vi.fn()
    options.fetchImpl = vi.fn(async () => response())
    await expect(downloadCollection({ ...options, onProgress })).rejects.toThrow('image_unavailable')
    expect(stored.size).toBe(0)
    expect(onProgress.mock.calls.some(([s]) => s.complete)).toBe(false)
  })

  it('does not claim success when collection metadata cannot be saved', async () => {
    const { options } = fixture()
    options.saveMetadata.mockResolvedValue(false)
    await expect(downloadCollection(options)).rejects.toThrow('metadata_not_saved')
    expect(options.fetchImpl).not.toHaveBeenCalled()
  })

  it('stops before writing anything after an account switch', async () => {
    const { options, stored } = fixture()
    let current = true
    options.fetchImpl = vi.fn(async () => { current = false; return image() })
    await expect(downloadCollection({ ...options, isCurrentUser: () => current })).rejects.toThrow('account_changed')
    expect(stored.size).toBe(0)
  })

  it('honors cancellation before doing any work', async () => {
    const { options } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(downloadCollection({ ...options, signal: controller.signal })).rejects.toThrow()
    expect(options.saveMetadata).not.toHaveBeenCalled()
  })

  it('resumes a failed download without fetching completed artwork again', async () => {
    const { options, stored } = fixture(3)
    options.fetchImpl.mockImplementationOnce(async () => image()).mockRejectedValueOnce(new Error('offline'))
    await expect(downloadCollection(options)).rejects.toThrow('offline')
    expect(stored.size).toBe(1)
    options.fetchImpl.mockClear().mockImplementation(async () => image())
    expect(await downloadCollection(options)).toMatchObject({ completed: 3, complete: true })
    expect(options.fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('bounds a hanging image request and never reports completion', async () => {
    const { options } = fixture(1)
    options.fetchImpl = vi.fn(() => new Promise(() => {}))
    const attempt = downloadCollection({ ...options, timeoutMs: 20 })
    const bounded = Promise.race([attempt, new Promise(resolve => setTimeout(() => resolve('not bounded'), 150))])
    await expect(bounded).rejects.toThrow('download_timeout')
  })

  it('preserves space for unsent scans instead of exhausting the quota', async () => {
    const { options, stored } = fixture(1)
    await expect(downloadCollection({ ...options, storage: { estimate: async () => ({ quota: 100000, usage: 99999 }) } })).rejects.toThrow('storage_low')
    expect(stored.size).toBe(0)
  })

  it('does not report success if the image cache rejects a quota write', async () => {
    const { options, cache } = fixture(1)
    cache.put.mockRejectedValue(new DOMException('Full', 'QuotaExceededError'))
    await expect(downloadCollection(options)).rejects.toThrow('Full')
  })

  it('retains 2000 original images without the browsing cache 800-image eviction', async () => {
    const { options, stored } = fixture(2000)
    const progress = []
    const result = await downloadCollection({ ...options, onProgress: state => progress.push(state) })
    expect(options.cachesImpl.open).toHaveBeenCalledWith(COLLECTION_IMAGE_CACHE)
    expect(stored.size).toBe(2000)
    expect(result).toMatchObject({ completed: 2000, total: 2000, complete: true })
    expect(progress.at(-1)).toMatchObject({ complete: true })
    expect(options.saveMetadata).toHaveBeenCalledWith(options.manifest.items)
  })
})
