import { TCGDEX_LANGUAGES, normalizeTcgdexLanguage, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'

export default function TcgdexLanguageSelect({
  value,
  onChange,
  includeAll = false,
  allLabel = 'All',
  className = 'select text-sm py-1.5',
  compact = false,
}) {
  const normalizedValue = includeAll && value === 'all' ? 'all' : normalizeTcgdexLanguage(value)

  return (
    <select
      value={normalizedValue}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    >
      {includeAll && <option value="all">{allLabel}</option>}
      {TCGDEX_LANGUAGES.map((language) => (
        <option key={language.code} value={language.code}>
          {compact ? tcgdexLanguageLabel(language.code) : tcgdexLanguageLabel(language.code, { full: true })}
        </option>
      ))}
    </select>
  )
}
