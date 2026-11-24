// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAutomaticCollection } from './automaticCollection'

const fixture = () => {
  const manifest = { version: 1, items: [], image_urls: [] }
  const options = {
    getManifest: vi.fn(async () => manifest),
    download: vi.fn(async () => ({ complete: true, completed: 0, total: 0 })),
    clear: vi.fn(async () => {}), setPolicy: vi.fn(async () => {}),
    isActive: () => true, canRun: () => true, onState: vi.fn(), retryMs: 60000,
  }
  return { options, manifest, controller: createAutomaticCollection(options) }
}

describe('automatic collection downloads', () => {
  it('single-flights overlapping runs and can retry a failed manifest', async () => {
    const { controller, options } = fixture()
    options.getManifest.mockRejectedValueOnce(new Error('offline'))
    await controller.configure(true)
    expect(options.onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }))
    let release
    options.getManifest.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const a = controller.run()
    expect(controller.run()).toBe(a)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release({ items: [], image_urls: [] })
    await a
    expect(options.getManifest).toHaveBeenCalledTimes(2)
    controller.stop()
  })

  it('aborts the current transfer before deleting and never reports a late success', async () => {
    const { controller, options } = fixture()
    const order = []
    options.download.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { order.push('aborted'); reject(signal.reason) }, { once: true })
    }))
    options.clear.mockImplementation(async () => { order.push('cleared') })
    const started = controller.configure(true)
    await vi.waitFor(() => expect(options.download).toHaveBeenCalledTimes(1))
    await controller.configure(false)
    await started
    expect(order).toEqual(['aborted', 'cleared'])
    expect(options.setPolicy).toHaveBeenLastCalledWith(false)
    expect(options.onState).toHaveBeenLastCalledWith({ phase: 'disabled' })
    await controller.run()
    expect(options.download).toHaveBeenCalledTimes(1)
    controller.stop()
  })

  it('does not fetch offline or hidden and resumes on return', async () => {
    const { controller, options } = fixture()
    let online = false
    options.canRun = () => online
    const c = createAutomaticCollection(options)
    await c.configure(true)
    expect(options.getManifest).not.toHaveBeenCalled()
    online = true
    await c.run()
    expect(options.getManifest).toHaveBeenCalledTimes(1)
    c.stop(); controller.stop()
  })

  it('reports failed cleanup rather than claiming data was removed', async () => {
    const { controller, options } = fixture()
    options.clear.mockRejectedValue(new Error('storage blocked'))
    await controller.configure(false)
    expect(options.onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'cleanupFailed' }))
    expect(options.getManifest).not.toHaveBeenCalled()
    controller.stop()
  })

  it('does not keep downloading for a changed account', async () => {
    const { controller, options } = fixture()
    let active = true
    const c = createAutomaticCollection({ ...options, isActive: () => active })
    options.getManifest.mockImplementation(async () => { active = false; return {} })
    await c.configure(true)
    expect(options.download).not.toHaveBeenCalled()
    c.stop(); controller.stop()
  })

  it('awaits an already-started write when stopping for reset or logout', async () => {
    const { controller, options } = fixture()
    let finish
    options.download.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const running = controller.configure(true)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    let stopped = false
    const stopping = Promise.resolve(controller.stop()).then(() => { stopped = true })
    await Promise.resolve(); await Promise.resolve()
    expect(stopped).toBe(false)
    finish({ complete: true })
    await stopping; await running
    expect(stopped).toBe(true)
  })

  it('does not download before explicit opt-in or when no preference is supplied', async () => {
    const { controller, options } = fixture()
    await controller.run()
    await controller.configure()
    expect(options.getManifest).not.toHaveBeenCalled()
    expect(options.download).not.toHaveBeenCalled()
    expect(options.setPolicy).toHaveBeenCalledWith(false)
    controller.stop()
  })

  it('automatically downloads without a button after explicit opt-in', async () => {
    const { controller, options, manifest } = fixture()
    await controller.configure(true)
    expect(options.getManifest).toHaveBeenCalledTimes(1)
    expect(options.download).toHaveBeenCalledWith(expect.objectContaining({ manifest, signal: expect.any(AbortSignal) }))
    expect(options.setPolicy).toHaveBeenCalledWith(true)
    expect(options.onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'saved', complete: true }))
    controller.stop()
  })
})
