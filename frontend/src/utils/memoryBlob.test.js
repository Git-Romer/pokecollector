import { describe, expect, it } from 'vitest'
import { prepareUploadPart } from './memoryBlob'

describe('prepareUploadPart', () => {
  it('returns the file unchanged when disabled', async () => {
    const file = new File(['abc'], 'a.jpg', { type: 'image/jpeg' })
    expect(await prepareUploadPart(file, { enabled: false })).toBe(file)
    expect(await prepareUploadPart(file)).toBe(file)
  })

  it('copies small files into a memory Blob with the same bytes and type', async () => {
    const file = new File(['hello'], 'a.jpg', { type: 'image/jpeg' })
    const part = await prepareUploadPart(file, { enabled: true })
    expect(part).not.toBe(file)
    expect(part.type).toBe('image/jpeg')
    expect(part.size).toBe(5)
    expect(await part.text()).toBe('hello')
  })

  it('slices files larger than 8 MiB instead of copying them', async () => {
    const big = { size: 9 * 1024 * 1024, type: 'image/png', calls: [], slice(...args) { this.calls.push(args); return 'sliced' } }
    expect(await prepareUploadPart(big, { enabled: true })).toBe('sliced')
    expect(big.calls).toEqual([[0, big.size, 'image/png']])
  })

  it('keeps an exactly 8 MiB file on the memory-copy path', async () => {
    let copied = false
    const file = { size: 8 * 1024 * 1024, type: 'image/png', arrayBuffer: async () => { copied = true; return new ArrayBuffer(0) } }
    await prepareUploadPart(file, { enabled: true })
    expect(copied).toBe(true)
  })
})
