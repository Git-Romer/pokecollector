import { describe, expect, it, vi } from 'vitest'
import { attachScanFallbackPhoto } from './CardScanner'

describe('attachScanFallbackPhoto', () => {
  it('retains an individual scan when catalogue artwork and a saved fallback are missing', async () => {
    const photo = new Blob(['individual'], { type: 'image/jpeg' })
    const uploadPhoto = vi.fn().mockResolvedValue({})
    const attached = await attachScanFallbackPhoto({
      created: { id: 11, has_scan_photo: false },
      match: { id: 'missing-art-card' },
      getPhoto: vi.fn().mockResolvedValue(photo),
      uploadPhoto,
    })
    expect(attached).toBe(true)
    expect(uploadPhoto).toHaveBeenCalledWith(11, photo)
  })

  it('accepts the stored Blob source used by the batch queue', async () => {
    const storedBatchPhoto = new Blob(['batch'], { type: 'image/jpeg' })
    const uploadPhoto = vi.fn().mockResolvedValue({})
    const attached = await attachScanFallbackPhoto({
      created: { id: 12, has_scan_photo: false },
      match: { id: 'missing-art-card' },
      getPhoto: () => Promise.resolve(storedBatchPhoto),
      uploadPhoto,
    })
    expect(attached).toBe(true)
    expect(uploadPhoto).toHaveBeenCalledWith(12, storedBatchPhoto)
  })

  it('preserves an existing private photo', async () => {
    const getPhoto = vi.fn()
    const uploadPhoto = vi.fn()
    const attached = await attachScanFallbackPhoto({
      created: { id: 13, has_scan_photo: true },
      match: { id: 'missing-art-card' },
      getPhoto,
      uploadPhoto,
    })
    expect(attached).toBe(false)
    expect(getPhoto).not.toHaveBeenCalled()
    expect(uploadPhoto).not.toHaveBeenCalled()
  })

  it('does not retain scanner photos when catalogue artwork exists', async () => {
    const getPhoto = vi.fn()
    const attached = await attachScanFallbackPhoto({
      created: { id: 14, has_scan_photo: false },
      match: { id: 'catalogued-card', images_small: 'scan.webp' },
      getPhoto,
      uploadPhoto: vi.fn(),
    })
    expect(attached).toBe(false)
    expect(getPhoto).not.toHaveBeenCalled()
  })

  it('swallows upload failures after the collection item was added', async () => {
    const attached = await attachScanFallbackPhoto({
      created: { id: 15, has_scan_photo: false },
      match: { id: 'missing-art-card' },
      getPhoto: () => Promise.resolve(new Blob(['x'])),
      uploadPhoto: vi.fn().mockRejectedValue(new Error('storage unavailable')),
    })
    expect(attached).toBe(false)
  })
})
