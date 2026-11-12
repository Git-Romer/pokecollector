import { describe, expect, it } from 'vitest'
import { formatMoneyInputValue, parseMoneyInputValue } from './moneyInput'

describe('money input with unavailable conversion', () => {
  it('does not show a canonical amount under the selected currency symbol', () => {
    expect(formatMoneyInputValue(10, null)).toBe('')
  })

  it('does not convert or submit a value when no rate is available', () => {
    expect(parseMoneyInputValue('10', null)).toBeUndefined()
    expect(parseMoneyInputValue('10', null, null)).toBeNull()
  })
})
