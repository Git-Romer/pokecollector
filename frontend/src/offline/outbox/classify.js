// Table-driven response classification (docs/PWA_OFFLINE_DESIGN.md §6.2.7).
// Rows are evaluated in order; the first match wins. Each row has a stable `id`
// so tests can assert one case per row of the design table.

import { IN_PROGRESS_RETRY_MS } from '../constants.js'
import { parseRetryAfter } from './backoff.js'

const isNum = value => typeof value === 'number' && Number.isFinite(value)

const SHAPE_VALIDATORS = {
  'scan.upload': json => isNum(json?.id),
  'collection.add': json => isNum(json?.id) && typeof json?.card_id === 'string',
  'wishlist.add': json => isNum(json?.id),
}

/** 2xx body check per operation type. Unknown types never validate. */
export function validateShape(opType, json) {
  const validator = SHAPE_VALIDATORS[opType]
  return Boolean(validator && json && typeof json === 'object' && validator(json))
}

function headerOf(response, name) {
  try {
    return response?.headers?.get?.(name) ?? null
  } catch {
    return null
  }
}

function isJsonResponse(response) {
  return /json/i.test(headerOf(response, 'content-type') || '')
}

/** Server `detail` as `{code, message}`; FastAPI validation arrays become a short message. */
export function describeDetail(json) {
  const detail = json && typeof json === 'object' ? json.detail : undefined
  if (typeof detail === 'string') return { code: undefined, message: detail }
  if (Array.isArray(detail)) {
    const first = detail[0]
    const where = Array.isArray(first?.loc) ? first.loc.filter(part => part !== 'body').join('.') : ''
    const text = first?.msg ? `${where ? `${where}: ` : ''}${first.msg}` : 'Validation failed'
    return { code: undefined, message: text }
  }
  if (detail && typeof detail === 'object') {
    return {
      code: typeof detail.code === 'string' ? detail.code : undefined,
      message: typeof detail.message === 'string' ? detail.message : (detail.code || JSON.stringify(detail)),
    }
  }
  if (json && typeof json === 'object' && typeof json.error === 'string') {
    return { code: undefined, message: json.error }
  }
  return { code: undefined, message: '' }
}

function outcome(next, rowId, fields = {}) {
  return { next, rowId, ...fields }
}

function failed(rowId, ctx, fields) {
  const detail = describeDetail(ctx.json)
  return outcome('failed', rowId, {
    kind: 'http',
    status: ctx.status,
    code: detail.code,
    message: detail.message || `Request failed (HTTP ${ctx.status})`,
    detailKey: JSON.stringify(ctx.json?.detail ?? null),
    ...fields,
  })
}

function blocked(rowId, code, ctx, message, fields) {
  return outcome('blocked', rowId, { kind: code === 'proxy' ? 'proxy' : 'http', status: ctx.status, code, message, ...fields })
}

export const CLASSIFY_ROWS = [
  {
    id: 'network',
    when: ctx => Boolean(ctx.error),
    result: ctx => outcome('retry_wait', 'network', {
      kind: 'network',
      message: ctx.error?.name === 'AbortError' ? 'Request timed out' : 'Network error',
      maybeApplied: true,
      networkError: true,
    }),
  },
  {
    id: 'opaque_redirect',
    when: ctx => ctx.response?.type === 'opaqueredirect' || ctx.status === 0,
    result: ctx => blocked('opaque_redirect', 'proxy', ctx, 'The request was redirected (sign-in page in front of the server?)'),
  },
  {
    id: 'ok_valid',
    when: ctx => ctx.status >= 200 && ctx.status < 300 && ctx.isJson && validateShape(ctx.opType, ctx.json),
    result: ctx => outcome('sent', 'ok_valid', { status: ctx.status, replayed: headerOf(ctx.response, 'idempotent-replayed') === 'true' }),
  },
  {
    id: 'ok_not_json',
    when: ctx => ctx.status >= 200 && ctx.status < 300 && !ctx.isJson,
    result: ctx => blocked('ok_not_json', 'proxy', ctx, 'The server answered with a page instead of data (sign-in page in front of the server?)', { maybeApplied: false }),
  },
  {
    id: 'ok_bad_shape',
    when: ctx => ctx.status >= 200 && ctx.status < 300,
    result: ctx => outcome('failed', 'ok_bad_shape', {
      kind: 'shape',
      status: ctx.status,
      code: 'shape',
      message: 'The server answered, but the response was not what was expected',
      detailKey: 'shape',
      maybeApplied: true,
    }),
  },
  {
    id: 'rate_limited',
    when: ctx => ctx.status === 429,
    result: ctx => outcome('pending', 'rate_limited', {
      kind: 'http',
      status: 429,
      code: 'rate_limited',
      message: 'The server is rate limiting requests',
      rateLimited: true,
      retryAfterMs: parseRetryAfter(headerOf(ctx.response, 'retry-after'), ctx.now),
    }),
  },
  {
    id: 'gateway',
    when: ctx => ctx.status === 502 || ctx.status === 503 || ctx.status === 504,
    result: ctx => outcome('retry_wait', 'gateway', {
      kind: 'http',
      status: ctx.status,
      message: `Server temporarily unavailable (HTTP ${ctx.status})`,
      maybeApplied: true,
      probe: true,
    }),
  },
  {
    id: 'server_error',
    when: ctx => ctx.status >= 500,
    result: ctx => outcome('retry_wait', 'server_error', {
      kind: 'http',
      status: ctx.status,
      message: describeDetail(ctx.json).message || `Server error (HTTP ${ctx.status})`,
      serverError: true,
      ...(ctx.isJson ? {} : { maybeApplied: true }),
    }),
  },
  {
    id: 'unauthorized',
    when: ctx => ctx.status === 401 && ctx.isJson,
    result: ctx => blocked('unauthorized', 'auth', ctx, 'Signed out or session expired'),
  },
  {
    id: 'proxy_non_json',
    when: ctx => [400, 401, 403, 404].includes(ctx.status) && !ctx.isJson,
    result: ctx => blocked('proxy_non_json', 'proxy', ctx, `The server answered with a page instead of data (HTTP ${ctx.status})`),
  },
  {
    id: 'forbidden',
    when: ctx => ctx.status === 403,
    result: ctx => failed('forbidden', ctx, { code: 'forbidden' }),
  },
  {
    id: 'not_found_or_bad_request',
    when: ctx => ctx.status === 404 || ctx.status === 400,
    result: ctx => failed('not_found_or_bad_request', ctx),
  },
  {
    id: 'in_progress',
    when: ctx => ctx.status === 409 && ctx.detail.code === 'idempotency_in_progress',
    result: ctx => outcome('retry_wait', 'in_progress', {
      kind: 'http',
      status: 409,
      code: 'idempotency_in_progress',
      message: 'The server is still processing this item',
      delayMs: IN_PROGRESS_RETRY_MS,
      penalty: false,
    }),
  },
  {
    id: 'wrong_account',
    when: ctx => ctx.status === 409 && ctx.detail.code === 'wrong_account',
    result: ctx => blocked('wrong_account', 'wrong_account', ctx, 'This item belongs to a different account'),
  },
  {
    id: 'conflict_other',
    when: ctx => ctx.status === 409,
    result: ctx => failed('conflict_other', ctx),
  },
  {
    id: 'too_large',
    when: ctx => ctx.status === 413,
    result: ctx => outcome('failed', 'too_large', {
      kind: 'http',
      status: 413,
      code: 'too_large',
      message: describeDetail(ctx.json).message || 'The upload is too large for the server',
      detailKey: 'too_large',
    }),
  },
  {
    id: 'key_reused',
    when: ctx => ctx.status === 422 && ctx.detail.code === 'idempotency_key_reused',
    result: ctx => failed('key_reused', ctx, { code: 'key_reused' }),
  },
  {
    id: 'validation',
    when: ctx => ctx.status === 422,
    result: ctx => failed('validation', ctx, { code: 'validation' }),
  },
  {
    id: 'other_4xx',
    when: ctx => ctx.status >= 400 && ctx.status < 500,
    result: ctx => failed('other_4xx', ctx),
  },
  {
    // Informational / unexpected redirect statuses: treat like a proxy in front of the server.
    id: 'unexpected',
    when: () => true,
    result: ctx => blocked('unexpected', 'proxy', ctx, `Unexpected response from the server (HTTP ${ctx.status})`),
  },
]

/**
 * `response` is a fetch `Response` (or a minimal `{status, type, headers}`), `json` the
 * parsed body (undefined when absent or unparseable), `error` the rejection of `fetch`.
 */
export function classifyResponse(opType, { error = null, response = null, json, now = Date.now() } = {}) {
  const status = response ? Number(response.status) : NaN
  const ctx = {
    opType,
    error,
    response,
    json,
    now,
    status,
    isJson: response ? isJsonResponse(response) : false,
    detail: describeDetail(json),
  }
  const row = CLASSIFY_ROWS.find(candidate => candidate.when(ctx))
  return row.result(ctx)
}
