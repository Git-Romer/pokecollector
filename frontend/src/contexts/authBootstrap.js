const MAX_RETRY_DELAY_MS = 10_000

// iOS keeps requests pending while offline instead of failing them, so the
// startup check must give up on its own. A timeout is a network error (no
// response), never a 401, so it takes the existing degraded/offline path.
export const AUTH_STARTUP_TIMEOUT_MS = 5_000

const KNOWN_AUTH_MODES = new Set(['local', 'mixed', 'oidc-only'])

export function authRetryDelay(attempt) {
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 0
  return Math.min(1_000 * (2 ** safeAttempt), MAX_RETRY_DELAY_MS)
}

export function isUnauthorized(error) {
  return error?.response?.status === 401
}

/**
 * Normalise `GET /api/auth/mode` into UI capabilities.
 *
 * The original deployment only returned `multi_user` and `locked`. When the new
 * capability fields are absent, keep that legacy behaviour: password login is
 * available and no SSO button is shown. Fields that are present but malformed
 * fail bootstrap rather than silently falling back to a weaker login surface.
 */
export function normalizeAuthCapabilities(mode) {
  const multiUser = mode?.multi_user
  if (typeof multiUser !== 'boolean') {
    throw new Error('Invalid authentication mode response')
  }

  let authMode = 'local'
  if (mode.auth_mode !== undefined) {
    if (!KNOWN_AUTH_MODES.has(mode.auth_mode)) {
      throw new Error('Invalid authentication mode response')
    }
    authMode = mode.auth_mode
  }

  let passwordLoginEnabled = authMode !== 'oidc-only'
  if (mode.password_login_enabled !== undefined) {
    if (typeof mode.password_login_enabled !== 'boolean') {
      throw new Error('Invalid authentication mode response')
    }
    passwordLoginEnabled = mode.password_login_enabled
  }

  let oidcEnabled = authMode === 'mixed' || authMode === 'oidc-only'
  if (mode.oidc_enabled !== undefined) {
    if (typeof mode.oidc_enabled !== 'boolean') {
      throw new Error('Invalid authentication mode response')
    }
    oidcEnabled = mode.oidc_enabled
  }

  let oidcDisplayName = ''
  if (mode.oidc_display_name !== undefined && mode.oidc_display_name !== null) {
    if (typeof mode.oidc_display_name !== 'string') {
      throw new Error('Invalid authentication mode response')
    }
    oidcDisplayName = mode.oidc_display_name.trim()
  }

  return {
    multiUser,
    modeLocked: Boolean(mode.locked),
    authMode,
    passwordLoginEnabled,
    oidcEnabled,
    oidcDisplayName,
  }
}

export async function loadAuthState({ token, getAuthMode, getMe }) {
  const capabilities = normalizeAuthCapabilities(
    await getAuthMode({ timeout: AUTH_STARTUP_TIMEOUT_MS }),
  )

  if (capabilities.multiUser && !token) {
    return {
      user: null,
      ...capabilities,
      clearSession: false,
      clearToken: false,
    }
  }

  try {
    const user = await getMe({
      // Single-user mode must always resolve the automatic admin, regardless
      // of any token left in the browser from an earlier multi-user session.
      withoutToken: !capabilities.multiUser,
      // Bootstrap decides whether a 401 is an expired session. The shared
      // interceptor must not redirect or clear storage before that decision.
      preserveSession: true,
      // Without an explicit budget the client default (30 s) applies and an
      // offline iOS client never reaches the degraded/retry path.
      timeout: AUTH_STARTUP_TIMEOUT_MS,
    })
    return {
      user,
      ...capabilities,
      clearSession: false,
      // Once single-user mode is confirmed, a token from an earlier
      // multi-user session must not leak into the rest of the app's requests.
      clearToken: !capabilities.multiUser && Boolean(token),
    }
  } catch (error) {
    // An expired token is a resolved multi-user state, not a connectivity
    // problem. Network and server failures must bubble up so the caller can
    // retry without destroying an otherwise valid session.
    if (capabilities.multiUser && token && isUnauthorized(error)) {
      return {
        user: null,
        ...capabilities,
        clearSession: true,
        clearToken: true,
      }
    }
    throw error
  }
}
