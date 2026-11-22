import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.fn(() => Promise.resolve({ data: { username_required: true } }))

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post,
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}))

const { completeOidcLogin } = await import('./client')

describe('completeOidcLogin', () => {
  beforeEach(() => post.mockClear())

  it('initially posts an empty body and preserves an existing session on failure', async () => {
    await expect(completeOidcLogin()).resolves.toEqual({ username_required: true })
    expect(post).toHaveBeenCalledExactlyOnceWith('/auth/oidc/complete', {}, {
      preserveSessionOnUnauthorized: true,
    })
  })

  it('submits the fallback username only, with no URL or identity parameters', async () => {
    await completeOidcLogin({ username: 'Demo Collector' })
    expect(post).toHaveBeenCalledExactlyOnceWith('/auth/oidc/complete', { username: 'Demo Collector' }, {
      preserveSessionOnUnauthorized: true,
    })
  })
})
