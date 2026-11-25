import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OfflineBanner from './OfflineBanner'

let offline = true

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: key => key }),
}))

vi.mock('../../offline/useOffline', () => ({
  useOffline: () => offline,
}))

describe('OfflineBanner', () => {
  beforeEach(() => { offline = true })

  it('keeps its text below the iPhone status bar', () => {
    const markup = renderToStaticMarkup(createElement(OfflineBanner))

    expect(markup).toContain('data-testid="offline-banner"')
    expect(markup).toContain('padding-top:max(0.5rem, env(safe-area-inset-top))')
    expect(markup).toContain('pb-2')
  })

  it('renders nothing while online', () => {
    offline = false
    expect(renderToStaticMarkup(createElement(OfflineBanner))).toBe('')
  })
})
