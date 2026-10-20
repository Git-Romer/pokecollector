import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MoneyInput from './MoneyInput'

const useSettings = vi.fn()

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => useSettings(),
}))

function renderMoneyInput(currencySymbol) {
  useSettings.mockReturnValue({ currencySymbol, exchangeRateReady: true })
  return renderToStaticMarkup(createElement(MoneyInput, {
    value: '12.34',
    onChange: () => {},
  }))
}

describe('MoneyInput currency symbol spacing', () => {
  beforeEach(() => useSettings.mockReset())

  it('adds room for multi-character currency symbols', () => {
    expect(renderMoneyInput('kr')).toContain('pl-8')
  })

  it('keeps the compact spacing for single-character currency symbols', () => {
    expect(renderMoneyInput('€')).toContain('pl-7')
  })
})
