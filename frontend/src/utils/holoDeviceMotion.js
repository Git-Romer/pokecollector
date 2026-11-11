// One permission flow and calibrated orientation stream per page, shared by all
// card surfaces. Browser permission is authoritative; no permission flag or raw
// sensor readings are persisted or sent to the server.
export function createHoloDeviceMotion(win, doc) {
  let users = 0, permission = 'unknown', pending = false, listening = false
  let baseline = null, sample = null
  let holdAnchor = null, latest = null, holdTimer = null
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; holdAnchor = null }
  const trackHold = reading => {
    latest = reading
    // Compare with the start of the entire hold, not just the previous event:
    // slow continuous drift must not be mistaken for a steady hand.
    if (holdAnchor && Math.hypot(delta(reading.beta, holdAnchor.beta), delta(reading.gamma, holdAnchor.gamma)) <= 1.5) return
    cancelHold()
    holdAnchor = reading
    holdTimer = setTimeout(() => {
      holdTimer = null
      if (!users || doc.hidden) return
      baseline = { ...latest }
      publish({ x: .5, y: .5 })
    }, 1300)
  }
  const subscribers = new Set()
  const publish = value => { sample = value; for (const fn of subscribers) fn(value) }
  const clamp = value => Math.max(0, Math.min(1, value))
  const delta = (value, start) => ((value - start + 540) % 360) - 180
  const orientation = event => {
    if (!users || doc.hidden || !Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return
    if (!baseline) baseline = { beta: event.beta, gamma: event.gamma }
    trackHold({ beta: event.beta, gamma: event.gamma })
    const beta = delta(event.beta, baseline.beta), gamma = delta(event.gamma, baseline.gamma)
    const angle = (win.screen?.orientation?.angle ?? win.orientation ?? 0) * Math.PI / 180
    const x = gamma * Math.cos(angle) + beta * Math.sin(angle)
    const y = beta * Math.cos(angle) - gamma * Math.sin(angle)
    publish({ x: clamp(.5 + (Math.abs(x) < .5 ? 0 : x) / 60), y: clamp(.5 + (Math.abs(y) < .5 ? 0 : y) / 60) })
  }
  const listen = () => {
    if (!users || listening) return
    win.addEventListener('deviceorientation', orientation)
    listening = true
  }
  const removeGesture = () => {
    doc.removeEventListener('pointerup', gesture, true)
    doc.removeEventListener('keydown', gesture, true)
  }
  const armGesture = () => {
    if (!users) return
    doc.addEventListener('pointerup', gesture, { capture: true, once: true })
    doc.addEventListener('keydown', gesture, { capture: true, once: true })
  }
  const request = (fromGesture = false) => {
    if (!users || doc.hidden || pending) return
    if (permission === 'granted') { listen(); return }
    if (permission === 'denied' || permission === 'unavailable') return
    const nativeRequest = win.DeviceOrientationEvent?.requestPermission
    if (typeof nativeRequest !== 'function') { permission = 'granted'; listen(); return }
    pending = true
    // Call synchronously inside the real gesture when activation is required.
    let result
    try { result = nativeRequest.call(win.DeviceOrientationEvent) }
    catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(value => {
      permission = value === 'granted' ? 'granted' : 'denied'
      removeGesture()
      if (permission === 'granted') listen()
    }, error => {
      permission = error?.name === 'NotAllowedError' && !fromGesture ? 'gesture' : 'unavailable'
      if (permission === 'gesture') armGesture()
    }).finally(() => { pending = false })
  }
  function gesture() {
    removeGesture()
    request(true)
  }
  const visibility = () => {
    if (doc.hidden) { cancelHold(); publish(null) }
    else if (permission === 'gesture') armGesture()
    else request()
  }
  return {
    get: () => sample,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
    start() {
      if (!win?.isSecureContext || !win.DeviceOrientationEvent ||
        !(win.matchMedia?.('(pointer: coarse)').matches || win.navigator?.maxTouchPoints > 0)) return () => {}
      users += 1
      if (users === 1) {
        doc.addEventListener('visibilitychange', visibility)
        if (permission === 'gesture') armGesture()
        else request()
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        users -= 1
        if (!users) {
          cancelHold(); removeGesture(); doc.removeEventListener('visibilitychange', visibility)
          win.removeEventListener('deviceorientation', orientation); listening = false
          publish(null)
          // Preserve the current neutral angle across route remounts; the
          // next steady 1.3-second hold can recalibrate without a reload.
        }
      }
    },
  }
}
export const holoDeviceMotion = typeof window === 'undefined' ? null : createHoloDeviceMotion(window, document)
