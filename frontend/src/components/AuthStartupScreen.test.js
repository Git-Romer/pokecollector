import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AuthStartupScreen from './AuthStartupScreen'

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    t: key => ({
      'auth.connectionTitle': 'Cannot reach PokéCollector',
      'auth.connectionMessage': 'The server is still starting or temporarily unavailable.',
      'auth.retryConnection': 'Try again',
      'auth.startingTitle': 'Starting PokéCollector',
      'auth.startingMessage': 'Checking the server and your session...',
    })[key] || key,
  }),
}))

describe('AuthStartupScreen', () => {
  it('shows a neutral startup state before auth mode is known', () => {
    const markup = renderToStaticMarkup(createElement(AuthStartupScreen))

    expect(markup).toContain('Starting PokéCollector')
    expect(markup).not.toContain('Cannot reach PokéCollector')
  })

  it('shows a clear retryable connection state after a failed request', () => {
    const markup = renderToStaticMarkup(createElement(AuthStartupScreen, {
      connectionError: true,
      onRetry: () => {},
    }))

    expect(markup).toContain('Cannot reach PokéCollector')
    expect(markup).toContain('Try again')
    expect(markup).toContain('aria-live="polite"')
  })
})
