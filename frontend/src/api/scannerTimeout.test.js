import { describe, expect, test } from 'vitest'

import { scannerTestRequestTimeoutMs } from '../utils/scannerTimeout'


describe('scanner configuration test timeout', () => {
  test.each([
    [30, 100_000],
    [60, 190_000],
    [120, 370_000],
    [180, 550_000],
  ])('keeps three %s-second provider attempts within the browser request', (seconds, expected) => {
    expect(scannerTestRequestTimeoutMs(seconds)).toBe(expected)
  })

  test.each([undefined, null, '', 0, 45, 181, 'not-a-number'])(
    'falls back safely for unsupported value %s',
    (value) => {
      expect(scannerTestRequestTimeoutMs(value)).toBe(100_000)
    },
  )
})
