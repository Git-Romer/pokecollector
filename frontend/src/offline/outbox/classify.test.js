import { describe, expect, it } from 'vitest'
import { CLASSIFY_ROWS, classifyResponse, validateShape } from './classify.js'

const NOW = Date.parse('2026-10-18T12:00:00Z')

function res(status, body, headers = {}) {
  const hasBody = body !== undefined
  const isString = typeof body === 'string'
  return {
    response: new Response(hasBody ? (isString ? body : JSON.stringify(body)) : null, {
      status,
      headers: { ...(hasBody && !isString ? { 'content-type': 'application/json' } : {}), ...headers },
    }),
    json: hasBody && !isString ? body : undefined,
  }
}
const html = (status, headers = {}) => res(status, '<html>login</html>', { 'content-type': 'text/html', ...headers })
const classify = (type, input) => classifyResponse(type, { now: NOW, ...input })

describe('classifyResponse — one test per row of design §6.2.7', () => {
  it('rejects (TypeError/AbortError) → retry_wait, maybeApplied, network', () => {
    const out = classify('collection.add', { error: new TypeError('Failed to fetch') })
    expect(out).toMatchObject({ next: 'retry_wait', kind: 'network', maybeApplied: true, networkError: true })
    expect(classify('collection.add', { error: Object.assign(new Error('x'), { name: 'AbortError' }) }).message).toMatch(/timed out/)
  })

  it('opaque redirect → blocked(proxy)', () => {
    const out = classify('scan.upload', { response: { status: 0, type: 'opaqueredirect', headers: new Headers() } })
    expect(out).toMatchObject({ next: 'blocked', code: 'proxy', kind: 'proxy' })
  })

  it('status 0 → blocked(proxy)', () => {
    const out = classify('scan.upload', { response: { status: 0, type: 'basic', headers: new Headers() } })
    expect(out).toMatchObject({ next: 'blocked', code: 'proxy' })
  })

  it.each([
    ['scan.upload', { id: 5 }],
    ['collection.add', { id: 9, card_id: 'sv1-1' }],
    ['wishlist.add', { id: 2 }],
  ])('2xx with a valid JSON shape (%s) → sent', (type, body) => {
    expect(classify(type, res(200, body))).toMatchObject({ next: 'sent', replayed: false })
    expect(classify(type, res(201, body)).next).toBe('sent')
  })

  it('2xx replayed (Idempotent-Replayed: true) → sent', () => {
    expect(classify('wishlist.add', res(200, { id: 2 }, { 'Idempotent-Replayed': 'true' }))).toMatchObject({ next: 'sent', replayed: true })
  })

  it('2xx HTML (login page) → blocked(proxy), maybeApplied false', () => {
    expect(classify('wishlist.add', html(200))).toMatchObject({ next: 'blocked', code: 'proxy', maybeApplied: false })
  })

  it.each([
    ['collection.add', { id: 9 }],
    ['wishlist.add', { id: 'x' }],
    ['scan.upload', { ok: true }],
    ['scan.upload', []],
  ])('2xx JSON of the wrong shape (%s) → failed(shape), maybeApplied', (type, body) => {
    expect(classify(type, res(200, body))).toMatchObject({ next: 'failed', code: 'shape', kind: 'shape', maybeApplied: true })
  })

  it('2xx with a JSON content type but an unparseable body → failed(shape)', () => {
    const response = new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } })
    expect(classify('wishlist.add', { response, json: undefined })).toMatchObject({ next: 'failed', code: 'shape', maybeApplied: true })
  })

  it('401 JSON → blocked(auth)', () => {
    expect(classify('scan.upload', res(401, { detail: 'Not authenticated' }))).toMatchObject({ next: 'blocked', code: 'auth' })
  })

  it.each([401, 403, 404, 400])('%s non-JSON → blocked(proxy)', status => {
    expect(classify('scan.upload', html(status))).toMatchObject({ next: 'blocked', code: 'proxy' })
  })

  it('403 JSON → failed(forbidden)', () => {
    expect(classify('scan.upload', res(403, { detail: 'Read-only account' }))).toMatchObject({
      next: 'failed', code: 'forbidden', message: 'Read-only account',
    })
  })

  it.each([404, 400])('%s JSON → failed with the server detail', status => {
    expect(classify('collection.add', res(status, { detail: 'Card not found' }))).toMatchObject({
      next: 'failed', status, message: 'Card not found',
    })
  })

  it('409 idempotency_in_progress → retry_wait about 3 s, no penalty', () => {
    expect(classify('collection.add', res(409, { detail: { code: 'idempotency_in_progress' } }, { 'Retry-After': '2' }))).toMatchObject({
      next: 'retry_wait', code: 'idempotency_in_progress', delayMs: 3000, penalty: false,
    })
  })

  it('409 wrong_account → blocked(wrong_account)', () => {
    expect(classify('collection.add', res(409, { detail: { code: 'wrong_account' } }))).toMatchObject({
      next: 'blocked', code: 'wrong_account',
    })
  })

  it('409 other → failed', () => {
    expect(classify('collection.add', res(409, { detail: 'Shared template' }))).toMatchObject({ next: 'failed', status: 409 })
  })

  it.each([[true], [false]])('413 → failed(too_large) (JSON: %s)', isJson => {
    const input = isJson ? res(413, { detail: 'too big' }) : html(413)
    expect(classify('scan.upload', input)).toMatchObject({ next: 'failed', code: 'too_large' })
  })

  it('422 idempotency_key_reused → failed(key_reused)', () => {
    expect(classify('collection.add', res(422, { detail: { code: 'idempotency_key_reused' } }))).toMatchObject({
      next: 'failed', code: 'key_reused',
    })
  })

  it('422 other (FastAPI array detail) → failed(validation)', () => {
    const out = classify('collection.add', res(422, { detail: [{ loc: ['body', 'quantity'], msg: 'ensure this value is greater than 0' }] }))
    expect(out).toMatchObject({ next: 'failed', code: 'validation', message: 'quantity: ensure this value is greater than 0' })
  })

  it('429 with Retry-After (seconds, HTTP-date) → pending, rateLimited, no penalty', () => {
    expect(classify('scan.upload', res(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '30' }))).toMatchObject({
      next: 'pending', rateLimited: true, retryAfterMs: 30000,
    })
    expect(classify('scan.upload', res(429, undefined, { 'Retry-After': 'Sun, 18 Oct 2026 12:02:00 GMT' })).retryAfterMs).toBe(120000)
  })

  it('429 without Retry-After → retryAfterMs null (engine applies the 60 s default)', () => {
    expect(classify('scan.upload', res(429, { error: 'Rate limit exceeded' }))).toMatchObject({ next: 'pending', rateLimited: true, retryAfterMs: null })
  })

  it('500 JSON → retry_wait, serverError, maybeApplied not set', () => {
    const out = classify('collection.add', res(500, { detail: 'boom' }))
    expect(out).toMatchObject({ next: 'retry_wait', serverError: true })
    expect(out.maybeApplied).toBeUndefined()
  })

  it('500 without JSON and other 5xx → maybeApplied', () => {
    expect(classify('collection.add', html(500))).toMatchObject({ next: 'retry_wait', serverError: true, maybeApplied: true })
    expect(classify('collection.add', html(507))).toMatchObject({ next: 'retry_wait', serverError: true })
  })

  it.each([502, 503, 504])('%s → retry_wait, probe, maybeApplied, not counted', status => {
    const out = classify('collection.add', html(status))
    expect(out).toMatchObject({ next: 'retry_wait', probe: true, maybeApplied: true })
    expect(out.serverError).toBeUndefined()
  })

  it('other 4xx → failed', () => {
    expect(classify('collection.add', res(418, { detail: 'teapot' }))).toMatchObject({ next: 'failed', status: 418 })
    expect(classify('collection.add', html(405))).toMatchObject({ next: 'failed' })
  })

  it('an unexpected 3xx → blocked(proxy)', () => {
    expect(classify('collection.add', { response: new Response(null, { status: 302 }) })).toMatchObject({ next: 'blocked', code: 'proxy' })
  })

  it('every row has a unique id', () => {
    const ids = CLASSIFY_ROWS.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('validateShape', () => {
  it('requires numeric ids and a string card_id for collection adds', () => {
    expect(validateShape('collection.add', { id: 1, card_id: 'a' })).toBe(true)
    expect(validateShape('collection.add', { id: '1', card_id: 'a' })).toBe(false)
    expect(validateShape('unknown', { id: 1 })).toBe(false)
    expect(validateShape('wishlist.add', null)).toBe(false)
  })
})
