import { describe, expect, it } from 'vitest'
import { showsOwnPhoto } from './CollectionCardImage'

describe('showsOwnPhoto', () => {
  const item = { id: 7, has_scan_photo: true }

  it('uses a private photo as fallback when catalogue artwork is missing', () => {
    expect(showsOwnPhoto(item, { id: 'card-1' }, false)).toBe(true)
  })

  it('keeps catalogue artwork primary by default', () => {
    expect(showsOwnPhoto(item, { id: 'card-1', images_small: 'scan.webp' }, false)).toBe(false)
  })

  it('uses the private photo first when the user preference is enabled', () => {
    expect(showsOwnPhoto(item, { id: 'card-1', images_small: 'scan.webp' }, true)).toBe(true)
  })

  it('does not invent a private photo', () => {
    expect(showsOwnPhoto({ id: 7, has_scan_photo: false }, { id: 'card-1' }, true)).toBe(false)
  })

  it('leaves manually created card artwork and its pencil badge alone', () => {
    expect(showsOwnPhoto(item, { id: 'custom-1', is_custom: true }, true)).toBe(false)
  })

  it('treats a manually supplied catalogue fallback URL as reference artwork', () => {
    expect(showsOwnPhoto(item, { id: 'card-1', custom_image_url: 'https://example.test/card.jpg' }, false)).toBe(false)
  })
})
