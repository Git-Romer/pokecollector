// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  getVapidPublicKey: vi.fn(async () => ({ public_key: 'BAAB' })),
  subscribePush: vi.fn(async () => ({ id: 1 })),
  unsubscribePush: vi.fn(async () => undefined),
}))

const api = await import('../api/client')
const { disablePush, enablePush, getCurrentSubscription, isIosBrowserTab, pushSupported } = await import('./push')

function stubBrowser({ secure = true, standalone, permission = 'granted', existing = null, push = true } = {}) {
  const subscription = {
    endpoint: 'https://web.push.apple.com/x',
    toJSON: () => ({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  }
  const pushManager = {
    getSubscription: vi.fn(async () => existing && subscription),
    subscribe: vi.fn(async () => subscription),
  }
  const win = { isSecureContext: secure, Notification: {}, PushManager: {} }
  if (!push) delete win.PushManager
  vi.stubGlobal('window', win)
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn(async () => permission) })
  win.Notification = globalThis.Notification
  vi.stubGlobal('navigator', {
    userAgent: 'UA',
    standalone,
    serviceWorker: { ready: Promise.resolve({ pushManager }) },
  })
  return { pushManager, subscription }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('pushSupported', () => {
  it('needs a secure context, PushManager and Notification', () => {
    stubBrowser()
    expect(pushSupported()).toBe(true)
    stubBrowser({ secure: false })
    expect(pushSupported()).toBe(false)
    stubBrowser({ push: false })
    expect(pushSupported()).toBe(false)
  })

  it('detects an iPhone Safari tab only over HTTPS', () => {
    stubBrowser({ push: false, standalone: false })
    expect(isIosBrowserTab()).toBe(true)
    stubBrowser({ push: false, standalone: false, secure: false })
    expect(isIosBrowserTab()).toBe(false)
    stubBrowser({ standalone: undefined })
    expect(isIosBrowserTab()).toBe(false)
  })
})

describe('enablePush', () => {
  it('returns a failure when the browser push service never completes subscription', async () => {
    vi.useFakeTimers()
    const { pushManager } = stubBrowser()
    pushManager.subscribe.mockImplementation(() => new Promise(() => {}))
    const attempt = enablePush()
    await vi.advanceTimersByTimeAsync(30000)
    expect(await Promise.race([attempt, Promise.resolve('not bounded')])).toEqual({ ok: false, reason: 'failed' })
    expect(api.subscribePush).not.toHaveBeenCalled()
  })
  it('subscribes with the server key and registers the subscription', async () => {
    const { pushManager } = stubBrowser()
    expect(await enablePush()).toEqual({ ok: true })
    const options = pushManager.subscribe.mock.calls[0][0]
    expect(options.userVisibleOnly).toBe(true)
    expect([...options.applicationServerKey]).toEqual([4, 0, 1])
    expect(api.subscribePush).toHaveBeenCalledWith({
      endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' }, user_agent: 'UA',
    })
  })

  it('reuses an existing browser subscription and does not fetch the key again', async () => {
    const { pushManager } = stubBrowser({ existing: true })
    expect(await enablePush()).toEqual({ ok: true })
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(api.getVapidPublicKey).not.toHaveBeenCalled()
    expect(api.subscribePush).toHaveBeenCalledTimes(1)
  })

  it('stops when permission is not granted', async () => {
    const { pushManager } = stubBrowser({ permission: 'denied' })
    expect(await enablePush()).toEqual({ ok: false, reason: 'denied' })
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(api.subscribePush).not.toHaveBeenCalled()
  })

  it('reports failures instead of throwing', async () => {
    stubBrowser()
    api.subscribePush.mockRejectedValueOnce(new Error('500'))
    expect(await enablePush()).toEqual({ ok: false, reason: 'failed' })
  })

  it('is unsupported without push', async () => {
    stubBrowser({ push: false })
    expect(await enablePush()).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('disablePush', () => {
  it('removes the server row, then unsubscribes the browser', async () => {
    const { subscription } = stubBrowser({ existing: true })
    expect(await disablePush()).toEqual({ ok: true })
    expect(api.unsubscribePush).toHaveBeenCalledWith('https://web.push.apple.com/x')
    expect(subscription.unsubscribe).toHaveBeenCalled()
  })

  it('succeeds when there is nothing to remove', async () => {
    stubBrowser()
    expect(await disablePush()).toEqual({ ok: true })
    expect(await getCurrentSubscription()).toBeNull()
  })
})
