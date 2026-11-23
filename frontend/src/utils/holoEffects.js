const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ALLOWED_FINISHES = new Set(['holo', 'reverse'])
const DESIGN_KEYS = ['baseImageSha256', 'cardId', 'finish', 'foilProfile', 'language', 'revision', 'version']
const IMMUTABLE_CACHE = 'force-cache'
const ASSET_MAX_BYTES = 25 * 1024 * 1024
const JSON_MAX_BYTES = 4 * 1024 * 1024
const LIST_TTL_MS = 30_000

const manifests = new Map()
const assets = new Map()
const designLists = new Map()
const pendingLists = new Map()

function configuredBaseUrl() {
  // Released images use the public publisher; an explicit empty build value
  // keeps trusted same-origin development proxies available.
  return import.meta.env?.VITE_HOLO_EFFECTS_API_BASE_URL ?? 'https://pokecollector.romerg.de'
}

export function normalizeHoloEffectsOrigin(baseUrl = configuredBaseUrl()) {
  if (baseUrl === '') return ''
  if (typeof baseUrl !== 'string') return null
  try {
    const parsed = new URL(baseUrl)
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || !['', '/'].includes(parsed.pathname)
      || parsed.search
      || parsed.hash
    ) return null
    return parsed.origin
  } catch {
    return null
  }
}

function apiUrl(origin, path) {
  return `${origin}${path}`
}

function validVersion(version, revision) {
  return Number.isSafeInteger(revision)
    && revision > 0
    && typeof version === 'string'
    && new RegExp(`^r${revision}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'i').test(version)
}

function validDesign(design) {
  return Boolean(
    design
    && typeof design === 'object'
    && !Array.isArray(design)
    && Object.keys(design).sort().join('|') === DESIGN_KEYS.join('|')
    && typeof design.cardId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(design.cardId)
    && ['en', 'de'].includes(design.language)
    && ALLOWED_FINISHES.has(design.finish)
    && typeof design.foilProfile === 'string'
    && /^[a-z][a-z0-9-]{0,31}$/.test(design.foilProfile)
    && validVersion(design.version, design.revision)
    && SHA256_PATTERN.test(design.baseImageSha256 || '')
  )
}

function validDesignList(list) {
  if (!list || typeof list !== 'object' || Array.isArray(list)
      || Object.keys(list).sort().join('|') !== 'entries|schemaVersion'
      || list.schemaVersion !== 1 || !Array.isArray(list.entries)) return false
  const keys = new Set()
  for (const design of list.entries) {
    if (!validDesign(design)) return false
    const key = `${design.cardId}\0${design.language}\0${design.finish}\0${design.foilProfile}`
    if (keys.has(key)) return false
    keys.add(key)
  }
  return true
}

async function readJsonResponse(response) {
  if (!response?.ok) {
    await cancelResponseBody(response)
    return null
  }
  const contentType = response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    await cancelResponseBody(response)
    return null
  }

  const contentLength = response.headers?.get('content-length')
  if (contentLength !== null && contentLength !== undefined) {
    const normalized = contentLength.trim()
    const declaredBytes = /^(?:0|[1-9][0-9]*)$/.test(normalized) ? Number(normalized) : NaN
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > JSON_MAX_BYTES) {
      await cancelResponseBody(response)
      return null
    }
  }

  let reader
  try { reader = response.body?.getReader?.() } catch { return null }
  if (!reader) {
    await cancelResponseBody(response)
    return null
  }

  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {})
        return null
      }
      totalBytes += value.byteLength
      if (totalBytes > JSON_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }

    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

async function getPublishedDesigns({ fetchImpl, origin }) {
  const cached = designLists.get(origin)
  if (cached && cached.expiresAt > Date.now()) return cached.entries

  let pending = pendingLists.get(origin)
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetchImpl(apiUrl(origin, '/api/holo/list'), { cache: 'no-cache' })
        const list = await readJsonResponse(response)
        if (!validDesignList(list)) return null
        designLists.set(origin, { entries: list.entries, expiresAt: Date.now() + LIST_TTL_MS })
        return list.entries
      } catch {
        return null
      }
    })().finally(() => pendingLists.delete(origin))
    pendingLists.set(origin, pending)
  }
  return pending
}

export async function getPublishedHoloDesigns({
  fetchImpl = globalThis.fetch,
  baseUrl = configuredBaseUrl(),
} = {}) {
  const origin = normalizeHoloEffectsOrigin(baseUrl)
  if (origin === null || typeof fetchImpl !== 'function') return []
  const entries = await getPublishedDesigns({ fetchImpl, origin })
  return entries || []
}

function exactLargeImageProxy(card, imageUrl) {
  if (!card || card.is_custom || !card.tcg_card_id || !card.lang) return null
  if (!(card.images_large || card.images?.large)) return null
  const cardId = card.card_id || (typeof card.id === 'string' ? card.id : null)
  if (!cardId) return null
  const expected = `/api/images/card/${encodeURIComponent(cardId)}/large`
  return imageUrl === expected ? cardId : null
}

function safeFingerprint(fingerprint, card) {
  return fingerprint?.tcgCardId === card.tcg_card_id
    && fingerprint?.language === card.lang
    && SHA256_PATTERN.test(fingerprint?.sha256 || '')
}

function validAsset(asset, version, role) {
  return Boolean(
    asset
    && typeof asset === 'object'
    && !Array.isArray(asset)
    && Object.keys(asset).sort().join('|') === 'bytes|mime|path|sha256'
    && asset.mime === 'image/png'
    && Number.isSafeInteger(asset.bytes)
    && asset.bytes > 0
    && asset.bytes <= ASSET_MAX_BYTES
    && SHA256_PATTERN.test(asset.sha256 || '')
    && asset.path === `/api/holo/versions/${version}/assets/${role}`
  )
}

function validManifest(manifest, design) {
  const keys = ['assets', 'baseImageSha256', 'cardId', 'finish', 'foilProfile', 'language', 'revision', 'schemaVersion', 'version']
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).sort().join('|') !== keys.join('|')
      || manifest.schemaVersion !== 1
      || manifest.version !== design.version
      || manifest.revision !== design.revision
      || manifest.cardId !== design.cardId
      || manifest.language !== design.language
      || manifest.finish !== design.finish
      || manifest.foilProfile !== design.foilProfile
      || manifest.baseImageSha256 !== design.baseImageSha256
      || !manifest.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)
      || Object.keys(manifest.assets).sort().join('|') !== 'foilMap|mask') return false
  return validAsset(manifest.assets.mask, manifest.version, 'mask')
    && validAsset(manifest.assets.foilMap, manifest.version, 'foilMap')
}

function validCurrent(current, design) {
  return Boolean(
    current
    && typeof current === 'object'
    && !Array.isArray(current)
    && Object.keys(current).sort().join('|') === 'cardId|finish|foilProfile|language|manifestUrl|publishedAt|revision|version'
    && current.cardId === design.cardId
    && current.language === design.language
    && current.finish === design.finish
    && current.foilProfile === design.foilProfile
    && current.version === design.version
    && current.revision === design.revision
    && typeof current.publishedAt === 'string'
    && Number.isFinite(Date.parse(current.publishedAt))
    && current.manifestUrl === `/api/holo/versions/${design.version}/manifest`
  )
}

async function readPublishedManifest(design, { fetchImpl, origin }) {
  const search = new URLSearchParams({
    cardId: design.cardId,
    language: design.language,
    finish: design.finish,
    foilProfile: design.foilProfile,
  })
  const currentResponse = await fetchImpl(
    apiUrl(origin, `/api/holo/current?${search}`),
    { cache: 'no-cache' },
  )
  const current = await readJsonResponse(currentResponse)
  if (!validCurrent(current, design)) return null

  const key = `${origin}:${design.version}`
  if (manifests.has(key)) return manifests.get(key)

  const request = (async () => {
    try {
      const response = await fetchImpl(apiUrl(origin, current.manifestUrl), { cache: IMMUTABLE_CACHE })
      const manifest = await readJsonResponse(response)
      if (!validManifest(manifest, design)) return null
      return { version: design.version, manifest }
    } catch {
      return null
    }
  })()
  manifests.set(key, request)
  const published = await request
  if (!published) manifests.delete(key)
  return published
}

async function sha256Hex(buffer) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function cancelResponseBody(response) {
  try { await response.body?.cancel?.() } catch {}
}

async function readBoundedAssetBlob(response, asset) {
  const contentLength = response.headers?.get('content-length')
  if (contentLength !== null && contentLength !== undefined) {
    const normalized = contentLength.trim()
    const declaredBytes = /^(?:0|[1-9][0-9]*)$/.test(normalized) ? Number(normalized) : NaN
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== asset.bytes || declaredBytes > ASSET_MAX_BYTES) {
      await cancelResponseBody(response)
      return null
    }
  }

  const reader = response.body?.getReader?.()
  if (!reader) {
    await cancelResponseBody(response)
    return null
  }

  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {})
        return null
      }
      totalBytes += value.byteLength
      if (totalBytes > asset.bytes || totalBytes > ASSET_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }

  if (totalBytes !== asset.bytes) return null
  return new Blob(chunks, { type: asset.mime })
}

async function fetchAsset({ asset, origin, fetchImpl, createObjectURL }) {
  const url = apiUrl(origin, asset.path)
  const key = `${url}:${asset.sha256}`
  if (assets.has(key)) return assets.get(key)

  const pending = (async () => {
    try {
      const response = await fetchImpl(url, { cache: IMMUTABLE_CACHE })
      if (!response?.ok) return null
      const responseType = response.headers?.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (responseType !== asset.mime) return null
      const blob = await readBoundedAssetBlob(response, asset)
      if (!blob) return null
      if (blob.type && blob.type.toLowerCase() !== asset.mime) return null
      const digest = await sha256Hex(await blob.arrayBuffer())
      if (digest !== asset.sha256) return null
      return createObjectURL(blob)
    } catch {
      return null
    }
  })()
  assets.set(key, pending)
  const objectUrl = await pending
  if (!objectUrl) assets.delete(key)
  return objectUrl
}

export async function getHoloEffectForCard(card, {
  enabled = false,
  variant,
  imageUrl,
  fetchImpl = globalThis.fetch,
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  baseUrl = configuredBaseUrl(),
} = {}) {
  const origin = normalizeHoloEffectsOrigin(baseUrl)
  const finish = variant === 'Holo' ? 'holo' : variant === 'Reverse Holo' ? 'reverse' : null
  const cardId = exactLargeImageProxy(card, imageUrl)
  if (
    !enabled
    || !finish
    || !cardId
    || origin === null
    || typeof fetchImpl !== 'function'
    || typeof createObjectURL !== 'function'
    || !globalThis.crypto?.subtle
  ) return null

  try {
    const fingerprintResponse = await fetchImpl(
      `/api/images/card/${encodeURIComponent(cardId)}/fingerprint`,
      { cache: 'no-cache' },
    )
    const fingerprint = await readJsonResponse(fingerprintResponse)
    if (!safeFingerprint(fingerprint, card)) return null

    const designs = await getPublishedDesigns({ fetchImpl, origin })
    if (!designs) return null
    const design = designs.find(candidate => (
      candidate.cardId === card.tcg_card_id
      && candidate.language === card.lang
      && candidate.finish === finish
      && candidate.baseImageSha256 === fingerprint.sha256
    ))
    if (!design) return null

    const published = await readPublishedManifest(design, { fetchImpl, origin })
    if (!published) return null

    const [maskUrl, foilMapUrl] = await Promise.all([
      fetchAsset({ asset: published.manifest.assets.mask, origin, fetchImpl, createObjectURL }),
      fetchAsset({ asset: published.manifest.assets.foilMap, origin, fetchImpl, createObjectURL }),
    ])
    if (!maskUrl || !foilMapUrl) return null
    return {
      version: published.version,
      foilProfile: design.foilProfile,
      baseImageSha256: fingerprint.sha256,
      maskUrl,
      foilMapUrl,
    }
  } catch {
    return null
  }
}

export function resetHoloEffectsCache() {
  for (const pending of assets.values()) {
    Promise.resolve(pending).then(url => {
      if (typeof url === 'string' && url.startsWith('blob:')) globalThis.URL?.revokeObjectURL?.(url)
    })
  }
  manifests.clear()
  assets.clear()
  designLists.clear()
  pendingLists.clear()
}
