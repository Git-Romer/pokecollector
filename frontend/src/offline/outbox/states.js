// State machine of docs/PWA_OFFLINE_DESIGN.md §6.2.4 as data.

export const STATES = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  RETRY_WAIT: 'retry_wait',
  BLOCKED: 'blocked',
  FAILED: 'failed',
})

/** Terminal outcomes: the item no longer exists afterwards. */
export const TERMINAL = Object.freeze({ SENT: 'sent', CANCELLED: 'cancelled' })

export const BLOCK_CODES = Object.freeze({
  AUTH: 'auth',
  PROXY: 'proxy',
  WRONG_ACCOUNT: 'wrong_account',
  SERVER_OLD: 'server_old',
  NEWER_SCHEMA: 'newer_schema',
})

export const ACTORS = Object.freeze({
  UI: 'ui',
  REPLAYER: 'replayer',
  ENGINE: 'engine',
  PROVIDER: 'provider',
})

const ANY = '*'
const LIVE = ['pending', 'sending', 'retry_wait', 'blocked', 'failed']

/**
 * One entry per row of the §6.2.4 table (`id` is the row number). `from: ['*']`
 * means every live state; `from: [null]` is a new item. Row 11 excludes a
 * `sending` item with a live claim, which the caller checks (it needs the clock).
 */
export const TRANSITIONS = Object.freeze([
  { id: 1, from: [null], to: 'pending', actor: ['ui'] },
  { id: 2, from: ['pending', 'retry_wait'], to: 'sending', actor: ['replayer'] },
  { id: 3, from: ['sending'], to: 'sent', actor: ['replayer'] },
  { id: 4, from: ['sending'], to: 'retry_wait', actor: ['replayer'] },
  { id: '4b', from: ['sending'], to: 'pending', actor: ['replayer'] },
  { id: 5, from: ['sending'], to: 'blocked', actor: ['replayer'] },
  { id: 6, from: ['sending'], to: 'failed', actor: ['replayer'] },
  { id: 7, from: ['sending'], to: 'retry_wait', actor: ['replayer'] },
  { id: 8, from: ['blocked'], to: 'pending', actor: ['provider', 'ui'] },
  { id: 9, from: ['failed'], to: 'pending', actor: ['ui'] },
  { id: 10, from: ['failed'], to: 'pending', actor: ['ui'] },
  { id: 11, from: ['pending', 'sending', 'retry_wait', 'blocked', 'failed'], to: 'cancelled', actor: ['ui'] },
  { id: 12, from: ['pending'], to: 'pending', actor: ['ui'] },
  { id: 13, from: [ANY], to: 'blocked', actor: ['engine'] },
])

function matches(row, from, to, actor) {
  if (row.to !== to || !row.actor.includes(actor)) return false
  if (row.from.includes(ANY)) return from !== null && LIVE.includes(from)
  return row.from.includes(from)
}

/** `from` is `null` for a new item. */
export function canTransition(from, to, actor) {
  return TRANSITIONS.some(row => matches(row, from, to, actor))
}

/** Row ids of the §6.2.4 table that allow this transition (for tests and docs). */
export function transitionRows(from, to, actor) {
  return TRANSITIONS.filter(row => matches(row, from, to, actor)).map(row => row.id)
}

export const isEligibleState = state => state === 'pending' || state === 'retry_wait'
