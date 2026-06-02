import { TCGDEX_LANGUAGES, normalizeTcgdexLanguage, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'

export default function TcgdexLanguageSelect({
  value,
  onChange,
  includeAll = false,
  allLabel = 'All',
  className = 'select text-sm py-1.5',
  compact = false,
  languages = TCGDEX_LANGUAGES,
  loadingLabel = 'Loading…',
}) {
  const isLoading = Boolean(languages?.isLoading)
  const normalizedValue = includeAll && value === 'all' ? 'all' : normalizeTcgdexLanguage(value)
  const options = isLoading ? [] : (Array.isArray(languages) ? languages : TCGDEX_LANGUAGES)

  return (
    <select
      value={normalizedValue}
      onChange={(event) => onChange(event.target.value)}
      className={className}
      disabled={isLoading}
    >
      {isLoading && <option value={normalizedValue}>{loadingLabel}</option>}
      {!isLoading && includeAll && <option value="all">{allLabel}</option>}
      {options.map((language) => (
        <option key={language.code} value={language.code}>
          {compact ? tcgdexLanguageLabel(language.code) : tcgdexLanguageLabel(language.code, { full: true })}
        </option>
      ))}
    </select>
  )
}
