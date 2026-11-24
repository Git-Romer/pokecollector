// In-memory retry tokens for failed artwork only. No ownership or private URLs
// are persisted; reopening a card after a central retry bypasses a failed fetch.
export const ARTWORK_RETRY_EVENT = 'pc-artwork-retry'
const missing = new Map()
export const artworkRetryAttempt = src => missing.get(src) || 0
export function markArtworkMissing(src) {
  if (src && !missing.has(src)) missing.set(src, 0)
}
export function markArtworkLoaded(src) { missing.delete(src) }
export function retryMissingArtwork(target = globalThis.window) {
  for (const [src, attempt] of missing) missing.set(src, attempt + 1)
  target?.dispatchEvent(new Event(ARTWORK_RETRY_EVENT))
}
