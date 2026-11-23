import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import en from '../i18n/en'
import { priceFieldFromPrimary } from '../utils/prices'
import { normalizeTcgdexLanguageCsv } from '../utils/tcgdexLanguages'
import { currencySymbolFor, formatSelectedCurrency, rateForSelectedCurrency } from '../utils/currencyFormatting'
import { useAuth } from './AuthContext'
import { stageOfflineCollectionPreference, pendingOfflineCollectionPreference, acknowledgeOfflineCollectionPreference, loadSettingsWithCache, readCachedRate, readCachedSettings, withRateCache, withTimeout, writeCachedSettings, SETTINGS_CACHE_KEY } from '../offline/settingsCache'

const TRANSLATION_LOADERS = {
  de: () => import('../i18n/de'),
  zh: () => import('../i18n/zh'),
  'zh-cn': () => import('../i18n/zhCn'),
  sv: () => import('../i18n/sv'),
  fr: () => import('../i18n/fr'),
  nl: () => import('../i18n/nl'),
  es: () => import('../i18n/es'),
  'es-mx': () => import('../i18n/esMx'),
  it: () => import('../i18n/it'),
  pt: () => import('../i18n/pt'),
  'pt-br': () => import('../i18n/ptBr'),
  'pt-pt': () => import('../i18n/ptPt'),
  pl: () => import('../i18n/pl'),
  ru: () => import('../i18n/ru'),
  ja: () => import('../i18n/ja'),
  ko: () => import('../i18n/ko'),
  id: () => import('../i18n/id'),
  th: () => import('../i18n/th'),
  'zh-tw': () => import('../i18n/zhTw'),
  da: () => import('../i18n/da'),
}
const SUPPORTED_LANGUAGES = new Set(['en', ...Object.keys(TRANSLATION_LOADERS)])

const DEFAULT_SETTINGS = {
  language: 'en',
  price_display: '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
  price_primary: 'trend',
  portfolio_display_mode: 'portfolio_value',
  tcgdex_sync_languages: 'en,de',
  tcgdex_digital_sets_enabled: 'true',
  cross_language_price_fallback: 'true',
  cross_language_image_fallback: 'true',
  set_overview_filters: '{}',
  hidden_set_ids: '[]',
  debug_mode: 'false',
  public_profiles_enabled: 'false',
  prefer_own_card_photos: 'false',
  holo_effects_enabled: 'false',
  offline_collection_enabled: 'false',
}

const LANGUAGE_STORAGE_KEY = 'app_language'
const CURRENCY_STORAGE_KEY = 'app_currency'

// The backend stays the source of truth for the language and currency, but these
// small local copies preserve the user's selected display preference for first paint.
function readCachedLanguage() {
  try {
    const cached = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return cached && SUPPORTED_LANGUAGES.has(cached) ? cached : null
  } catch {
    return null
  }
}

function cacheLanguage(language) {
  if (!language || !SUPPORTED_LANGUAGES.has(language)) return
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the backend copy still holds.
  }
}

function readCachedCurrency() {
  try {
    const cached = localStorage.getItem(CURRENCY_STORAGE_KEY)
    return cached && /^[A-Z]{3}$/.test(cached) ? cached : null
  } catch {
    return null
  }
}

function cacheCurrency(currency) {
  const normalized = String(currency || '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) return
  try {
    localStorage.setItem(CURRENCY_STORAGE_KEY, normalized)
  } catch {
    // Storage can be unavailable; the backend setting remains authoritative.
  }
}

function initialSettings(userId) {
  const cached = readCachedSettings(userId) || {}
  return {
    ...DEFAULT_SETTINGS,
    ...cached,
    language: readCachedLanguage() || cached.language || DEFAULT_SETTINGS.language,
    currency: cached.currency || readCachedCurrency() || 'EUR',
  }
}

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const { user, loading: authLoading, multiUser } = useAuth()
  const [settings, setSettings] = useState(() => initialSettings(user?.id))
  const [downloadPreferencePending, setDownloadPreferencePending] = useState(false)
  const flushDownloadPreference = useRef(null)
  const [loaded, setLoaded] = useState(false)
  const [loadedUserId, setLoadedUserId] = useState(undefined)
  const currentUserRef = useRef(user?.id)
  currentUserRef.current = user?.id
  const [exchangeRate, setExchangeRate] = useState(() => (
    (settings.currency || 'EUR').toUpperCase() === 'EUR' ? 1 : null
  ))
  const [exchangeRateReady, setExchangeRateReady] = useState(() => (
    (settings.currency || 'EUR').toUpperCase() === 'EUR'
  ))
  const [exchangeRateCurrency, setExchangeRateCurrency] = useState(() => (
    (settings.currency || 'EUR').toUpperCase() === 'EUR' ? 'EUR' : null
  ))
  const [usdToDisplayRate, setUsdToDisplayRate] = useState(() => (
    (settings.currency || 'EUR').toUpperCase() === 'USD' ? 1 : null
  ))
  const [usdToDisplayRateCurrency, setUsdToDisplayRateCurrency] = useState(() => (
    (settings.currency || 'EUR').toUpperCase() === 'USD' ? 'USD' : null
  ))
  const [exchangeRateStale, setExchangeRateStale] = useState(false)
  const [exchangeRateDate, setExchangeRateDate] = useState(null)
  const [exchangeRateSyncedAt, setExchangeRateSyncedAt] = useState(null)
  const [loadedTranslations, setLoadedTranslations] = useState({ en })

  // Load settings from backend once auth mode is known. Single-user mode has no
  // token, but the backend still auto-authenticates the bootstrap admin.
  useEffect(() => {
    if (authLoading) return
    let cancelled = false
    setLoaded(false)
    const token = localStorage.getItem('token')
    if (multiUser && !token) {
      setSettings(initialSettings(user?.id))
      setLoadedUserId(user?.id)
      setLoaded(true)
      return
    }

    const headers = token && multiUser ? { Authorization: `Bearer ${token}` } : {}
    // Stale-while-revalidate: show this user's cached settings now (the user is only known
    // here, not at mount), then let the network copy replace them. A hanging offline request
    // times out and loadSettingsWithCache falls back to the same cache.
    setSettings(initialSettings(user?.id))
    loadSettingsWithCache(user?.id, signal => fetch('/api/settings/', { headers, signal })
      .then(r => {
        if (!r.ok) throw new Error('Settings load failed')
        return r.json()
      }))
      .then(data => {
        if (cancelled) return
        const language = data.language === 'zh' ? 'zh-cn' : data.language
        cacheLanguage(language)
        cacheCurrency(data.currency)
        setSettings(prev => ({
          ...prev,
          ...data,
          language: language || prev.language,
          tcgdex_sync_languages: normalizeTcgdexLanguageCsv(data.tcgdex_sync_languages || prev.tcgdex_sync_languages),
        }))
        setLoadedUserId(user?.id)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        // Backend not available, use defaults
        setLoadedUserId(user?.id)
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [authLoading, multiUser, user?.id])

  const lang = settings.language || DEFAULT_SETTINGS.language
  useEffect(() => {
    if (lang === 'en' || loadedTranslations[lang]) return
    const loader = TRANSLATION_LOADERS[lang]
    if (!loader) return

    let cancelled = false
    loader()
      .then(module => {
        if (!cancelled) {
          setLoadedTranslations(previous => ({ ...previous, [lang]: module.default }))
        }
      })
      .catch(() => {
        // English remains available if a language chunk cannot be loaded.
      })
    return () => { cancelled = true }
  }, [lang, loadedTranslations])

  // Exchange-rate requests use the backend's shared database cache. EUR and USD
  // are synchronized in both directions so selecting another currency later can
  // still use the most recently saved rate while offline.
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (authLoading) return

    const fetchExchangeRate = async (from, to) => {
      try {
        const headers = token && multiUser ? { Authorization: `Bearer ${token}` } : {}
        const params = new URLSearchParams({ from, to })
        const response = await fetch(`/api/settings/exchange-rate?${params}`, { headers })
        if (!response.ok) return null
        const data = await response.json()
        const rate = Number(data.rate)
        if (!Number.isFinite(rate) || rate <= 0) return null
        return {
          rate,
          stale: Boolean(data.stale),
          providerDate: data.provider_date || null,
          syncedAt: data.synced_at || null,
        }
      } catch {
        return null
      }
    }

    const curr = (settings.currency || 'EUR').toUpperCase()
    const usesEurBaseDirectly = curr === 'EUR'
    const usesUsdBaseDirectly = curr === 'USD'
    const eurPair = usesEurBaseDirectly ? ['EUR', 'USD'] : ['EUR', curr]
    const usdPair = usesUsdBaseDirectly ? ['USD', 'EUR'] : ['USD', curr]
    let cancelled = false

    setExchangeRateReady(usesEurBaseDirectly)
    setExchangeRateCurrency(usesEurBaseDirectly ? 'EUR' : null)
    setExchangeRate(usesEurBaseDirectly ? 1 : null)
    setUsdToDisplayRate(usesUsdBaseDirectly ? 1 : null)
    setUsdToDisplayRateCurrency(usesUsdBaseDirectly ? 'USD' : null)
    setExchangeRateStale(false)
    setExchangeRateDate(null)
    setExchangeRateSyncedAt(null)

    Promise.all([
      fetchExchangeRate(...eurPair),
      fetchExchangeRate(...usdPair),
    ]).then(([eurQuote, usdQuote]) => {
      if (cancelled) return

      if (usesEurBaseDirectly) {
        setExchangeRate(1)
        setExchangeRateCurrency('EUR')
        setExchangeRateReady(true)
      } else if (eurQuote) {
        setExchangeRate(eurQuote.rate)
        setExchangeRateCurrency(curr)
        setExchangeRateReady(true)
      } else {
        setExchangeRate(null)
        setExchangeRateCurrency(null)
        setExchangeRateReady(false)
      }

      const usdRate = usesUsdBaseDirectly ? 1 : (usdQuote?.rate ?? null)
      setUsdToDisplayRate(usdRate)
      setUsdToDisplayRateCurrency(usdRate == null ? null : curr)
      const staleQuote = [eurQuote, usdQuote].find(quote => quote?.stale)
      const statusQuote = staleQuote || (usesEurBaseDirectly ? usdQuote : eurQuote)
      setExchangeRateStale(Boolean(staleQuote))
      setExchangeRateDate(statusQuote?.providerDate || null)
      setExchangeRateSyncedAt(statusQuote?.syncedAt || null)
    })

    return () => { cancelled = true }
  }, [settings.currency, authLoading, multiUser, user?.id])

  // Update one or more settings
  // Local deletion must not depend on reaching the server. Persist only this
  // narrow preference, then replay it in order for the same account/session.
  useEffect(() => {
    if (!loaded || loadedUserId !== user?.id || authLoading) return undefined
    const userId = user?.id
    const token = localStorage.getItem('token')
    if (multiUser && !token) return undefined
    let cancelled = false
    let flight = null
    const active = () => !cancelled && currentUserRef.current === userId && localStorage.getItem('token') === token
    const flush = async (conflictAttempt = 0) => {
      if (!active() || flight || navigator.onLine === false) return
      const pending = pendingOfflineCollectionPreference(userId)
      setDownloadPreferencePending(Boolean(pending))
      if (!pending) return
      let conflict = false
      flight = withTimeout(async signal => {
        if (!active()) return
        const headers = { 'Content-Type': 'application/json', ...(multiUser && token ? { Authorization: `Bearer ${token}` } : {}) }
        const current = await fetch('/api/settings/', { headers, signal, cache: 'no-store' })
        if (!current.ok) throw new Error('Download preference pending')
        const server = await current.json()
        // Another tab may have acknowledged or replaced this intent during GET.
        if (!active() || pendingOfflineCollectionPreference(userId)?.revision !== pending.revision) return
        const response = await fetch('/api/settings/', {
          method: 'PUT', signal,
          headers: { ...headers, 'X-Offline-Preference-Revision': server.offline_collection_revision || '0' },
          body: JSON.stringify({ offline_collection_enabled: pending.value }),
        })
        if (response.status === 409) conflict = true
        if (!response.ok) throw new Error('Download preference pending')
        const saved = await response.json()
        if (saved.offline_collection_enabled !== pending.value) throw new Error('Download preference not acknowledged')
        if (active()) acknowledgeOfflineCollectionPreference(userId, pending.revision)
      })
      let succeeded = false
      try { await flight; succeeded = true } catch { /* Keep the durable intent and the local setting. */ }
      finally {
        flight = null
        if (active()) {
          const latest = pendingOfflineCollectionPreference(userId)
          setDownloadPreferencePending(Boolean(latest))
          // A second choice made during the request supersedes its acknowledgement.
          if (latest && succeeded && latest.revision !== pending.revision) void flush()
          else if (latest && conflict && conflictAttempt < 2) void flush(conflictAttempt + 1)
        }
      }
    }
    flushDownloadPreference.current = flush
    setDownloadPreferencePending(Boolean(pendingOfflineCollectionPreference(userId)))
    void flush()
    const wake = () => { if (document.visibilityState === 'visible') void flush() }
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('pageshow', wake)
    document.addEventListener('visibilitychange', wake)
    const interval = setInterval(wake, 30000)
    return () => {
      cancelled = true
      if (flushDownloadPreference.current === flush) flushDownloadPreference.current = null
      clearInterval(interval)
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('pageshow', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [loaded, loadedUserId, user?.id, multiUser, authLoading])

  const updateSettings = useCallback(async (updates) => {
    if (Object.keys(updates).length === 1 && Object.hasOwn(updates, 'offline_collection_enabled')) {
      if (!loaded || loadedUserId !== user?.id || !stageOfflineCollectionPreference(user?.id, updates.offline_collection_enabled)) {
        throw new Error('Could not save device preference')
      }
      setSettings(prev => ({ ...prev, ...updates }))
      setDownloadPreferencePending(true)
      void flushDownloadPreference.current?.()
      return updates
    }
    const next = { ...settings, ...updates }
    setSettings(next)
    try {
      const token = localStorage.getItem('token')
      const headers = { 'Content-Type': 'application/json' }
      if (token && multiUser) headers.Authorization = `Bearer ${token}`

      const saved = await withTimeout(async signal => {
        const resp = await fetch('/api/settings/', {
          method: 'PUT', headers, body: JSON.stringify(updates), signal,
        })
        if (!resp.ok) throw new Error('Save failed')
        return resp.json()
      })
      if (!Object.hasOwn(updates, 'offline_collection_enabled')) delete saved.offline_collection_enabled
      writeCachedSettings(user?.id, { ...readCachedSettings(user?.id), ...saved })
      if (currentUserRef.current !== user?.id) return
      const language = saved.language === 'zh' ? 'zh-cn' : saved.language
      cacheLanguage(language)
      cacheCurrency(saved.currency)
      setSettings(prev => ({
        ...prev,
        ...saved,
        language: language || prev.language,
      }))
    } catch (err) {
      if (currentUserRef.current === user?.id) setSettings(previous => ({ ...settings, offline_collection_enabled: previous.offline_collection_enabled }))
      console.error('Failed to save settings:', err)
      throw err
    }
  }, [settings, multiUser, user?.id, loaded, loadedUserId])

  // A toggle in another tab must stop this tab's writer too.
  useEffect(() => {
    const changed = event => {
      if (event.key !== SETTINGS_CACHE_KEY) return
      const cached = readCachedSettings(user?.id)
      if (cached) setSettings(previous => ({ ...previous, ...cached }))
      setDownloadPreferencePending(Boolean(pendingOfflineCollectionPreference(user?.id)))
      void flushDownloadPreference.current?.()
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [user?.id])

  const msgs = loadedTranslations[lang] || en

  // Translation helper
  const t = useCallback((path) => {
    const parts = path.split('.')
    let val = msgs
    for (const part of parts) {
      val = val?.[part]
      if (val === undefined) break
    }
    if (val === undefined) {
      // Fallback to English
      let fallback = en
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

  const requestedCurrency = (settings.currency || 'EUR').toUpperCase()
  const moneyExchangeRateReady = requestedCurrency === 'EUR'
    ? exchangeRateReady && exchangeRateCurrency === 'EUR'
    : exchangeRateReady && exchangeRateCurrency === requestedCurrency
  const currency = requestedCurrency
  const currencySymbol = useMemo(
    () => currencySymbolFor(currency, lang),
    [currency, lang],
  )
  const pricePrimary = getPricePrimary()
  const pricePrimaryField = priceFieldFromPrimary(pricePrimary)
  const displayRate = moneyExchangeRateReady ? exchangeRate : null
  const usdDisplayRate = rateForSelectedCurrency(
    usdToDisplayRate,
    usdToDisplayRateCurrency,
    requestedCurrency,
  )

  const convertEurToDisplay = useCallback((eurAmount) => {
    if (eurAmount == null || !Number.isFinite(Number(eurAmount)) || displayRate == null) return null
    return Number(eurAmount) * displayRate
  }, [displayRate])

  const convertDisplayToEur = useCallback((displayAmount) => {
    if (displayAmount == null || !Number.isFinite(Number(displayAmount)) || displayRate == null) return null
    return Number(displayAmount) / displayRate
  }, [displayRate])

  const formatPrice = useCallback((eurAmount) => (
    formatSelectedCurrency(eurAmount, currency, displayRate, lang)
  ), [currency, displayRate, lang])

  const formatUsdPrice = useCallback((usdAmount) => (
    formatSelectedCurrency(usdAmount, currency, usdDisplayRate, lang)
  ), [currency, usdDisplayRate, lang])

  return (
    <SettingsContext.Provider value={{
      settings,
      updateSettings,
      downloadPreferencePending,
      t,
      language: lang,
      priceDisplay: getPriceDisplay(),
      pricePrimary,
      pricePrimaryField,
      loaded: loaded && loadedUserId === user?.id,
      currency,
      currencySymbol,
      exchangeRate: displayRate,
      exchangeRateReady: moneyExchangeRateReady,
      usdExchangeRateReady: usdDisplayRate != null,
      exchangeRateStale,
      exchangeRateDate,
      exchangeRateSyncedAt,
      convertEurToDisplay,
      convertDisplayToEur,
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
