import { describe, it, expect, vi } from 'vitest'
import { createHoloDeviceMotion } from './holoDeviceMotion'

function setup(requestPermission) {
  const win = new EventTarget(), doc = new EventTarget()
  win.isSecureContext = true
  win.DeviceOrientationEvent = requestPermission ? { requestPermission } : {}
  win.matchMedia = () => ({ matches: true })
  win.screen = { orientation: { angle: 0 } }
  doc.hidden = false
  const service = createHoloDeviceMotion(win, doc)
  const orient = (beta, gamma) => {
    const event = new Event('deviceorientation')
    Object.assign(event, { beta, gamma }); win.dispatchEvent(event)
  }
  return { win, doc, service, orient }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('automatic native Holo device orientation', () => {
  it('recenters after exactly 1.3 steady seconds, tolerates hand jitter, and resets the window on movement', () => {
    vi.useFakeTimers()
    try {
      const { service, orient } = setup(); const stop = service.start()
      orient(30, 10); orient(45, 25)
      vi.advanceTimersByTime(1299); orient(46.1, 24.5)
      expect(service.get().x).toBeGreaterThan(.6)
      vi.advanceTimersByTime(1)
      expect(service.get()).toEqual({ x: .5, y: .5 })
      orient(60, 40); vi.advanceTimersByTime(1100); orient(65, 45)
      vi.advanceTimersByTime(200); expect(service.get().x).toBeGreaterThan(.6)
      vi.advanceTimersByTime(1100); expect(service.get()).toEqual({ x: .5, y: .5 })
      orient(80, 60); stop(); vi.advanceTimersByTime(2200)
      expect(service.get()).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('preserves original motion sensitivity while using forgiving stillness detection', () => {
    const { service, orient } = setup()
    const stop = service.start()
    orient(null, null); expect(service.get()).toBeNull()
    orient(40, 10); expect(service.get()).toEqual({ x: .5, y: .5 })
    orient(55, 25); expect(service.get()).toEqual({ x: .75, y: .75 })
    orient(100, 90); expect(service.get()).toEqual({ x: 1, y: 1 })
    stop(); expect(service.get()).toBeNull()
    const again = service.start(); orient(55, 25)
    expect(service.get()).toEqual({ x: .75, y: .75 }); again()
    const reloaded = setup(); reloaded.service.start(); reloaded.orient(55, 25)
    expect(reloaded.service.get()).toEqual({ x: .5, y: .5 })
  })
  it('uses an existing native permission automatically without a gesture', async () => {
    const request = vi.fn().mockResolvedValue('granted')
    const { service, orient } = setup(request); const stop = service.start()
    await flush(); orient(20, 10)
    expect(request).toHaveBeenCalledTimes(1); expect(service.get()).not.toBeNull(); stop()
  })
  it('defers only a gesture-required native prompt to the first normal tap and does not repeat it', async () => {
    const error = Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' })
    const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('granted')
    const { service, doc, orient } = setup(request); const stop = service.start()
    await flush(); doc.dispatchEvent(new Event('pointerup')); await flush()
    doc.dispatchEvent(new Event('pointerup')); orient(20, 10)
    expect(request).toHaveBeenCalledTimes(2); expect(service.get()).not.toBeNull(); stop()
  })
  it('respects native denial and never retries on later taps', async () => {
    const request = vi.fn().mockResolvedValue('denied')
    const { service, doc, orient } = setup(request); const stop = service.start()
    await flush(); doc.dispatchEvent(new Event('pointerup')); orient(20, 10)
    expect(request).toHaveBeenCalledTimes(1); expect(service.get()).toBeNull(); stop()
  })
  it('does not attach a late granted sensor after disposal', async () => {
    let resolve
    const request = vi.fn(() => new Promise(r => { resolve = r }))
    const { service, orient } = setup(request); const stop = service.start(); stop()
    resolve('granted'); await flush(); orient(20, 10); expect(service.get()).toBeNull()
  })
  it('clears active readings when hidden without changing the reload calibration', () => {
    const { service, doc, orient } = setup(); const stop = service.start()
    orient(30, 10); doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'))
    orient(50, 20); expect(service.get()).toBeNull()
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); orient(30, 10)
    expect(service.get()).toEqual({ x: .5, y: .5 }); stop()
  })
})
