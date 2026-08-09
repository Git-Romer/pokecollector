import { describe, expect, it } from 'vitest'
import { formatRetryCountdown, retryCountdownParts } from './retryCountdown'

const now = Date.parse('2026-08-09T16:00:00Z')
const t = key => ({
  'scanner.itemRetrying': 'Waiting to retry…',
  'scanner.retryingInSeconds': 'Retrying in {seconds}s',
  'scanner.retryingInMinutes': 'Retrying in {minutes}m',
  'scanner.retryingInHours': 'Retrying in {hours}h {minutes}m',
}[key])

describe('retry countdown', () => {
  it('treats backend timestamps without an offset as UTC', () => {
    expect(retryCountdownParts('2026-08-09T16:00:42', now)).toEqual({
      unit: 'seconds',
      seconds: 42,
    })
  })

  it('formats minute and hour countdowns compactly', () => {
    expect(formatRetryCountdown('2026-08-09T16:21:00Z', t, now)).toBe('Retrying in 21m')
    expect(formatRetryCountdown('2026-08-09T21:05:00Z', t, now)).toBe('Retrying in 5h 5m')
  })

  it('falls back to the generic retry status without a timestamp', () => {
    expect(formatRetryCountdown(null, t, now)).toBe('Waiting to retry…')
  })
})
