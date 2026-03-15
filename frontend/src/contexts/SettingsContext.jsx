import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import de from '../i18n/de'
import en from '../i18n/en'
import zh from '../i18n/zh'

const translations = { de, en, zh }

const DEFAULT_SETTINGS = {
  language: 'de',
  price_display: '["trend", "avg1", "avg7", "avg30", "low"]',
  price_primary: 'trend',
}

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [exchangeRate, setExchangeRate] = useState(1.0)

  // Load settings from backend on mount
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) { setLoaded(true); return }
    fetch('/api/settings/', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        setSettings(prev => ({ ...prev, ...data }))
        setLoaded(true)
      })
      .catch(() => {
        // Backend not available, use defaults
        setLoaded(true)
      })
  }, [])

  // Fetch exchange rate whenever currency changes to USD
  useEffect(() => {
    const curr = settings.currency || 'EUR'
    if (curr === 'USD') {
      fetch('https://api.frankfurter.app/latest?from=EUR&to=USD')
        .then(r => r.json())
        .then(data => setExchangeRate(data.rates?.USD || 1.1))
        .catch(() => setExchangeRate(1.1))
    } else {
      setExchangeRate(1.0)
    }
  }, [settings.currency])

  // Update one or more settings
  const updateSettings = useCallback(async (updates) => {
    const next = { ...settings, ...updates }
    setSettings(next)
    try {
      const resp = await fetch('/api/settings/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!resp.ok) throw new Error('Save failed')
      const saved = await resp.json()
      setSettings(prev => ({ ...prev, ...saved }))
    } catch (err) {
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
      return JSON.parse(val || '["trend", "avg1", "avg7", "avg30", "low"]')
    } catch {
      return ['trend', 'avg1', 'avg7', 'avg30', 'low']
    }
  }, [settings.price_display])

  const getPricePrimary = useCallback(() => {
    return settings.price_primary || 'trend'
  }, [settings.price_primary])

  const currency = settings.currency || 'EUR'
  const currencySymbol = currency === 'USD' ? '$' : '€'

  const formatPrice = useCallback((eurAmount) => {
    if (eurAmount == null || isNaN(Number(eurAmount))) return '-'
    const converted = Number(eurAmount) * exchangeRate
    return `${currencySymbol}${converted.toFixed(2)}`
  }, [exchangeRate, currencySymbol])

  return (
    <SettingsContext.Provider value={{
      settings,
      updateSettings,
      t,
      language: lang,
      priceDisplay: getPriceDisplay(),
      pricePrimary: getPricePrimary(),
      loaded,
      currency,
      currencySymbol,
      formatPrice,
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
