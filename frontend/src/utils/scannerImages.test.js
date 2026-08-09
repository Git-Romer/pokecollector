import { describe, expect, it } from 'vitest'
import { isSupportedScannerImage, SCANNER_IMAGE_ACCEPT } from './scannerImages'

describe('scanner image validation', () => {
  it('accepts supported raster camera formats', () => {
    expect(isSupportedScannerImage({ type: 'image/jpeg' })).toBe(true)
    expect(isSupportedScannerImage({ type: 'image/png' })).toBe(true)
    expect(SCANNER_IMAGE_ACCEPT).toContain('image/webp')
  })

  it('rejects active or ambiguous image formats', () => {
    expect(isSupportedScannerImage({ type: 'image/svg+xml' })).toBe(false)
    expect(isSupportedScannerImage({ type: 'text/html' })).toBe(false)
    expect(isSupportedScannerImage({ type: '' })).toBe(false)
  })
})
