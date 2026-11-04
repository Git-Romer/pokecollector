import { describe, expect, it, vi } from 'vitest'
import {
  formatProviderLabel,
  oidcErrorTranslationKey,
  parseOidcCompletion,
  parseOidcIdentity,
  readOidcError,
  runOidcCompletion,
  safeAuthorizationUrl,
} from './oidcAuth'

const user = { id: 7, username: 'misty', role: 'trainer' }

describe('formatProviderLabel', () => {
  it('substitutes the provider name into the label', () => {
    expect(formatProviderLabel('Sign in with {provider}', 'Authelia')).toBe('Sign in with Authelia')
  })

  it('treats replacement patterns in the provider name literally', () => {
    expect(formatProviderLabel('Sign in with {provider}', "$& $1 $` $'"))
      .toBe("Sign in with $& $1 $` $'")
  })

  it('leaves a label without the placeholder unchanged', () => {
    expect(formatProviderLabel('Sign in with single sign-on', 'Authelia'))
      .toBe('Sign in with single sign-on')
  })

  it('handles missing values without throwing', () => {
    expect(formatProviderLabel(undefined, 'Authelia')).toBe('')
    expect(formatProviderLabel('Sign in with {provider}', null)).toBe('Sign in with ')
  })
})

describe('oidc_error handling', () => {
  it('is absent when the query has no OIDC error', () => {
    expect(readOidcError('')).toBeNull()
    expect(readOidcError('code=secret&state=abc')).toBeNull()
  })

  it('returns the raw code and maps only allowlisted codes to specific messages', () => {
    expect(readOidcError('?oidc_error=access_denied&code=secret')).toBe('access_denied')
    expect(readOidcError(new URLSearchParams('oidc_error=expired'))).toBe('expired')
    expect(oidcErrorTranslationKey('access_denied')).toBe('auth.oidcErrors.accessDenied')
    expect(oidcErrorTranslationKey('expired')).toBe('auth.oidcErrors.expired')
  })

  it('maps every code the backend can actually emit', () => {
    // Mirrors _OIDC_ALLOWED_ERROR_CODES in backend/api/auth.py: a code the
    // backend sends must never fall through to the generic message.
    expect(oidcErrorTranslationKey('provider_denied')).toBe('auth.oidcErrors.accessDenied')
    expect(oidcErrorTranslationKey('restart')).toBe('auth.oidcErrors.expired')
    expect(oidcErrorTranslationKey('reauth_required')).toBe('auth.oidcErrors.reauthRequired')
    expect(oidcErrorTranslationKey('invalid_state')).toBe('auth.oidcErrors.expired')
    expect(oidcErrorTranslationKey('invalid_request')).toBe('auth.oidcErrors.expired')
    expect(oidcErrorTranslationKey('provider_unavailable')).toBe('auth.oidcErrors.unavailable')
    expect(oidcErrorTranslationKey('provider_error')).toBe('auth.oidcErrors.unavailable')
  })

  it('maps unknown codes to the generic message instead of echoing provider text', () => {
    expect(readOidcError('?oidc_error=<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
    expect(oidcErrorTranslationKey('<script>alert(1)</script>')).toBe('auth.oidcErrors.generic')
    expect(oidcErrorTranslationKey(undefined)).toBe('auth.oidcErrors.generic')
  })

  // `oidc_error` is raw query content. These three names exist on
  // `Object.prototype`; indexing a plain object literal returns the inherited
  // function/object, and the translation helper then calls `.split` on it and
  // throws. The generic string key must come back instead.
  it.each(['constructor', '__proto__', 'toString'])(
    'returns the generic string key for the prototype member %j',
    code => {
      const key = oidcErrorTranslationKey(code)
      expect(key).toBe('auth.oidcErrors.generic')
      expect(typeof key).toBe('string')
    },
  )

  it('always returns a plain dotted string key for any string input', () => {
    const inputs = [
      ...['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'],
      ...['access_denied', 'expired', 'throttled', 'reauth_required', 'unavailable'],
      '', 'unknown', 'ACCESS_DENIED', ' access_denied',
    ]
    for (const code of inputs) {
      const key = oidcErrorTranslationKey(code)
      expect(typeof key).toBe('string')
      expect(key.startsWith('auth.oidcErrors.')).toBe(true)
    }
  })
})

describe('parseOidcCompletion', () => {
  it('accepts an existing TokenResponse as a login result', () => {
    expect(parseOidcCompletion({ access_token: 'app-token', token_type: 'bearer', user })).toEqual({
      kind: 'login',
      accessToken: 'app-token',
      user,
    })
  })

  it('accepts the linking result without a token', () => {
    expect(parseOidcCompletion({ linked: true })).toEqual({ kind: 'linked' })
  })

  it.each([
    null,
    undefined,
    [],
    'linked',
    {},
    { access_token: '' },
    { access_token: 'token' },
    { access_token: 'token', user: {} },
    { access_token: 'token', user: { id: 1 } },
    { access_token: 'token', user: { username: 'x' } },
    { linked: false },
    { linked: 'true' },
    { linked: true, access_token: 'token', user },
    { linked: true, provider: 'extra' },
  ])('rejects any other response shape: %j', payload => {
    expect(() => parseOidcCompletion(payload)).toThrow('Unexpected sign-in response')
  })
})

describe('runOidcCompletion', () => {
  it('posts through the request seam and calls loginUser only for a login response', async () => {
    const request = vi.fn().mockResolvedValue({ access_token: 'app-token', user })
    const loginUser = vi.fn()

    await expect(runOidcCompletion({ request, loginUser })).resolves.toMatchObject({ kind: 'login' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(loginUser).toHaveBeenCalledTimes(1)
    expect(loginUser).toHaveBeenCalledWith('app-token', user)
  })

  it('does not replace the session for a linked response', async () => {
    const request = vi.fn().mockResolvedValue({ linked: true })
    const loginUser = vi.fn()

    await expect(runOidcCompletion({ request, loginUser })).resolves.toEqual({ kind: 'linked' })
    expect(loginUser).not.toHaveBeenCalled()
  })

  it('propagates a failed completion without calling loginUser', async () => {
    const error = { response: { status: 401 } }
    const loginUser = vi.fn()

    await expect(runOidcCompletion({
      request: vi.fn().mockRejectedValue(error),
      loginUser,
    })).rejects.toBe(error)
    expect(loginUser).not.toHaveBeenCalled()
  })
})

describe('parseOidcIdentity', () => {
  it('exposes only safe capability fields', () => {
    expect(parseOidcIdentity({
      linked: true,
      display_name: 'Company SSO',
      unlink_permitted: true,
      issuer: 'https://issuer.example.test',
      subject: 'raw-subject',
      access_token: 'provider-token',
    })).toEqual({
      linked: true,
      displayName: 'Company SSO',
      unlinkPermitted: true,
    })
  })

  it('accepts the documented aliases and defaults to no unlink permission', () => {
    expect(parseOidcIdentity({
      linked: false,
      oidc_display_name: 'Authelia',
      can_unlink: false,
    })).toEqual({
      linked: false,
      displayName: 'Authelia',
      unlinkPermitted: false,
    })
  })

  it.each([
    null,
    {},
    { linked: 'true' },
  ])('is unavailable for an invalid identity payload: %j', payload => {
    expect(parseOidcIdentity(payload)).toBeNull()
  })

  it('ignores a non-string display name without exposing other fields', () => {
    expect(parseOidcIdentity({ linked: true, display_name: 5 })).toEqual({
      linked: true,
      displayName: '',
      unlinkPermitted: false,
    })
  })
})

describe('safeAuthorizationUrl', () => {
  it('accepts an absolute HTTP(S) provider URL', () => {
    expect(safeAuthorizationUrl({
      authorization_url: 'https://idp.example.test/authorize?state=abc',
    })).toBe('https://idp.example.test/authorize?state=abc')
    expect(safeAuthorizationUrl({
      authorization_url: 'http://127.0.0.1:9091/authorize',
    })).toBe('http://127.0.0.1:9091/authorize')
  })

  it.each([
    null,
    {},
    { authorization_url: '' },
    { authorization_url: '/relative' },
    { authorization_url: 'javascript:alert(1)' },
    { authorization_url: 'data:text/html,hello' },
    { authorization_url: 'https://user:pass@idp.example.test/authorize' },
    { authorization_url: 'not a url' },
  ])('rejects an unsafe or malformed URL: %j', payload => {
    expect(safeAuthorizationUrl(payload)).toBeNull()
  })
})
