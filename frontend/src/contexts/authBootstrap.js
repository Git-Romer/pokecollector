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

  if (multiUser && !token) {
    return {
      user: null,
      multiUser: true,
      modeLocked: Boolean(locked),
      clearSession: false,
    }
  }

  try {
    const user = await getMe()
    return {
      user,
      multiUser: Boolean(multiUser),
      modeLocked: Boolean(locked),
      clearSession: false,
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
      }
    }
    throw error
  }
}
