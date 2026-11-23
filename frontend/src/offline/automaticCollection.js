// One app-wide coordinator. Cached image URLs (including their revision) are the durable
// checkpoint; no progress counter is trusted as proof that a file is still on the device.
export function createAutomaticCollection({
  getManifest, download, clear, setPolicy, onState = () => {},
  isActive = () => true, canRun = () => true,
  withLock = async (_exclusive, work) => work(), retryMs = 30000,
}) {
  let enabled = false
  let stopped = false
  let flight = null
  let controller = null
  let serial = Promise.resolve()
  let generation = 0
  let retry = null
  const publish = state => { if (!stopped && isActive()) onState(state) }
  const cancelRetry = () => { clearTimeout(retry); retry = null }
  const active = () => !stopped && enabled && isActive()
  const schedule = () => {
    cancelRetry()
    if (active()) retry = setTimeout(() => { retry = null; run() }, retryMs)
  }

  function run() {
    if (flight) return flight
    if (!active() || !canRun()) return Promise.resolve()
    cancelRetry()
    const current = new AbortController()
    controller = current
    const check = () => active() && !current.signal.aborted
    flight = Promise.resolve().then(() => withLock(false, async () => {
      if (!check() || !canRun()) return
      publish({ phase: 'downloading' })
      const deadline = setTimeout(() => current.abort(new Error('download_timeout')), 20000)
      let manifest
      try { manifest = await getManifest(current.signal) } finally { clearTimeout(deadline) }
      current.signal.throwIfAborted()
      if (!check()) return
      const result = await download({
        manifest, signal: current.signal, isCurrentUser: check,
        onProgress: progress => { if (check()) publish({ ...progress, phase: 'downloading' }) },
      })
      if (check()) publish({ ...result, phase: 'saved' })
    })).catch(error => {
      if (!active()) return
      const paused = current.signal.aborted && current.signal.reason?.name === 'AbortError'
      publish({ phase: paused ? 'paused' : 'error', error })
      if (!paused) schedule()
    }).finally(() => {
      if (controller === current) controller = null
      flight = null
    })
    return flight
  }

  function configure(value = false) {
    enabled = value
    const version = ++generation
    cancelRetry()
    controller?.abort()
    serial = serial.catch(() => {}).then(async () => {
      await flight
      if (stopped || version !== generation || !isActive()) return
      if (!enabled) {
        publish({ phase: 'clearing' })
        await setPolicy(false)
        await withLock(true, async () => {
          if (stopped || version !== generation || !isActive()) return
          await clear()
        })
        if (!stopped && version === generation && isActive()) publish({ phase: 'disabled' })
      } else {
        await setPolicy(true)
        return run()
      }
    }).catch(error => {
      publish({ phase: enabled ? 'error' : 'cleanupFailed', error })
      cancelRetry()
      if (!stopped && isActive()) retry = setTimeout(() => configure(enabled), retryMs)
    })
    return serial
  }

  return {
    configure, run,
    pause() { cancelRetry(); controller?.abort(); publish({ phase: 'paused' }) },
    stop() {
      stopped = true; ++generation; cancelRetry(); controller?.abort()
      // An IndexedDB/Cache API write already submitted cannot be aborted. Wait for
      // it before logout or Reset deletes data so it cannot recreate a late record.
      return Promise.all([flight, serial])
    },
    busy: () => Boolean(flight),
  }
}
