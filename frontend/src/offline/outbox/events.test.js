import { describe, expect, it, vi } from 'vitest'
import { createEvents, STORAGE_PING_KEY } from './events.js'

describe('outbox events', () => {
  it('delivers messages through a BroadcastChannel', () => {
    const channels = []
    class FakeChannel {
      constructor(name) { this.name = name; this.posted = []; channels.push(this) }
      postMessage(message) { this.posted.push(message) }
      close() { this.closed = true }
    }
    const events = createEvents({ BroadcastChannelImpl: FakeChannel, storage: null, eventTarget: null })
    const cb = vi.fn()
    const off = events.subscribe(cb)
    expect(channels[0].name).toBe('pokecollector-outbox')
    channels[0].onmessage({ data: { type: 'changed' } })
    expect(cb).toHaveBeenCalledWith({ type: 'changed' })
    events.publish({ type: 'changed' })
    expect(channels[0].posted).toEqual([{ type: 'changed' }])
    off()
    channels[0].onmessage({ data: { type: 'changed' } })
    expect(cb).toHaveBeenCalledTimes(1)
    events.close()
    expect(channels[0].closed).toBe(true)
  })

  it('falls back to storage events without BroadcastChannel', () => {
    const handlers = {}
    const eventTarget = {
      addEventListener: (name, fn) => { handlers[name] = fn },
      removeEventListener: name => { delete handlers[name] },
    }
    const written = {}
    const storage = { setItem: (key, value) => { written[key] = value } }
    const events = createEvents({ BroadcastChannelImpl: null, storage, eventTarget })
    const cb = vi.fn()
    events.subscribe(cb)
    events.publish({ type: 'changed' })
    expect(JSON.parse(written[STORAGE_PING_KEY]).message).toEqual({ type: 'changed' })
    handlers.storage({ key: STORAGE_PING_KEY, newValue: written[STORAGE_PING_KEY] })
    expect(cb).toHaveBeenCalledWith({ type: 'changed' })
    handlers.storage({ key: 'other', newValue: 'x' })
    expect(cb).toHaveBeenCalledTimes(1)
    events.close()
    expect(handlers.storage).toBeUndefined()
  })

  it('never throws when nothing is available', () => {
    const events = createEvents({ BroadcastChannelImpl: null, storage: null, eventTarget: null })
    events.subscribe(() => {})
    expect(() => events.publish()).not.toThrow()
  })
})
