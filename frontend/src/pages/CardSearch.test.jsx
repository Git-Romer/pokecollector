import { describe, expect, it } from 'vitest'
import { buildCardSearchParams, CARD_CODE_NUMBER_RE } from './CardSearch'

const filters = {
  name: '',
  category: '',
  type: '',
  subtype: '',
  rarity: '',
  set_id: '',
  artist: '',
  rule_text: '',
  hp_min: '',
  hp_max: '',
  sort_by: '',
  sort_order: 'asc',
}

const buildParams = (updates = {}) => buildCardSearchParams(
  { ...filters, ...updates },
  'en',
  1,
  20,
)

describe('CardSearch text request parameters', () => {
  it('uses the public q parameter for the primary search text', () => {
    expect(buildParams({ name: 'M2a 228' })).toMatchObject({ q: 'M2a 228' })
    expect(buildParams({ name: 'M2a 228' }).name).toBeUndefined()
  })
})

describe('CardSearch rule text request parameters', () => {
  it('sends a non-empty Rule text value as rule_text', () => {
    expect(buildParams({ rule_text: 'Thunder Jab' }).rule_text).toBe('Thunder Jab')
  })

  it('passes multi-word Rule text as the full value', () => {
    expect(buildParams({ rule_text: 'draw 3 cards' }).rule_text).toBe('draw 3 cards')
  })

  it('trims Rule text before sending the request', () => {
    expect(buildParams({ rule_text: '  draw 3 cards  ' }).rule_text).toBe('draw 3 cards')
  })

  it('omits whitespace-only Rule text from the request', () => {
    expect(buildParams({ rule_text: '   ' }).rule_text).toBeUndefined()
  })

  it('does not send rule_text when the Rule text field is empty', () => {
    expect(buildParams().rule_text).toBeUndefined()
  })

  it('combines Rule text with existing filters', () => {
    expect(buildParams({ rule_text: 'Thunder Jab', category: 'Pokemon' })).toMatchObject({
      rule_text: 'Thunder Jab',
      category: 'Pokemon',
    })
  })

  it('removes rule_text from the request after Rule text is cleared', () => {
    expect(buildParams({ rule_text: 'Thunder Jab' }).rule_text).toBe('Thunder Jab')
    expect(buildParams({ rule_text: '' }).rule_text).toBeUndefined()
  })
})

describe('CardSearch set code and number detection', () => {
  it('accepts mixed alphanumeric TCGdex set codes', () => {
    expect(CARD_CODE_NUMBER_RE.test('M2a 228')).toBe(true)
    expect(CARD_CODE_NUMBER_RE.test('sv08 032')).toBe(true)
  })
})
