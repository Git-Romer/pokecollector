const MAX_RETRY_DELAY_MS = 10_000

export function authRetryDelay(attempt) {
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 0
  return Math.min(1_000 * (2 ** safeAttempt), MAX_RETRY_DELAY_MS)
}

export function isUnauthorized(error) {
  return error?.response?.status === 401
}

export async function loadAuthState({ token, getAuthMode, getMe }) {
  const { multi_user: multiUser, locked } = await getAuthMode()

  if (typeof multiUser !== 'boolean') {
    throw new Error('Invalid authentication mode response')
  }

  if (multiUser && !token) {
    return {
      user: null,
      multiUser: true,
      modeLocked: Boolean(locked),
      clearSession: false,
      clearToken: false,
    }
  }

  try {
    const user = await getMe({
      // Single-user mode must always resolve the automatic admin, regardless
      // of any token left in the browser from an earlier multi-user session.
      withoutToken: !multiUser,
      // Bootstrap decides whether a 401 is an expired session. The shared
      // interceptor must not redirect or clear storage before that decision.
      preserveSession: true,
    })
    return {
      user,
      multiUser: Boolean(multiUser),
      modeLocked: Boolean(locked),
      clearSession: false,
      // Once single-user mode is confirmed, a token from an earlier
      // multi-user session must not leak into the rest of the app's requests.
      clearToken: !multiUser && Boolean(token),
    }
  } catch (error) {
    // An expired token is a resolved multi-user state, not a connectivity
    // problem. Network and server failures must bubble up so the caller can
    // retry without destroying an otherwise valid session.
    if (multiUser && token && isUnauthorized(error)) {
      return {
        user: null,
        multiUser: true,
        modeLocked: Boolean(locked),
        clearSession: true,
        clearToken: true,
      }
    }
    throw error
  }
}
