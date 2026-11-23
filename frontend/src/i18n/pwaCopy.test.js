import { describe, expect, test } from 'vitest'
import en from './en'
import de from './de'

const keys = [
  ['offlineCollection', 'automaticNotice'],
  ['sync', 'safariWarning'],
  ['pwa', 'pushIosHint'],
  ['pwa', 'installTitle'],
  ['pwa', 'capInstalled'],
]

describe.each(Object.entries({ en, de }))('%s offline and installation copy', (_locale, messages) => {
  test.each(keys)('%s.%s does not assume a device or browser brand', (section, key) => {
    expect(messages[section][key]).toEqual(expect.any(String))
    expect(messages[section][key]).not.toMatch(/\b(?:iPhone|iPad|iPod|Safari)\b/i)
  })
})
