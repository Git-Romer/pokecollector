// Pure helpers for the OIDC browser flow.
//
// The provider callback lands on the fixed frontend completion path with no
// query string. Nothing here reads codes, state or tokens from the URL: the
// browser-bound handoff cookie is the only credential the completion request
// carries, and it is attached by the browser itself.

// Error codes the backend may put in `?oidc_error=`. Anything else is mapped to
// a generic message rather than displayed, so provider descriptions or raw
// query content can never reach the UI.
//
// The lookup table has a null prototype so an untrusted code such as
// `constructor`, `__proto__` or `toString` cannot resolve to an inherited
// member. A plain object literal would return a function or object for those
// codes, and the translation helper would then call `split` on it and crash.
const OIDC_ERROR_TRANSLATION_KEYS = Object.freeze(Object.assign(Object.create(null), {
  access_denied: 'auth.oidcErrors.accessDenied',
  configuration_error: 'auth.oidcErrors.unavailable',
  expired: 'auth.oidcErrors.expired',
  invalid_identity: 'auth.oidcErrors.failed',
  invalid_request: 'auth.oidcErrors.expired',
  invalid_state: 'auth.oidcErrors.expired',
  invalid_transaction: 'auth.oidcErrors.expired',
  link_failed: 'auth.oidcErrors.failed',
  // Codes the backend actually emits (`_OIDC_ALLOWED_ERROR_CODES`).
  provider_denied: 'auth.oidcErrors.accessDenied',
  restart: 'auth.oidcErrors.expired',
  provider_error: 'auth.oidcErrors.unavailable',
  provider_unavailable: 'auth.oidcErrors.unavailable',
  reauth_required: 'auth.oidcErrors.reauthRequired',
  restart_required: 'auth.oidcErrors.expired',
  throttled: 'auth.oidcErrors.throttled',
  unavailable: 'auth.oidcErrors.unavailable',
}))

const GENERIC_ERROR_TRANSLATION_KEY = 'auth.oidcErrors.generic'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Return the translation key for an allowlisted `oidc_error` code, or the
 * generic key for anything unrecognised.
 *
 * Only own string properties of the allowlist are accepted. The `in` operator
 * and plain indexing are deliberately avoided because `oidc_error` is raw
 * query content: `constructor`, `__proto__` and `toString` exist on
 * `Object.prototype` and would otherwise leak a non-string value into the
 * translation helper, which expects a dotted path.
 */
export function oidcErrorTranslationKey(code) {
  if (typeof code !== 'string') return GENERIC_ERROR_TRANSLATION_KEY
  if (!Object.prototype.hasOwnProperty.call(OIDC_ERROR_TRANSLATION_KEYS, code)) {
    return GENERIC_ERROR_TRANSLATION_KEY
  }
  const key = OIDC_ERROR_TRANSLATION_KEYS[code]
  return typeof key === 'string' ? key : GENERIC_ERROR_TRANSLATION_KEY
}

/**
 * Fill the `{provider}` placeholder without letting the provider name act as a
 * replacement pattern. The replacement string in `String#replace` treats `$`
 * sequences specially, so a provider display name containing them would
 * corrupt the label; splitting on the token avoids that entirely.
 */
export function formatProviderLabel(label, provider) {
  const template = typeof label === 'string' ? label : ''
  const name = typeof provider === 'string' ? provider : ''
  return template.split('{provider}').join(name)
}

/**
 * Read `oidc_error` from a query string or URLSearchParams. Returns null when
 * the parameter is absent, otherwise the raw (still untrusted) code. The UI
 * must pass it through `oidcErrorTranslationKey` before rendering anything.
 */
export function readOidcError(search) {
  let params
  try {
    params = typeof search === 'string' ? new URLSearchParams(search) : search
  } catch {
    return null
  }
  const code = params?.get?.('oidc_error')
  return code ? code : null
}

/**
 * Convert a `GET /api/auth/oidc/identity` payload into a small safe view.
 * Only documented capability fields are exposed; issuer, subject and token
 * material are never copied into component state.
 */
export function parseOidcIdentity(payload) {
  if (!isPlainObject(payload) || typeof payload.linked !== 'boolean') return null

  const displayName = [
    payload.display_name,
    payload.oidc_display_name,
    payload.issuer_display_name,
  ].find(value => typeof value === 'string' && value.trim() !== '')

  const unlinkPermitted = [
    payload.unlink_permitted,
    payload.can_unlink,
    payload.unlink_allowed,
  ].find(value => typeof value === 'boolean')

  return {
    linked: payload.linked,
    displayName: displayName || '',
    unlinkPermitted: unlinkPermitted === true,
  }
}

/**
 * Validate an `authorization_url` before navigating. Only absolute HTTP(S)
 * URLs without embedded credentials are accepted, so a malformed or hostile
 * response cannot redirect the browser to another scheme.
 */
export function safeAuthorizationUrl(payload) {
  if (!isPlainObject(payload) || typeof payload.authorization_url !== 'string') return null
  try {
    const url = new URL(payload.authorization_url)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Discriminate the completion response exactly as the API contract defines it:
 * a TokenResponse, `{linked:true}`, or `{username_required:true}`. Ambiguous
 * combinations are rejected rather than guessed at.
 */
export function parseOidcCompletion(payload) {
  if (!isPlainObject(payload)) throw new Error('Unexpected sign-in response')

  if (Object.prototype.hasOwnProperty.call(payload, 'username_required')) {
    if (payload.username_required === true && Object.keys(payload).length === 1) {
      return { kind: 'username_required' }
    }
    throw new Error('Unexpected sign-in response')
  }

  const hasToken = typeof payload.access_token === 'string' && payload.access_token.trim() !== ''
  const hasLinkedFlag = Object.prototype.hasOwnProperty.call(payload, 'linked')
  const isLinked = payload.linked === true

  if (hasLinkedFlag) {
    if (isLinked && !hasToken && Object.keys(payload).length === 1) {
      return { kind: 'linked' }
    }
    throw new Error('Unexpected sign-in response')
  }

  const user = payload.user
  const hasUser = isPlainObject(user)
    && (typeof user.id === 'number' || typeof user.id === 'string')
    && typeof user.username === 'string'

  if (hasToken && hasUser) {
    return { kind: 'login', accessToken: payload.access_token, user }
  }

  throw new Error('Unexpected sign-in response')
}

// Only these two status/code pairs preserve the pending handoff for correction.
// Never render server detail strings or infer retryability from the status alone.
export function oidcUsernameErrorTranslationKey(error) {
  const status = error?.response?.status
  const code = error?.response?.data?.code
  if (status === 400 && code === 'invalid_username') return 'auth.oidcUsernameInvalid'
  if (status === 409 && code === 'username_taken') return 'auth.oidcUsernameTaken'
  return null
}

/**
 * Run a completion request and apply a token response only.
 *
 * The initial request is empty; a prompted fallback sends only `username`.
 * Linking and name prompts keep the current session and token untouched.
 */
export async function runOidcCompletion({ request, loginUser, username }) {
  const payload = await (username === undefined ? request() : request({ username }))
  const result = parseOidcCompletion(payload)

  if (result.kind === 'login') {
    loginUser(result.accessToken, result.user)
  }

  return result
}
