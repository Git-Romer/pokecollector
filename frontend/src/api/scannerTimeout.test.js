import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  scannerRecognitionRequestTimeoutMs,
  scannerTestRequestTimeoutMs,
} from '../utils/scannerTimeout'

const post = vi.fn(() => Promise.resolve({ data: {} }))

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post,
      delete: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}))

const { recognizeCard, testScannerConfiguration } = await import('./client')


describe('scanner configuration test timeout', () => {
  beforeEach(() => post.mockClear())

  test.each([
    [30, 190_000],
    [60, 370_000],
    [120, 730_000],
    [180, 1_090_000],
  ])('keeps the complete %s-second capability test within the browser request', (seconds, expected) => {
    expect(scannerTestRequestTimeoutMs(seconds)).toBe(expected)
  })

  test.each([
    [30, 240_000],
    [60, 390_000],
    [120, 690_000],
    [180, 990_000],
  ])('keeps a synchronous %s-second recognition flow within the browser request', (seconds, expected) => {
    expect(scannerRecognitionRequestTimeoutMs(seconds)).toBe(expected)
  })

  test.each([undefined, null, '', 0, 45, 181, 'not-a-number'])(
    'falls back safely for unsupported value %s',
    (value) => {
      expect(scannerTestRequestTimeoutMs(value)).toBe(190_000)
      expect(scannerRecognitionRequestTimeoutMs(value)).toBe(240_000)
    },
  )

  test('applies the complete test envelope to the Axios request', async () => {
    await testScannerConfiguration({ request_timeout_seconds: 180 })
    const [url, , config] = post.mock.calls[0]
    expect(url).toBe('/settings/scanner/test')
    expect(config.timeout).toBe(1_090_000)
  })

  test('applies the complete synchronous recognition envelope to Axios', async () => {
    await recognizeCard(new File(['image'], 'card.jpg', { type: 'image/jpeg' }), 180)
    const [url, body, config] = post.mock.calls[0]
    expect(url).toBe('/cards/recognize')
    expect(body.get('file')).toBeInstanceOf(File)
    expect(config.timeout).toBe(990_000)
  })
})
