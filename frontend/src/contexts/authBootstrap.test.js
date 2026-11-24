import { describe, expect, it, vi } from 'vitest'
import { AUTH_STARTUP_TIMEOUT_MS, authRetryDelay, loadAuthState } from './authBootstrap'

const timeoutError = () => Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' })

describe('loadAuthState', () => {
  it('loads the automatic user in single-user mode', async () => {
    const getMe = vi.fn().mockResolvedValue({ id: 1, username: 'admin' })

    await expect(loadAuthState({
      token: null,
      getAuthMode: vi.fn().mockResolvedValue({ multi_user: false, locked: false }),
      getMe,
    })).resolves.toEqual({
      user: { id: 1, username: 'admin' },
      multiUser: false,
      modeLocked: false,
      clearSession: false,
      clearToken: false,
    })
    expect(getMe).toHaveBeenCalledWith({
      withoutToken: true,
      preserveSession: true,
      timeout: AUTH_STARTUP_TIMEOUT_MS,
    })
  })

  it('gives the startup calls a 5 second timeout', async () => {
    const getAuthMode = vi.fn().mockResolvedValue({ multi_user: true, locked: false })
    const getMe = vi.fn().mockResolvedValue({ id: 2, username: 'misty' })

    await loadAuthState({ token: 'valid-token', getAuthMode, getMe })

    expect(AUTH_STARTUP_TIMEOUT_MS).toBe(5000)
    expect(getAuthMode).toHaveBeenCalledWith({ timeout: 5000 })
    expect(getMe).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5000 }))
  })

  it.each([
    ['mode', { getAuthMode: () => Promise.reject(timeoutError()), getMe: vi.fn() }],
    ['user', {
      getAuthMode: () => Promise.resolve({ multi_user: true, locked: false }),
      getMe: () => Promise.reject(timeoutError()),
    }],
  ])('treats a %s timeout as a retryable network failure, not a 401', async (_name, fns) => {
    // Rejecting (rather than resolving clearSession/clearToken) is what keeps
    // the stored token and auth snapshot intact and sends AuthContext to its
    // degraded/offline branch plus the retry timer.
    await expect(loadAuthState({ token: 'valid-token', ...fns })).rejects.toMatchObject({
      code: 'ECONNABORTED',
    })
  })

  it('resolves multi-user mode without requesting a user when no token exists', async () => {
    const getMe = vi.fn()

    await expect(loadAuthState({
      token: null,
      getAuthMode: vi.fn().mockResolvedValue({ multi_user: true, locked: true }),
      getMe,
    })).resolves.toEqual({
      user: null,
      multiUser: true,
      modeLocked: true,
      clearSession: false,
      clearToken: false,
    })
    expect(getMe).not.toHaveBeenCalled()
  })

  it('clears a leftover token after single-user mode resolves', async () => {
    await expect(loadAuthState({
      token: 'leftover-token',
      getAuthMode: vi.fn().mockResolvedValue({ multi_user: false, locked: false }),
      getMe: vi.fn().mockResolvedValue({ id: 1, username: 'admin' }),
    })).resolves.toMatchObject({
      user: { id: 1, username: 'admin' },
      multiUser: false,
      clearSession: false,
      clearToken: true,
    })
  })

  it('loads the current user when a multi-user token exists', async () => {
    const getMe = vi.fn().mockResolvedValue({ id: 2, username: 'misty' })

    await expect(loadAuthState({
      token: 'valid-token',
      getAuthMode: vi.fn().mockResolvedValue({ multi_user: true, locked: false }),
      getMe,
    })).resolves.toMatchObject({
      user: { id: 2, username: 'misty' },
      multiUser: true,
      clearSession: false,
      clearToken: false,
    })
    expect(getMe).toHaveBeenCalledWith({
      withoutToken: false,
      preserveSession: true,
      timeout: AUTH_STARTUP_TIMEOUT_MS,
    })
  })

  it('treats an expired token as a resolved login state', async () => {
    await expect(loadAuthState({
      token: 'expired-token',
      getAuthMode: vi.fn().mockResolvedValue({ multi_user: true, locked: false }),
      getMe: vi.fn().mockRejectedValue({ response: { status: 401 } }),
    })).resolves.toEqual({
      user: null,
      multiUser: true,
      modeLocked: false,
      clearSession: true,
      clearToken: true,
    })
  })

  it('keeps connectivity failures retryable instead of resolving a login state', async () => {
    const networkError = new Error('Network Error')

    await expect(loadAuthState({
      token: null,
      getAuthMode: vi.fn().mockRejectedValue(networkError),
      getMe: vi.fn(),
    })).rejects.toBe(networkError)

    await expect(loadAuthState({
      token: 'valid-token',
      getAuthMode: vi.fn().mockResolvedValue({ multi_user: true, locked: false }),
      getMe: vi.fn().mockRejectedValue(networkError),
    })).rejects.toBe(networkError)
  })

  it.each([
    {},
    { multi_user: null },
    { multi_user: 'false' },
  ])('rejects an invalid authentication mode response: %j', async mode => {
    const getMe = vi.fn()

    await expect(loadAuthState({
      token: null,
      getAuthMode: vi.fn().mockResolvedValue(mode),
      getMe,
    })).rejects.toThrow('Invalid authentication mode response')
    expect(getMe).not.toHaveBeenCalled()
  })
})

describe('authRetryDelay', () => {
  it('backs off retries and caps the delay', () => {
    expect([0, 1, 2, 3, 4, 10].map(authRetryDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ])
  })
})
