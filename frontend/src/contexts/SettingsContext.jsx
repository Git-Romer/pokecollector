import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import de from '../i18n/de'
import en from '../i18n/en'
import zh from '../i18n/zh'
import zhCn from '../i18n/zhCn'
import sv from '../i18n/sv'
import fr from '../i18n/fr'
import nl from '../i18n/nl'
import es from '../i18n/es'
import esMx from '../i18n/esMx'
import it from '../i18n/it'
import pt from '../i18n/pt'
import ptBr from '../i18n/ptBr'
import ptPt from '../i18n/ptPt'
import pl from '../i18n/pl'
import ru from '../i18n/ru'
import ja from '../i18n/ja'
import ko from '../i18n/ko'
import id from '../i18n/id'
import th from '../i18n/th'
import zhTw from '../i18n/zhTw'
import { priceFieldFromPrimary } from '../utils/prices'
import { normalizeTcgdexLanguageCsv } from '../utils/tcgdexLanguages'

const translations = {
  de,
  en,
  zh,
  'zh-cn': zhCn,
  sv,
  fr,
  nl,
  es,
  'es-mx': esMx,
  it,
  pt,
  'pt-br': ptBr,
  'pt-pt': ptPt,
  pl,
  ru,
  ja,
  ko,
  id,
  th,
  'zh-tw': zhTw,
}

const DEFAULT_SETTINGS = {
  language: 'de',
  price_display: '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
  price_primary: 'trend',
  tcgdex_sync_languages: 'en,de',
  cross_language_price_fallback: 'true',
  cross_language_image_fallback: 'true',
  debug_mode: 'false',
}

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [exchangeRate, setExchangeRate] = useState(1.0)
  const [exchangeRateReady, setExchangeRateReady] = useState(true)
  const [exchangeRateCurrency, setExchangeRateCurrency] = useState('EUR')
  const [usdToEurRate, setUsdToEurRate] = useState(0.91)

  // Load settings from backend on mount
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) { setLoaded(true); return }
    fetch('/api/settings/', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        setSettings(prev => ({
          ...prev,
          ...data,
          language: data.language === 'zh' ? 'zh-cn' : (data.language || prev.language),
          tcgdex_sync_languages: normalizeTcgdexLanguageCsv(data.tcgdex_sync_languages || prev.tcgdex_sync_languages),
        }))
        setLoaded(true)
      })
      .catch(() => {
        // Backend not available, use defaults
        setLoaded(true)
      })
  }, [])

  // Fetch exchange rates through the backend to avoid browser CORS/redirect issues.
  // Most app prices are stored in EUR; TCGPlayer prices are stored in USD and need the inverse path.
  useEffect(() => {
    const fetchExchangeRate = async (from, to, fallback) => {
      const token = localStorage.getItem('token')
      if (!token) return fallback
      try {
        const response = await fetch(`/api/settings/exchange-rate?from=${from}&to=${to}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!response.ok) throw new Error('Exchange rate lookup failed')
        const data = await response.json()
        return Number(data.rate) || fallback
      } catch {
        return fallback
      }
    }

    const curr = settings.currency || 'EUR'
    let cancelled = false
    if (curr === 'USD') {
      setExchangeRateReady(false)
      setExchangeRateCurrency(null)
      setExchangeRate(1.1)
      fetchExchangeRate('EUR', 'USD', 1.1).then(rate => {
        if (!cancelled) {
          setExchangeRate(rate)
          setExchangeRateCurrency('USD')
          setExchangeRateReady(true)
        }
      })
    } else {
      setExchangeRateReady(true)
      setExchangeRateCurrency('EUR')
      setExchangeRate(1.0)
      fetchExchangeRate('USD', 'EUR', 0.91).then(rate => {
        if (!cancelled) setUsdToEurRate(rate)
      })
    }
    return () => { cancelled = true }
  }, [settings.currency])

  // Update one or more settings
  const updateSettings = useCallback(async (updates) => {
    const next = { ...settings, ...updates }
    setSettings(next)
    try {
      const token = localStorage.getItem('token')
      const headers = { 'Content-Type': 'application/json' }
      if (token) headers.Authorization = `Bearer ${token}`

      const resp = await fetch('/api/settings/', {
        method: 'PUT',
        headers,
        body: JSON.stringify(updates),
      })
      if (!resp.ok) throw new Error('Save failed')
      const saved = await resp.json()
      setSettings(prev => ({
        ...prev,
        ...saved,
        language: saved.language === 'zh' ? 'zh-cn' : (saved.language || prev.language),
      }))
    } catch (err) {
      setSettings(settings)
      console.error('Failed to save settings:', err)
      throw err
    }
  }, [settings])

  const lang = settings.language || 'de'
  const msgs = translations[lang] || translations.de

  // Translation helper
  const t = useCallback((path) => {
    const parts = path.split('.')
    let val = msgs
    for (const part of parts) {
      val = val?.[part]
      if (val === undefined) break
    }
    if (val === undefined) {
      // Fallback to German
      let fallback = translations.de
      for (const part of parts) {
        fallback = fallback?.[part]
        if (fallback === undefined) break
      }
      return fallback ?? path
    }
    return val
  }, [msgs])

  // Parse price_display JSON safely
  const getPriceDisplay = useCallback(() => {
    try {
      const val = settings.price_display
      if (Array.isArray(val)) return val
      return JSON.parse(val || '["trend", "avg", "avg1", "avg7", "avg30", "low"]')
    } catch {
      return ['trend', 'avg', 'avg1', 'avg7', 'avg30', 'low']
    }
  }, [settings.price_display])

  const getPricePrimary = useCallback(() => {
    return settings.price_primary || 'trend'
  }, [settings.price_primary])

  const currency = settings.currency || 'EUR'
  const currencySymbol = currency === 'USD' ? '$' : '€'
  const moneyExchangeRateReady = currency !== 'USD' || (exchangeRateReady && exchangeRateCurrency === 'USD')
  const pricePrimary = getPricePrimary()
  const pricePrimaryField = priceFieldFromPrimary(pricePrimary)

  const formatPrice = useCallback((eurAmount) => {
    if (eurAmount == null || isNaN(Number(eurAmount))) return '-'
    const converted = Number(eurAmount) * exchangeRate
    return `${currencySymbol}${converted.toFixed(2)}`
  }, [exchangeRate, currencySymbol])

  const formatUsdPrice = useCallback((usdAmount) => {
    if (usdAmount == null || isNaN(Number(usdAmount))) return '-'
    const converted = currency === 'USD' ? Number(usdAmount) : Number(usdAmount) * usdToEurRate
    return `${currencySymbol}${converted.toFixed(2)}`
  }, [currency, currencySymbol, usdToEurRate])

  return (
    <SettingsContext.Provider value={{
      settings,
      updateSettings,
      t,
      language: lang,
      priceDisplay: getPriceDisplay(),
      pricePrimary,
      pricePrimaryField,
      loaded,
      currency,
      currencySymbol,
      exchangeRate,
      exchangeRateReady: moneyExchangeRateReady,
      formatPrice,
      formatUsdPrice,
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}

export default SettingsContext
