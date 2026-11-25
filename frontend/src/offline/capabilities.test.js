import { describe, expect, it } from 'vitest'
import { getCapabilities, isStandalone, pushSupported } from './capabilities.js'

describe('capabilities', () => {
  it('detects nothing in an empty environment', () => {
    expect(getCapabilities(undefined)).toEqual({
      secureContext: false, serviceWorker: false, indexedDB: false, storageManager: false, standalone: false, push: false,
    })
  })

  it('detects features by presence', () => {
    const win = {
      isSecureContext: true,
      indexedDB: {},
      PushManager: function PushManager() {},
      Notification: function Notification() {},
      navigator: { serviceWorker: {}, storage: { persist() {} }, standalone: true },
    }
    expect(getCapabilities(win)).toEqual({
      secureContext: true, serviceWorker: true, indexedDB: true, storageManager: true, standalone: true, push: true,
    })
    expect(pushSupported({ ...win, isSecureContext: false })).toBe(false)
  })

  it('reads display-mode standalone', () => {
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) })).toBe(true)
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) })).toBe(false)
    expect(isStandalone({ navigator: {}, matchMedia: () => { throw new Error('x') } })).toBe(false)
  })
})
