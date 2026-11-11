import { beforeEach, describe, expect, it, vi } from 'vitest'
import HoloDeviceMotionController from './HoloDeviceMotionController'

const state = vi.hoisted(() => ({ settings: {}, effect: null, start: vi.fn(), stop: vi.fn() }))
vi.mock('react', () => ({ useEffect: fn => { state.effect = fn } }))
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => ({ settings: state.settings }) }))
vi.mock('../utils/holoDeviceMotion', () => ({ holoDeviceMotion: { start: state.start } }))

describe('Advanced Holo device-motion opt-in', () => {
  let media
  beforeEach(() => {
    state.settings = {}
    state.effect = null
    state.start.mockReset().mockReturnValue(state.stop)
    state.stop.mockReset()
    media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.stubGlobal('window', { matchMedia: vi.fn(() => media) })
  })

  it.each([undefined, 'false', false, ''])('never starts permission or sensors when disabled (%s)', value => {
    state.settings = { holo_effects_enabled: value }
    HoloDeviceMotionController()
    expect(state.effect()).toBeUndefined()
    expect(state.start).not.toHaveBeenCalled()
    expect(window.matchMedia).not.toHaveBeenCalled()
  })

  it('starts only when enabled and stops on disable/unmount', () => {
    state.settings = { holo_effects_enabled: 'true' }
    HoloDeviceMotionController()
    const cleanup = state.effect()
    expect(state.start).toHaveBeenCalledTimes(1)
    cleanup()
    expect(state.stop).toHaveBeenCalledTimes(1)
    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    state.settings.holo_effects_enabled = 'false'
    HoloDeviceMotionController()
    expect(state.effect()).toBeUndefined()
    expect(state.start).toHaveBeenCalledTimes(1)
  })

  it('does not request motion with reduced motion enabled and responds to preference changes', () => {
    state.settings = { holo_effects_enabled: 'true' }
    media.matches = true
    HoloDeviceMotionController()
    const cleanup = state.effect()
    expect(state.start).not.toHaveBeenCalled()
    const sync = media.addEventListener.mock.calls[0][1]
    media.matches = false
    sync()
    expect(state.start).toHaveBeenCalledTimes(1)
    media.matches = true
    sync()
    expect(state.stop).toHaveBeenCalledTimes(1)
    cleanup()
  })
})
