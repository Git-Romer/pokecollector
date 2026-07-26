import { describe, expect, it } from 'vitest'
import { isPublicSharePath } from './publicRoutes'

describe('isPublicSharePath', () => {
  it('recognizes public profile and binder routes', () => {
    expect(isPublicSharePath('/u/ash')).toBe(true)
    expect(isPublicSharePath('/u/ash/binder/12')).toBe(true)
  })

  it('does not classify protected or login routes as public', () => {
    expect(isPublicSharePath('/login')).toBe(false)
    expect(isPublicSharePath('/settings')).toBe(false)
    expect(isPublicSharePath('/users')).toBe(false)
  })
})
