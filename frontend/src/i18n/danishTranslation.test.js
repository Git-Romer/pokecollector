import { describe, expect, test } from 'vitest'

import da from './da'
import en from './en'

const getMessage = (messages, path) => path.split('.').reduce((value, key) => value?.[key], messages)

const newlyRequiredDanishMessages = [
  'products.openLinkedProduct',
  'settings.currencyRateUnavailable',
  'settings.currencyRateCached',
  'settings.currencyListUnavailable',
]

describe('Danish translations for current English additions', () => {
  test.each(newlyRequiredDanishMessages)('%s has a non-empty Danish translation', path => {
    const translation = getMessage(da, path)

    expect(translation, `missing ${path}`).toEqual(expect.any(String))
    expect(translation.trim(), `empty ${path}`).not.toBe('')
    expect(translation, `${path} should not fall back to English`).not.toBe(getMessage(en, path))
  })

  test('currency description explains cached rates remain available offline', () => {
    expect(da.settings.currencyDesc).not.toBe('Prisvisning')
    expect(da.settings.currencyDesc).toMatch(/offline/i)
  })
})
