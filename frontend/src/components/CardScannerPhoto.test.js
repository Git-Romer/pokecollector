import { describe, expect, it, vi } from 'vitest'
import { attachScanFallbackPhoto } from './CardScanner'

describe('attachScanFallbackPhoto', () => {
  it('retains an individual scan when catalogue artwork and a saved fallback are missing', async () => {
    const photo = new Blob(['individual'], { type: 'image/jpeg' })
    const uploadPhoto = vi.fn().mockResolvedValue({})
    const attached = await attachScanFallbackPhoto({
      created: { id: 11, has_scan_photo: false, card: { id: 'missing-art-card' } },
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
      created: { id: 12, has_scan_photo: false, card: { id: 'missing-art-card' } },
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
      created: { id: 13, has_scan_photo: true, card: { id: 'missing-art-card' } },
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
      created: { id: 14, has_scan_photo: false, card: { id: 'catalogued-card', images_small: 'scan.webp' } },
      match: { id: 'recognition-card-without-art' },
      getPhoto,
      uploadPhoto: vi.fn(),
    })
    expect(attached).toBe(false)
    expect(getPhoto).not.toHaveBeenCalled()
  })

  it('uses the confirmed language card rather than recognition artwork', async () => {
    const photo = new Blob(['translated'], { type: 'image/jpeg' })
    const uploadPhoto = vi.fn().mockResolvedValue({})
    const attached = await attachScanFallbackPhoto({
      created: { id: 16, has_scan_photo: false, card: { id: 'target-language-without-art' } },
      match: { id: 'recognized-language-with-art', images_small: 'scan.webp' },
      getPhoto: vi.fn().mockResolvedValue(photo),
      uploadPhoto,
    })
    expect(attached).toBe(true)
    expect(uploadPhoto).toHaveBeenCalledWith(16, photo)
  })

  it('preserves an existing custom catalogue fallback', async () => {
    const getPhoto = vi.fn()
    const attached = await attachScanFallbackPhoto({
      created: {
        id: 17,
        has_scan_photo: false,
        card: { id: 'fallback-card', custom_image_url: 'https://example.test/card.jpg' },
      },
      match: { id: 'fallback-card' },
      getPhoto,
      uploadPhoto: vi.fn(),
    })
    expect(attached).toBe(false)
    expect(getPhoto).not.toHaveBeenCalled()
  })

  it('swallows upload failures after the collection item was added', async () => {
    const attached = await attachScanFallbackPhoto({
      created: { id: 15, has_scan_photo: false, card: { id: 'missing-art-card' } },
      match: { id: 'missing-art-card' },
      getPhoto: () => Promise.resolve(new Blob(['x'])),
      uploadPhoto: vi.fn().mockRejectedValue(new Error('storage unavailable')),
    })
    expect(attached).toBe(false)
  })
})
