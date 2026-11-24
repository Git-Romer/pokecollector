import { describe, expect, it } from 'vitest'
import * as c from './constants.js'

const DAY = 86400000
const MIB = 1048576

describe('constants (design §6.2.1)', () => {
  it('matches the table', () => {
    expect(c.OUTBOX_DB_NAME).toBe('pokecollector-outbox')
    expect(c.OUTBOX_DB_VERSION).toBe(1)
    expect(c.PROBE_TIMEOUT_MS).toBe(5000)
    expect(c.PROBE_BACKOFF_MS).toEqual([15000, 30000, 60000, 120000])
    expect(c.REPLAY_TICK_MS).toBe(15000)
    expect(c.PACE_MS).toBe(2000)
    expect(c.JSON_TIMEOUT_MS).toBe(20000)
    expect(c.CLAIM_GRACE_MS).toBe(15000)
    expect([c.BACKOFF_BASE_MS, c.BACKOFF_CAP_MS]).toEqual([5000, 900000])
    expect(c.MAX_SERVER_ERRORS_PER_ITEM).toBe(12)
    expect(c.RATE_LIMIT_DEFAULT_PAUSE_MS).toBe(60000)
    expect([c.LEASE_TTL_MS, c.LEASE_HEARTBEAT_MS]).toEqual([30000, 10000])
    expect(c.STALE_UNKNOWN_OUTCOME_MS).toBe(12 * DAY)
    expect([c.HISTORY_MAX, c.HISTORY_MAX_AGE_MS]).toEqual([100, 14 * DAY])
    expect([c.OUTBOX_MAX_BYTES, c.OUTBOX_MIN_FREE_BYTES, c.OUTBOX_MAX_ITEMS]).toEqual([300 * MIB, 100 * MIB, 500])
    expect([c.MAX_PHOTO_BYTES, c.MAX_PHOTOS_PER_ITEM, c.TARGET_ITEM_BYTES]).toEqual([15 * MIB, 12, 10 * MIB])
    expect([c.OLD_ITEM_WARN_MS, c.OLD_ITEM_STRONG_WARN_MS]).toEqual([3 * DAY, 7 * DAY])
    expect(c.FOREGROUND_UPDATE_CHECK_MS).toBe(1800000)
  })

  it('uploadTimeoutMs clamps 30 s + bytes / 40 KiB/s to [60 s, 290 s]', () => {
    expect(c.uploadTimeoutMs(0)).toBe(60000)
    expect(c.uploadTimeoutMs(40960 * 100)).toBe(130000)
    expect(c.uploadTimeoutMs(10 * MIB)).toBe(30000 + (10 * MIB) / 40960 * 1000)
    expect(c.uploadTimeoutMs(15 * MIB)).toBe(290000)
  })

  it('attemptTimeoutMs uses the upload formula for scans and 20 s otherwise', () => {
    expect(c.attemptTimeoutMs({ type: 'scan.upload', photoBytes: 0 })).toBe(60000)
    expect(c.attemptTimeoutMs({ type: 'collection.add' })).toBe(20000)
  })
})
