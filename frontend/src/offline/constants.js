// Constants of the offline outbox (docs/PWA_OFFLINE_DESIGN.md §6.2.1).

const KIB = 1024
const MIB = 1024 * KIB

export const OUTBOX_DB_NAME = 'pokecollector-outbox'
export const OUTBOX_DB_VERSION = 1

export const PROBE_TIMEOUT_MS = 5000
export const PROBE_BACKOFF_MS = [15000, 30000, 60000, 120000]
export const REPLAY_TICK_MS = 15000
export const PACE_MS = 2000
export const JSON_TIMEOUT_MS = 20000
export const CLAIM_GRACE_MS = 15000

export const BACKOFF_BASE_MS = 5000
export const BACKOFF_CAP_MS = 900000
export const MAX_SERVER_ERRORS_PER_ITEM = 12

export const RATE_LIMIT_DEFAULT_PAUSE_MS = 60000
export const RATE_LIMIT_MIN_PAUSE_MS = 5000
export const RATE_LIMIT_MAX_PAUSE_MS = 900000

export const LEASE_TTL_MS = 30000
export const LEASE_HEARTBEAT_MS = 10000

const DAY_MS = 24 * 60 * 60 * 1000
export const STALE_UNKNOWN_OUTCOME_MS = 12 * DAY_MS
export const HISTORY_MAX = 100
export const HISTORY_MAX_AGE_MS = 14 * DAY_MS

export const OUTBOX_MAX_BYTES = 300 * MIB
export const OUTBOX_MIN_FREE_BYTES = 100 * MIB
export const OUTBOX_MAX_ITEMS = 500

export const MAX_PHOTO_BYTES = 15 * MIB
export const MAX_PHOTOS_PER_ITEM = 12
export const TARGET_ITEM_BYTES = 10 * MIB

export const OLD_ITEM_WARN_MS = 3 * DAY_MS
export const OLD_ITEM_STRONG_WARN_MS = 7 * DAY_MS

export const FOREGROUND_UPDATE_CHECK_MS = 1800000

// Not in the §6.2.1 table but fixed by the surrounding sections.
/** Highest item `schema` this build can replay (§6.2.4 #13). */
export const SUPPORTED_ITEM_SCHEMA = 1
/** Server feature marker required for any replay (§6.1, `services/api_info.py`). */
export const REQUIRED_SERVER_FEATURE = 'idempotency-v1'
/** `retry_wait` delay for 409 `idempotency_in_progress` (§6.2.7: ~3 s). */
export const IN_PROGRESS_RETRY_MS = 3000
/** Consecutive identical `failed` outcomes that end a replay session (§6.2.6 step 10). */
export const CIRCUIT_BREAKER_THRESHOLD = 3
/** Consecutive network errors that end a replay session (§6.2.6 step 10). */
export const CONSECUTIVE_NETWORK_ERRORS_LIMIT = 2
/** Consecutive non-`reachable` probes before the offline banner shows (§6.2.8). */
export const BANNER_AFTER_FAILED_PROBES = 2

export const ITEM_TYPES = Object.freeze({
  SCAN_UPLOAD: 'scan.upload',
  COLLECTION_ADD: 'collection.add',
  WISHLIST_ADD: 'wishlist.add',
})

/** Upload timeout: 40 KiB/s floor, below nginx `proxy_read_timeout 300s`. */
export function uploadTimeoutMs(bytes) {
  const raw = 30000 + (Number(bytes) || 0) / 40960 * 1000
  return Math.min(290000, Math.max(60000, raw))
}

/** Per-attempt timeout of an item; also sets the claim expiry. */
export function attemptTimeoutMs(item) {
  return item.type === ITEM_TYPES.SCAN_UPLOAD ? uploadTimeoutMs(item.photoBytes) : JSON_TIMEOUT_MS
}

/** Reachability monitor (independent of the queue): short probes so the banner shows quickly. */
export const MONITOR_PROBE_TIMEOUT_MS = 3000
export const MONITOR_CONFIRM_DELAY_MS = 1000
export const MONITOR_MAX_RETRY_MS = 10000
