import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('reloads once for each document activation despite a previous session reload marker', async () => {
  const serviceWorker = new EventTarget()
  const reload = vi.fn()
  const storage = new Map([['pc.reloaded', '1']])
  vi.stubGlobal('navigator', { serviceWorker })
  vi.stubGlobal('window', { location: { reload } })
  vi.stubGlobal('sessionStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) })
  const waiting = { postMessage: vi.fn() }
  const first = await import('./register.js')
  first.applyUpdate({ waiting })
  first.applyUpdate({ waiting })
  serviceWorker.dispatchEvent(new Event('controllerchange'))
  expect(reload).toHaveBeenCalledTimes(1)
  // A real reload starts a new module/document but preserves sessionStorage.
  vi.resetModules()
  const second = await import('./register.js')
  second.applyUpdate({ waiting: { postMessage: vi.fn() } })
  serviceWorker.dispatchEvent(new Event('controllerchange'))
  expect(reload).toHaveBeenCalledTimes(2)
})
