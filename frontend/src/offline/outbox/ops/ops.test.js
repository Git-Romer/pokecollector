import { describe, expect, it, vi } from 'vitest'
import { collectionAdd } from './collectionAdd.js'
import { scanUpload } from './scanUpload.js'
import { wishlistAdd } from './wishlistAdd.js'

const baseItem = overrides => ({ id: 'item-1', userId: 1, photoCount: 0, payload: {}, display: {}, ...overrides })

describe('scanUpload', () => {
  it('builds multipart with fresh Blobs, no Content-Type, and individual_positions', async () => {
    const photos = [
      { index: 0, name: 'a.jpg', type: 'image/jpeg', bytes: new Uint8Array([1, 2]).buffer },
      { index: 1, name: 'b.heic', type: 'image/heic', bytes: new Uint8Array([3, 4, 5]).buffer },
    ]
    const readPhotos = vi.fn(async function* read() { yield* photos })
    const req = await scanUpload.buildRequest(baseItem({ photoCount: 2, payload: { individualPositions: [2] } }), readPhotos)
    expect(readPhotos).toHaveBeenCalledWith('item-1')
    expect(req).toMatchObject({ url: '/api/cards/recognize/jobs', method: 'POST' })
    expect(req.headers).toEqual({})
    const files = req.body.getAll('files')
    expect(files.map(f => [f.name, f.type, f.size])).toEqual([['a.jpg', 'image/jpeg', 2], ['b.heic', 'image/heic', 3]])
    files.forEach(f => expect(f).toBeInstanceOf(Blob))
    expect(req.body.get('individual_positions')).toBe('[2]')
  })

  it('defaults individual_positions to []', async () => {
    const req = await scanUpload.buildRequest(baseItem(), async function* empty() {})
    expect(req.body.get('individual_positions')).toBe('[]')
  })

  it('validates a numeric job id, summarizes and invalidates scan-jobs', () => {
    expect(scanUpload.type).toBe('scan.upload')
    expect(scanUpload.validateResponse({ id: 3 })).toBe(true)
    expect(scanUpload.validateResponse({ id: '3' })).toBe(false)
    expect(scanUpload.summarize(baseItem({ photoCount: 1 }))).toBe('1 photo')
    expect(scanUpload.summarize(baseItem({ photoCount: 5 }))).toBe('5 photos')
    expect(scanUpload.summarize(baseItem({ display: { title: 'Shop scans' } }))).toBe('Shop scans')
    const queryClient = { invalidateQueries: vi.fn() }
    scanUpload.onSynced(queryClient, { id: 3 })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['scan-jobs'] })
  })
})

describe.each([
  [collectionAdd, 'collection.add', '/api/collection/', { id: 1, card_id: 'sv1-1' }, { id: 1 }],
  [wishlistAdd, 'wishlist.add', '/api/wishlist/', { id: 1 }, { id: 'x' }],
])('%#: JSON add op', (op, type, url, valid, invalid) => {
  it('posts the payload as JSON', async () => {
    const payload = { card_id: 'sv1-1', quantity: 2 }
    const req = await op.buildRequest(baseItem({ payload }))
    expect(op.type).toBe(type)
    expect(req).toMatchObject({ url, method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(req.body)).toEqual(payload)
  })

  it('validates the response shape', () => {
    expect(op.validateResponse(valid)).toBe(true)
    expect(op.validateResponse(invalid)).toBe(false)
  })

  it('summarizes with the display title, then the card id', () => {
    expect(op.summarize(baseItem({ display: { title: 'Pikachu' }, payload: { card_id: 'sv1-1' } }))).toBe('Pikachu')
    expect(op.summarize(baseItem({ payload: { card_id: 'sv1-1' } }))).toBe('sv1-1')
  })

  it('invalidates card state, Pokédex and filter-language queries', () => {
    const queryClient = { invalidateQueries: vi.fn() }
    op.onSynced(queryClient, valid)
    const keys = queryClient.invalidateQueries.mock.calls.map(([arg]) => arg.queryKey?.[0]).filter(Boolean)
    expect(keys).toEqual(expect.arrayContaining(['collection', 'wishlist', 'dashboard', 'tcgdex-filter-languages']))
    expect(() => op.onSynced(null, valid)).not.toThrow()
  })
})
