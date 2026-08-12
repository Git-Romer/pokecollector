/**
 * Guards the two halves of a bug where uploading a card photo blanked the page.
 *
 * The client sets Content-Type: application/json for every request. A multipart
 * upload that does not override it is sent under the wrong content type, the
 * server cannot find the file field, and answers 422 — whose `detail` is an
 * array of objects. Passing that array to a toast rendered an object as a React
 * child, which throws and unmounts the app: the whole page went dark behind the
 * modal backdrop, with no error message anywhere.
 *
 * Neither half was caught by testing the endpoint with curl, because curl sets
 * the multipart header itself. It only reproduces through this client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn(() => Promise.resolve({ data: {} }))
const del = vi.fn(() => Promise.resolve({ data: {} }))

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post,
      delete: del,
      get: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}))

const { uploadCollectionItemPhoto, deleteAllCollectionCardPhotos, getApiErrorMessage } = await import('./client')

describe('uploadCollectionItemPhoto', () => {
  beforeEach(() => post.mockClear())

  it('overrides the client-wide JSON content type', () => {
    uploadCollectionItemPhoto(64, new File(['x'], 'card.jpg', { type: 'image/jpeg' }))
    const [, , config] = post.mock.calls[0]
    expect(config?.headers?.['Content-Type']).toBe('multipart/form-data')
  })

  it('posts the file as form data under the field the server reads', () => {
    const file = new File(['x'], 'card.jpg', { type: 'image/jpeg' })
    uploadCollectionItemPhoto(64, file)
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/collection/64/photo')
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('file')).toBe(file)
  })
})

describe('getApiErrorMessage on a validation failure', () => {
  // The exact shape FastAPI returns, and the shape that crashed the page.
  const validationError = {
    response: {
      data: {
        detail: [
          {
            type: 'missing',
            loc: ['body', 'file'],
            msg: 'Field required',
            input: null,
            url: 'https://errors.pydantic.dev/2.13/v/missing',
          },
        ],
      },
    },
  }

  it('flattens the array of objects into a string a toast can render', () => {
    const message = getApiErrorMessage(validationError, 'fallback')
    expect(typeof message).toBe('string')
    expect(message).toContain('Field required')
  })

  it('never returns an object, whatever the server sends', () => {
    for (const detail of [
      [{ msg: 'a' }, { msg: 'b' }],
      { msg: 'nested' },
      'plain string',
      undefined,
    ]) {
      const out = getApiErrorMessage({ response: { data: { detail } } }, 'fallback')
      expect(typeof out).toBe('string')
    }
  })
})

describe('deleteAllCollectionCardPhotos', () => {
  beforeEach(() => del.mockClear())

  it('uses the owner-scoped settings cleanup endpoint', async () => {
    await deleteAllCollectionCardPhotos()
    expect(del).toHaveBeenCalledWith('/settings/card-photos')
  })
})
