import { describe, expect, test } from 'vitest'

import de from './de'
import en from './en'
import es from './es'
import esMx from './esMx'
import fr from './fr'
import id from './id'
import itMessages from './it'
import ja from './ja'
import ko from './ko'
import nl from './nl'
import pl from './pl'
import pt from './pt'
import ptBr from './ptBr'
import ptPt from './ptPt'
import ru from './ru'
import sv from './sv'
import th from './th'
import zh from './zh'
import zhCn from './zhCn'
import zhTw from './zhTw'

const locales = {
  de,
  en,
  es,
  'es-mx': esMx,
  fr,
  id,
  it: itMessages,
  ja,
  ko,
  nl,
  pl,
  pt,
  'pt-br': ptBr,
  'pt-pt': ptPt,
  ru,
  sv,
  th,
  zh,
  'zh-cn': zhCn,
  'zh-tw': zhTw,
}

const scannerKeys = Object.keys(en.settings).filter(key => key.startsWith('scanner'))

describe('scanner settings translations', () => {
  test.each(Object.entries(locales))('%s contains the complete scanner flow', (_locale, messages) => {
    for (const key of scannerKeys) {
      expect(messages.settings[key], `missing settings.${key}`).toEqual(expect.any(String))
      expect(messages.settings[key].trim(), `empty settings.${key}`).not.toBe('')
    }
  })
})
