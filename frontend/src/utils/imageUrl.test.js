import { describe, expect, it } from 'vitest'

import { productImageUrl } from './imageUrl'

describe('productImageUrl', () => {
  it('uses the opaque product image proxy for configured images', () => {
    expect(productImageUrl({
      image_url: 'https://images.example.test/box.webp',
      image_proxy_url: '/api/images/product/42?token=signed',
    })).toBe('/api/images/product/42?token=signed')
  })

  it('uses the existing card back without a configured image', () => {
    expect(productImageUrl({ id: 42, image_url: null, image_proxy_url: null })).toBe('/cardback.jpg')
    expect(productImageUrl(null)).toBe('/cardback.jpg')
  })
})
