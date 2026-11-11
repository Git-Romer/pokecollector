import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import {
  normalizeHoloEffectsOrigin,
  getPublishedHoloDesigns,
  getHoloEffectForCard,
  resetHoloEffectsCache,
} from './holoEffects'

const baseHash = 'b'.repeat(64)
const JSON_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
const version = 'r2-11111111-1111-4111-8111-111111111111'
const cardId = 'sv1-1'
const cardKey = 'sv1-1_en'
const maskBytes = new Uint8Array([1, 2, 3])
const foilBytes = new Uint8Array([4, 5, 6])
const toHex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
const digest = async bytes => toHex(await webcrypto.subtle.digest('SHA-256', bytes))

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status || 200,
    headers: { 'content-type': 'application/json', ...options.headers },
  })
}

async function fixture(overrides = {}, finish = 'holo') {
  const maskHash = await digest(maskBytes)
  const foilHash = await digest(foilBytes)
  const design = {
    cardId,
    language: 'en',
    finish,
    foilProfile: 'swholo',
    version,
    revision: 2,
    baseImageSha256: baseHash,
  }
  const manifest = {
    schemaVersion: 1,
    version,
    cardId,
    language: 'en',
    finish,
    foilProfile: 'swholo',
    revision: 2,
    baseImageSha256: baseHash,
    assets: {
      mask: {
        path: `/api/holo/versions/${version}/assets/mask`,
        sha256: maskHash,
        mime: 'image/png',
        bytes: maskBytes.length,
      },
      foilMap: {
        path: `/api/holo/versions/${version}/assets/foilMap`,
        sha256: foilHash,
        mime: 'image/png',
        bytes: foilBytes.length,
      },
    },
  }
  const current = {
    cardId,
    language: 'en',
    finish,
    foilProfile: 'swholo',
    version,
    revision: 2,
    publishedAt: '2026-11-01T00:00:00.000Z',
    manifestUrl: `/api/holo/versions/${version}/manifest`,
  }
  const responses = {
    fingerprint: jsonResponse({ tcgCardId: cardId, language: 'en', sha256: baseHash }),
    list: jsonResponse({ schemaVersion: 1, entries: [design] }),
    current: jsonResponse(current),
    manifest: jsonResponse(manifest),
    mask: new Response(maskBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    foilMap: new Response(foilBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    ...overrides,
  }
  const fetchImpl = vi.fn(async (url, options) => {
    const value = String(url)
    if (value === `/api/images/card/${cardKey}/fingerprint`) return responses.fingerprint
    if (value === 'https://effects.example/api/holo/list') return responses.list
    if (value.startsWith('https://effects.example/api/holo/current?')) return responses.current
    if (value === `https://effects.example${current.manifestUrl}`) return responses.manifest
    if (value === `https://effects.example${manifest.assets.mask.path}`) return responses.mask
    if (value === `https://effects.example${manifest.assets.foilMap.path}`) return responses.foilMap
    throw new Error(`Unexpected request: ${value} (${options?.cache || 'no cache mode'})`)
  })
  return { design, current, manifest, fetchImpl }
}

const card = {
  id: cardKey,
  card_id: cardKey,
  tcg_card_id: cardId,
  lang: 'en',
  images_large: 'https://assets.tcgdex.net/en/sv/sv1/1/high.webp',
}
const imageUrl = `/api/images/card/${cardKey}/large`

beforeEach(() => resetHoloEffectsCache())

describe('dashboard-compatible Holo effects client', () => {
  it('loads only current published designs from the dashboard list route', async () => {
    const { fetchImpl, design } = await fixture()
    const first = await getPublishedHoloDesigns({ fetchImpl, baseUrl: 'https://effects.example' })
    const second = await getPublishedHoloDesigns({ fetchImpl, baseUrl: 'https://effects.example' })

    expect(first).toEqual([design])
    expect(second).toEqual([design])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://effects.example/api/holo/list')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: 'no-cache' })
  })

  it('rejects oversized JSON declared by Content-Length and cancels before parsing', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([123, 125])) },
      cancel() { cancelled = true },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(JSON_RESPONSE_MAX_BYTES + 1),
      },
    })
    const parseJson = vi.spyOn(response, 'json').mockImplementation(() => {
      throw new Error('unbounded response.json must not be used')
    })
    const { fetchImpl } = await fixture({ list: response })

    await expect(getPublishedHoloDesigns({ fetchImpl, baseUrl: 'https://effects.example' })).resolves.toEqual([])

    expect(parseJson).not.toHaveBeenCalled()
    expect(cancelled).toBe(true)
  })

  it('rejects and cancels JSON streams that exceed the byte limit without Content-Length', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(JSON_RESPONSE_MAX_BYTES + 1)) },
      cancel() { cancelled = true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const parseJson = vi.spyOn(response, 'json').mockImplementation(() => {
      throw new Error('unbounded response.json must not be used')
    })
    const { fetchImpl } = await fixture({ list: response })

    await expect(getPublishedHoloDesigns({ fetchImpl, baseUrl: 'https://effects.example' })).resolves.toEqual([])

    expect(parseJson).not.toHaveBeenCalled()
    expect(cancelled).toBe(true)
  })

  it('accepts the maximum published index supported by the dashboard', async () => {
    const revision = Number.MAX_SAFE_INTEGER
    const version = `r${revision}-11111111-1111-4111-8111-111111111111`
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      cardId: `A${String(index).padStart(99, '0')}`,
      language: 'de',
      finish: 'holo',
      foilProfile: 'a'.repeat(32),
      version,
      revision,
      baseImageSha256: 'f'.repeat(64),
    }))
    const body = JSON.stringify({ schemaVersion: 1, entries })
    const bytes = new TextEncoder().encode(body).byteLength
    expect(bytes).toBeLessThanOrEqual(JSON_RESPONSE_MAX_BYTES)
    const response = new Response(body, {
      headers: {
        'content-type': 'application/json',
        'content-length': String(bytes),
      },
    })
    const { fetchImpl } = await fixture({ list: response })

    await expect(getPublishedHoloDesigns({ fetchImpl, baseUrl: 'https://effects.example' })).resolves.toHaveLength(10_000)
  })

  it('joins list, exact current design, immutable manifest, and allowlisted assets', async () => {
    const { fetchImpl, design } = await fixture()
    const createObjectURL = vi.fn(blob => `blob:fixture-${blob.type}-${blob.size}`)
    const effect = await getHoloEffectForCard(card, {
      enabled: true,
      variant: 'Holo',
      imageUrl,
      fetchImpl,
      createObjectURL,
      baseUrl: 'https://effects.example',
    })

    expect(effect).toMatchObject({
      version,
      baseImageSha256: baseHash,
      maskUrl: `blob:fixture-image/png-${maskBytes.length}`,
      foilMapUrl: `blob:fixture-image/png-${foilBytes.length}`,
      foilProfile: 'swholo',
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `/api/images/card/${cardKey}/fingerprint`,
      'https://effects.example/api/holo/list',
      `https://effects.example/api/holo/current?cardId=${cardId}&language=en&finish=holo&foilProfile=swholo`,
      `https://effects.example/api/holo/versions/${version}/manifest`,
      `https://effects.example/api/holo/versions/${version}/assets/mask`,
      `https://effects.example/api/holo/versions/${version}/assets/foilMap`,
    ])
    expect(fetchImpl.mock.calls[2][1]).toMatchObject({ cache: 'no-cache' })
    expect(fetchImpl.mock.calls[3][1]).toMatchObject({ cache: 'force-cache' })
    expect(fetchImpl.mock.calls.slice(4).every(([, options]) => options.cache === 'force-cache')).toBe(true)
    expect(design.baseImageSha256).toBe(baseHash)
  })

  it('does not offer unpublished or malformed list entries', async () => {
    const malformed = jsonResponse({ schemaVersion: 1, entries: [{
      ...((await fixture()).design),
      status: 'pending',
    }] })
    const { fetchImpl } = await fixture({ list: malformed })
    await expect(getPublishedHoloDesigns({ fetchImpl, baseUrl: 'https://effects.example' })).resolves.toEqual([])
  })

  it('fails closed before requesting assets when the official image fingerprint differs', async () => {
    const { fetchImpl } = await fixture({
      fingerprint: jsonResponse({ tcgCardId: cardId, language: 'en', sha256: 'c'.repeat(64) }),
    })
    await expect(getHoloEffectForCard(card, {
      enabled: true, variant: 'Holo', imageUrl, fetchImpl, baseUrl: 'https://effects.example',
    })).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/api/holo/current'))).toBe(false)
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/assets/'))).toBe(false)
  })

  it('fails closed when the current route does not match the listed exact card-language-fingerprint tuple', async () => {
    const { fetchImpl, current } = await fixture()
    const { fetchImpl: mismatchFetch } = await fixture({
      current: jsonResponse({ ...current, language: 'de' }),
    })
    await expect(getHoloEffectForCard(card, {
      enabled: true, variant: 'Holo', imageUrl, fetchImpl: mismatchFetch, baseUrl: 'https://effects.example',
    })).resolves.toBeNull()
    expect(mismatchFetch.mock.calls.some(([url]) => String(url).includes('/assets/'))).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed when the current route is unavailable', async () => {
    const { fetchImpl } = await fixture({ current: jsonResponse({ error: 'offline' }, { status: 503 }) })
    await expect(getHoloEffectForCard(card, {
      enabled: true, variant: 'Holo', imageUrl, fetchImpl, baseUrl: 'https://effects.example',
    })).resolves.toBeNull()
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/manifest'))).toBe(false)
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/assets/'))).toBe(false)
  })

  it('rejects asset responses whose declared size exceeds the manifest before buffering them', async () => {
    const oversized = new Response(maskBytes, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(25 * 1024 * 1024 + 1),
      },
    })
    const { fetchImpl } = await fixture({ mask: oversized })
    const readBlob = vi.spyOn(oversized, 'blob')
    const createObjectURL = vi.fn(() => 'blob:must-not-be-created')

    await expect(getHoloEffectForCard(card, {
      enabled: true,
      variant: 'Holo',
      imageUrl,
      fetchImpl,
      createObjectURL,
      baseUrl: 'https://effects.example',
    })).resolves.toBeNull()

    expect(readBlob).not.toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('cancels asset streams as soon as bytes exceed the manifest size', async () => {
    let cancelled = false
    const oversizedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]))
      },
      cancel() { cancelled = true },
    })
    const response = new Response(oversizedStream, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
    const readBlob = vi.spyOn(response, 'blob')
    const { fetchImpl } = await fixture({ mask: response })

    await getHoloEffectForCard(card, {
      enabled: true,
      variant: 'Holo',
      imageUrl,
      fetchImpl,
      baseUrl: 'https://effects.example',
    })

    expect(readBlob).not.toHaveBeenCalled()
    expect(cancelled).toBe(true)
  })

  it.each([
    ['unsafe asset path', async ({ manifest }) => ({
      manifest: jsonResponse({ ...manifest, assets: { ...manifest.assets, mask: { ...manifest.assets.mask, path: 'https://evil.example/mask.png' } } }),
    })],
    ['wrong asset MIME', async ({ manifest }) => ({
      manifest: jsonResponse({ ...manifest, assets: { ...manifest.assets, mask: { ...manifest.assets.mask, mime: 'image/svg+xml' } } }),
    })],
    ['mismatched base-image fingerprint', async ({ manifest }) => ({
      manifest: jsonResponse({ ...manifest, baseImageSha256: 'c'.repeat(64) }),
    })],
    ['tampered asset bytes', async () => ({ mask: new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { 'content-type': 'image/png' } }) })],
  ])('fails closed on %s', async (_name, makeOverride) => {
    const initial = await fixture()
    const overrides = await makeOverride(initial)
    const { fetchImpl } = await fixture(overrides)
    await expect(getHoloEffectForCard(card, {
      enabled: true, variant: 'Holo', imageUrl, fetchImpl, baseUrl: 'https://effects.example',
      createObjectURL: vi.fn(() => 'blob:must-not-be-created'),
    })).resolves.toBeNull()
  })

  it.each([
    [{ ...card, is_custom: true }, imageUrl, true, 'Holo'],
    [card, `/api/images/card/${cardKey}/small`, true, 'Holo'],
    [card, imageUrl, false, 'Holo'],
    [card, imageUrl, true, 'Normal'],
  ])('does not request effect data for ineligible surfaces', async (ineligibleCard, source, enabled, variant) => {
    const { fetchImpl } = await fixture()
    const callsBefore = fetchImpl.mock.calls.length
    await expect(getHoloEffectForCard(ineligibleCard, {
      enabled, variant, imageUrl: source, fetchImpl, baseUrl: 'https://effects.example',
    })).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(callsBefore)
  })
})


describe('physical finish matching', () => {
  it.each([['Holo', 'holo'], ['Reverse Holo', 'reverse']])('loads only the exact %s effect', async (variant, finish) => {
    const { fetchImpl } = await fixture({}, finish)
    const result = await getHoloEffectForCard(card, { enabled: true, variant, imageUrl, fetchImpl,
      baseUrl: 'https://effects.example', createObjectURL: () => 'blob:verified' })
    expect(result?.foilProfile).toBe('swholo')
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes(`finish=${finish}&`))).toBe(true)
  })
  it.each([['Holo', 'reverse'], ['Reverse Holo', 'holo']])('never borrows another finish for %s', async (variant, finish) => {
    const { fetchImpl } = await fixture({}, finish)
    expect(await getHoloEffectForCard(card, { enabled: true, variant, imageUrl, fetchImpl,
      baseUrl: 'https://effects.example', createObjectURL: () => 'blob:no' })).toBeNull()
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/assets/'))).toBe(false)
  })
  it('does not recognize the removed Special variant', async () => {
    const { fetchImpl } = await fixture()
    expect(await getHoloEffectForCard(card, { enabled: true, variant: 'Special', imageUrl, fetchImpl,
      baseUrl: 'https://effects.example', createObjectURL: () => 'blob:no' })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})


describe('released publisher origin', () => {
  it.each([
    [undefined, 'https://pokecollector.romerg.de/api/holo/list'],
    ['', '/api/holo/list'],
  ])('requests the configured list endpoint (%s)', async (value, expectedUrl) => {
    vi.stubEnv('VITE_HOLO_EFFECTS_API_BASE_URL', value)
    const fetchImpl = vi.fn(async () => jsonResponse({ schemaVersion: 1, entries: [] }))
    try {
      expect(await getPublishedHoloDesigns({ fetchImpl })).toEqual([])
      expect(fetchImpl).toHaveBeenCalledWith(expectedUrl, { cache: 'no-cache' })
    } finally { vi.unstubAllEnvs() }
  })

  it('uses the official publisher without a build override', () => {
    vi.stubEnv('VITE_HOLO_EFFECTS_API_BASE_URL', undefined)
    try { expect(normalizeHoloEffectsOrigin()).toBe('https://pokecollector.romerg.de') }
    finally { vi.unstubAllEnvs() }
  })

  it('preserves an explicit empty same-origin preview override', () => {
    vi.stubEnv('VITE_HOLO_EFFECTS_API_BASE_URL', '')
    try { expect(normalizeHoloEffectsOrigin()).toBe('') }
    finally { vi.unstubAllEnvs() }
  })
})
