export const DEFAULT_TCGDEX_SYNC_LANGUAGES = ['en', 'de']

export const TCGDEX_LANGUAGES = [
  { code: 'en', name: 'English', short: 'EN', flag: '🇬🇧' },
  { code: 'fr', name: 'French', short: 'FR', flag: '🇫🇷' },
  { code: 'es', name: 'Spanish', short: 'ES', flag: '🇪🇸' },
  { code: 'es-mx', name: 'Spanish Mexico', short: 'ES-MX', flag: '🇲🇽' },
  { code: 'it', name: 'Italian', short: 'IT', flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', short: 'PT', flag: '🇵🇹' },
  { code: 'pt-br', name: 'Portuguese Brazil', short: 'PT-BR', flag: '🇧🇷' },
  { code: 'pt-pt', name: 'Portuguese Portugal', short: 'PT-PT', flag: '🇵🇹' },
  { code: 'de', name: 'German', short: 'DE', flag: '🇩🇪' },
  { code: 'nl', name: 'Dutch', short: 'NL', flag: '🇳🇱' },
  { code: 'pl', name: 'Polish', short: 'PL', flag: '🇵🇱' },
  { code: 'ru', name: 'Russian', short: 'RU', flag: '🇷🇺' },
  { code: 'ja', name: 'Japanese', short: 'JA', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', short: 'KO', flag: '🇰🇷' },
  { code: 'zh-tw', name: 'Chinese Traditional', short: 'ZH-TW', flag: '🇹🇼' },
  { code: 'id', name: 'Indonesian', short: 'ID', flag: '🇮🇩' },
  { code: 'th', name: 'Thai', short: 'TH', flag: '🇹🇭' },
  { code: 'zh-cn', name: 'Chinese Simplified', short: 'ZH-CN', flag: '🇨🇳' },
]

const LANGUAGE_BY_CODE = new Map(TCGDEX_LANGUAGES.map((language) => [language.code, language]))

const LANGUAGE_BADGE_CLASSES = [
  'bg-blue-500/20 text-blue-300 border border-blue-500/30',
  'bg-pink-500/20 text-pink-300 border border-pink-500/30',
  'bg-orange-500/20 text-orange-300 border border-orange-500/30',
  'bg-amber-500/20 text-amber-300 border border-amber-500/30',
  'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
  'bg-teal-500/20 text-teal-300 border border-teal-500/30',
  'bg-lime-500/20 text-lime-300 border border-lime-500/30',
  'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30',
  'bg-yellow/20 text-yellow border border-yellow/30',
  'bg-sky-500/20 text-sky-300 border border-sky-500/30',
  'bg-violet-500/20 text-violet-300 border border-violet-500/30',
  'bg-red-500/20 text-red-300 border border-red-500/30',
  'bg-rose-500/20 text-rose-300 border border-rose-500/30',
  'bg-purple-500/20 text-purple-300 border border-purple-500/30',
  'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30',
  'bg-green-500/20 text-green-300 border border-green-500/30',
  'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30',
  'bg-slate-500/20 text-slate-300 border border-slate-500/30',
]

const LANGUAGE_BADGE_CLASS_BY_CODE = new Map(
  TCGDEX_LANGUAGES.map((language, index) => [language.code, LANGUAGE_BADGE_CLASSES[index] || LANGUAGE_BADGE_CLASSES[0]])
)

export function normalizeTcgdexLanguage(value, fallback = 'en') {
  const code = String(value || '').trim().toLowerCase().replace(/_/g, '-')
  const aliases = {
    zh: 'zh-cn',
    'zh-hans': 'zh-cn',
    'zh-hant': 'zh-tw',
    jp: 'ja',
    kr: 'ko',
    br: 'pt-br',
  }
  const normalized = aliases[code] || code
  return LANGUAGE_BY_CODE.has(normalized) ? normalized : fallback
}

export function getTcgdexLanguage(code) {
  return LANGUAGE_BY_CODE.get(normalizeTcgdexLanguage(code)) || LANGUAGE_BY_CODE.get('en')
}

export function tcgdexLanguageLabel(code, { full = false } = {}) {
  const language = getTcgdexLanguage(code)
  return full ? `${language.flag} ${language.name}` : `${language.flag} ${language.short}`
}

export function tcgdexLanguageBadgeClass(code) {
  return LANGUAGE_BADGE_CLASS_BY_CODE.get(normalizeTcgdexLanguage(code)) || LANGUAGE_BADGE_CLASSES[0]
}

export function normalizeTcgdexLanguageCsv(value) {
  const rawParts = String(value || '')
    .split(/[\s,]+/)
    .map((part) => normalizeTcgdexLanguage(part, ''))
    .filter(Boolean)
  const selected = TCGDEX_LANGUAGES
    .map((language) => language.code)
    .filter((code) => rawParts.includes(code))
  return selected.length ? selected.join(',') : DEFAULT_TCGDEX_SYNC_LANGUAGES.join(',')
}
