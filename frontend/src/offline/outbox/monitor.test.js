import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReachability } from './probe.js'
import { createReachabilityMonitor } from './monitor.js'

const OK = { state: 'reachable', serverInfo: {} }
const DOWN = { state: 'unreachable' }

function setup({ results, enabled = true, replayRunning = false } = {}) {
  const queue = [...results]
  const probe = vi.fn(async () => queue.length > 1 ? queue.shift() : queue[0])
  const onlineManager = { setOnline: vi.fn() }
  const reachability = createReachability({ onlineManager, isOnLine: () => true })
  const target = new EventTarget()
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  let fail = () => {}
  const notify = vi.fn()
  const monitor = createReachabilityMonitor({
    reachability,
    probe,
    isEnabled: () => enabled,
    isReplayRunning: () => replayRunning,
    notify,
    target,
    doc,
    subscribeFailures: cb => { fail = cb; return () => {} },
    now: () => Date.now(),
    failureGapMs: 0,
  })
  return { monitor, probe, reachability, onlineManager, target, doc, notify, failRequest: () => fail(), results: queue }
}

describe('reachability monitor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the banner after the second failed probe with an empty queue, then clears on recovery', async () => {
    const h = setup({ results: [DOWN, DOWN, OK] })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.probe).toHaveBeenCalledTimes(1)
    expect(h.reachability.snapshot().bannerVisible).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(h.reachability.snapshot().bannerVisible).toBe(true)
    expect(h.onlineManager.setOnline).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(15000)
    expect(h.probe).toHaveBeenCalledTimes(3)
    expect(h.reachability.snapshot().bannerVisible).toBe(false)
    expect(h.onlineManager.setOnline).toHaveBeenLastCalledWith(true)
    expect(h.notify).toHaveBeenCalled()
    h.monitor.stop()
  })

  it('does not poll while reachable', async () => {
    const h = setup({ results: [OK] })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(120000)
    expect(h.probe).toHaveBeenCalledTimes(1)
    h.monitor.stop()
  })

  it('probes again on online, focus, pageshow, visible and on a failed request', async () => {
    const h = setup({ results: [OK] })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    for (const fire of [
      () => h.target.dispatchEvent(new Event('online')),
      () => h.target.dispatchEvent(new Event('offline')),
      () => h.target.dispatchEvent(new Event('focus')),
      () => h.target.dispatchEvent(new Event('pageshow')),
      () => h.doc.dispatchEvent(new Event('visibilitychange')),
      () => h.failRequest(),
    ]) {
      const before = h.probe.mock.calls.length
      fire()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.probe.mock.calls.length).toBe(before + 1)
    }
    h.doc.visibilityState = 'hidden'
    const before = h.probe.mock.calls.length
    h.doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.probe.mock.calls.length).toBe(before)
    h.monitor.stop()
  })

  it('never overlaps probes (deduplicates an in-flight one)', async () => {
    const h = setup({ results: [OK] })
    let release
    h.probe.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(OK) }))
    h.monitor.start()
    h.target.dispatchEvent(new Event('focus'))
    h.target.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.probe).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.stop()
  })

  it('waits while the replay engine is running', async () => {
    const h = setup({ results: [OK], replayRunning: true })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.probe).not.toHaveBeenCalled()
    h.monitor.stop()
  })

  it('wrapped replay probes run one at a time', async () => {
    const h = setup({ results: [OK] })
    const order = []
    let release
    const slow = h.monitor.wrapProbe(() => new Promise(resolve => { order.push('a'); release = () => resolve(OK) }))
    const fast = h.monitor.wrapProbe(async () => { order.push('b'); return OK })
    slow(); fast()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['a'])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['a', 'b'])
  })

  it('does nothing when the queue is disabled', async () => {
    const h = setup({ results: [DOWN], enabled: false })
    h.monitor.start()
    h.target.dispatchEvent(new Event('focus'))
    h.failRequest()
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.reachability.snapshot().bannerVisible).toBe(false)
  })

  it('assumeUnreachable shows the banner at once and a reachable probe clears it', async () => {
    const h = setup({ results: [OK] })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reachability.snapshot().bannerVisible).toBe(false)
    const down = setup({ results: [DOWN] })
    down.monitor.start()
    down.monitor.assumeUnreachable()
    expect(down.reachability.snapshot().bannerVisible).toBe(true)
    h.reachability.record(DOWN)
    h.monitor.assumeUnreachable()
    expect(h.reachability.snapshot().bannerVisible).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reachability.snapshot().bannerVisible).toBe(false)
    h.monitor.stop()
    down.monitor.stop()
  })

  it('stop() ends probing', async () => {
    const h = setup({ results: [DOWN] })
    h.monitor.start()
    await vi.advanceTimersByTimeAsync(0)
    h.monitor.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.probe).toHaveBeenCalledTimes(1)
  })
})
