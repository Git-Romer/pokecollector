import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  RATE_LIMIT_MAX_PAUSE_MS,
  RATE_LIMIT_MIN_PAUSE_MS,
} from '../constants.js'

/** Full-jitter exponential backoff: `floor(rng() * min(cap, base * 2^(n-1)))`. */
export function nextDelayMs(retryCount, rng = Math.random) {
  const n = Math.max(1, Math.floor(Number(retryCount) || 1))
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1))
  return Math.floor(rng() * ceiling)
}

/**
 * `Retry-After` as delta-seconds or HTTP-date → milliseconds clamped to
 * [5 s, 900 s], or `null` when absent, negative or unparseable.
 */
export function parseRetryAfter(header, now = Date.now()) {
  if (header === null || header === undefined) return null
  const value = String(header).trim()
  if (!value) return null
  let ms
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000
  } else if (/^-?\d+(\.\d+)?$/.test(value)) {
    return null
  } else {
    const at = Date.parse(value)
    if (Number.isNaN(at)) return null
    ms = at - now
  }
  if (!Number.isFinite(ms)) return null
  return Math.min(RATE_LIMIT_MAX_PAUSE_MS, Math.max(RATE_LIMIT_MIN_PAUSE_MS, ms))
}
