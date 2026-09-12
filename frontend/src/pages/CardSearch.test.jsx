import { describe, expect, it } from 'vitest'
import { buildCardSearchParams } from './CardSearch'

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

describe('CardSearch rule text request parameters', () => {
  it('sends a non-empty Rule text value as rule_text', () => {
    expect(buildParams({ rule_text: 'Thunder Jab' }).rule_text).toBe('Thunder Jab')
  })

  it('passes multi-word Rule text as the full value', () => {
    expect(buildParams({ rule_text: 'draw 3 cards' }).rule_text).toBe('draw 3 cards')
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
