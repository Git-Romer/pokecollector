// Scan submit with persist-then-send (docs/PWA_OFFLINE_DESIGN.md §6.5.2).
// Scan never waits on the network: photos are saved to the outbox first, and the upload is
// only attempted inline when the server is known to be reachable, for at most SEND_CAP_MS.
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_ITEM, TARGET_ITEM_BYTES } from '../constants.js'
import { isSupportedScannerImage } from '../../utils/scannerImages.js'

export const MAX_SCAN_FILES = 50
export const SEND_CAP_MS = 5000

export class ScanSubmitError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'ScanSubmitError'
    this.code = code
  }
}

/**
 * Greedy, order-preserving chunks of at most `maxPhotos` files and `targetBytes` bytes.
 * A file larger than `targetBytes` forms its own chunk. → `[{start, files}]`.
 */
export function chunkPhotos(files, { maxPhotos = MAX_PHOTOS_PER_ITEM, targetBytes = TARGET_ITEM_BYTES } = {}) {
  const chunks = []
  let current = null
  let bytes = 0
  files.forEach((file, index) => {
    const size = file.size || 0
    if (current && (current.files.length >= maxPhotos || bytes + size > targetBytes)) current = null
    if (!current) {
      current = { start: index, files: [] }
      chunks.push(current)
      bytes = 0
    }
    current.files.push(file)
    bytes += size
  })
  return chunks
}

function withCap(promise, capMs) {
  let timer
  const cap = new Promise(resolve => {
    timer = setTimeout(() => resolve({ capped: true }), capMs)
  })
  return Promise.race([promise.then(results => ({ results })), cap]).finally(() => clearTimeout(timer))
}

/**
 * Saves every chunk to the outbox, then sends them only when `reachability` is exactly
 * `reachable`, waiting at most `sendCapMs`. → `{mode: 'sent'|'queued'|'partial', jobIds, queuedCount}`.
 * Throws `ScanSubmitError` (`too_large`, `unsupported`, `too_many`) before saving anything, and the
 * outbox's own error (`quota`, `server_old`, ...) when saving fails. Chunks saved before a failure
 * stay queued; the thrown error then carries `queuedCount`.
 */
export async function submitScanBatch({
  files,
  individualPositions = [],
  outbox,
  reachability = 'unknown',
  sendCapMs = SEND_CAP_MS,
}) {
  if (!files.length) throw new ScanSubmitError('empty')
  if (files.length > MAX_SCAN_FILES) throw new ScanSubmitError('too_many')
  if (files.some(file => !isSupportedScannerImage(file))) throw new ScanSubmitError('unsupported')
  if (files.some(file => file.size > MAX_PHOTO_BYTES)) throw new ScanSubmitError('too_large')

  const itemIds = []
  for (const chunk of chunkPhotos(files)) {
    const end = chunk.start + chunk.files.length
    const positions = individualPositions
      .filter(position => position >= chunk.start && position < end)
      .map(position => position - chunk.start)
    try {
      const photos = []
      for (const file of chunk.files) {
        photos.push({ name: file.name, type: file.type, size: file.size, bytes: await file.arrayBuffer() })
      }
      const item = await outbox.enqueue({ type: 'scan.upload', payload: { individualPositions: positions }, photos })
      itemIds.push(item.id)
    } catch (error) {
      error.savedPhotoCount = chunk.start
      if (itemIds.length) error.queuedCount = itemIds.length
      throw error
    }
  }

  if (reachability !== 'reachable') return { mode: 'queued', jobIds: [], queuedCount: itemIds.length }

  // The send keeps running after the cap; it is the same item and idempotency key the replay
  // engine would pick up, so a late finish is harmless.
  const sending = outbox.sendNow(itemIds)
  sending.catch(() => {})
  const outcome = await withCap(sending, sendCapMs).catch(() => ({ capped: true }))
  if (outcome.capped) return { mode: 'queued', jobIds: [], queuedCount: itemIds.length }

  const sent = outcome.results.filter(result => result.outcome === 'sent')
  const jobIds = sent.map(result => result.json?.id).filter(id => Number.isFinite(id))
  if (sent.length === itemIds.length) return { mode: 'sent', jobIds, queuedCount: 0 }
  if (!sent.length) return { mode: 'queued', jobIds: [], queuedCount: itemIds.length }
  return { mode: 'partial', jobIds, queuedCount: itemIds.length - sent.length }
}
