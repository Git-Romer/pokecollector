import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Download, Upload } from 'lucide-react'
import {
  getSyncStatus, triggerSync, triggerPriceSync, rescheduleFullSync, reschedulePriceSync,
  downloadBackup, restoreBackup, exportCSV,
  getSetting, setSetting, getTelegramStatus, saveSettings,
} from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { formatDistanceToNow } from 'date-fns'
import toast from 'react-hot-toast'

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }) {
  return (
    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted px-1 mb-3">
      {title}
    </p>
  )
}

function SettingsCard({ children }) {
  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      {children}
    </div>
  )
}

function SettingsRow({ label, description, children, last }) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-3.5"
      style={!last ? { borderBottom: '1px solid rgba(255,255,255,0.05)' } : {}}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        {description && (
          <p className="text-xs text-text-muted mt-0.5">{description}</p>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ value, onChange }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
        value ? 'bg-brand-red' : 'bg-bg-elevated border border-border'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
          value ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function SegmentedControl({ value, options, onChange }) {
  return (
    <div
      className="flex rounded-lg overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,0.1)' }}
    >
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
            value === opt.value
              ? 'bg-brand-red text-white'
              : 'text-text-muted hover:text-text-primary'
          } ${i > 0 ? 'border-l border-border' : ''}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function SelectControl({ value, options, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs font-semibold text-text-primary rounded-lg px-2 py-1.5 outline-none cursor-pointer"
      style={{
        background: 'rgba(255,255,255,0.07)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Settings() {
  const fileInputRef = useRef(null)
  const [restoring, setRestoring] = useState(false)
  const queryClient = useQueryClient()
  const { settings, updateSettings, t } = useSettings()

  // Trainer name
  const [trainerName, setTrainerName] = useState('')
  const [trainerDirty, setTrainerDirty] = useState(false)
  const [geminiKey, setGeminiKey] = useState('')
  const [geminiDirty, setGeminiDirty] = useState(false)

  // Full sync interval (days) and price sync interval (minutes)
  const [fullSyncIntervalDays, setFullSyncIntervalDays] = useState('5')
  const [priceSyncIntervalMinutes, setPriceSyncIntervalMinutes] = useState('30')

  // Notification settings
  const [priceAlertsEnabled, setPriceAlertsEnabled] = useState(false)
  const [alertThreshold, setAlertThreshold] = useState('10')

  // Load individual settings from backend
  const { data: trainerData } = useQuery({
    queryKey: ['setting', 'trainer_name'],
    queryFn: () => getSetting('trainer_name').catch(() => ({ value: 'TRAINER' })),
  })

  const { data: fullSyncIntervalData } = useQuery({
    queryKey: ['setting', 'full_sync_interval_days'],
    queryFn: () => getSetting('full_sync_interval_days').catch(() => ({ value: '5' })),
  })

  const { data: priceSyncIntervalData } = useQuery({
    queryKey: ['setting', 'price_sync_interval_minutes'],
    queryFn: () => getSetting('price_sync_interval_minutes').catch(() => ({ value: '30' })),
  })

  const { data: priceAlertsData } = useQuery({
    queryKey: ['setting', 'price_alerts_enabled'],
    queryFn: () => getSetting('price_alerts_enabled').catch(() => ({ value: 'false' })),
  })

  const { data: alertThresholdData } = useQuery({
    queryKey: ['setting', 'price_alert_threshold'],
    queryFn: () => getSetting('price_alert_threshold').catch(() => ({ value: '10' })),
  })

  const { data: geminiKeyData } = useQuery({
    queryKey: ['setting', 'gemini_api_key'],
    queryFn: () => getSetting('gemini_api_key').catch(() => ({ value: '' })),
  })

  const [ebayAppId, setEbayAppId] = useState('')
  const [ebayDirty, setEbayDirty] = useState(false)

  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramBotTokenDirty, setTelegramBotTokenDirty] = useState(false)
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramChatIdDirty, setTelegramChatIdDirty] = useState(false)

  const { data: ebayAppIdData } = useQuery({
    queryKey: ['setting', 'ebay_app_id'],
    queryFn: () => getSetting('ebay_app_id').catch(() => ({ value: '' })),
  })

  const { data: telegramBotTokenData } = useQuery({
    queryKey: ['setting', 'telegram_bot_token'],
    queryFn: () => getSetting('telegram_bot_token').catch(() => ({ value: '' })),
  })

  const { data: telegramChatIdData } = useQuery({
    queryKey: ['setting', 'telegram_chat_id'],
    queryFn: () => getSetting('telegram_chat_id').catch(() => ({ value: '' })),
  })

  const { data: telegramStatus } = useQuery({
    queryKey: ['telegram-status'],
    queryFn: () => getTelegramStatus().catch(() => ({ configured: false })),
  })

  const { data: syncStatus } = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus().then((r) => r.data),
    refetchInterval: 10000,
  })

  // Sync fetched data → local state
  useEffect(() => {
    if (trainerData?.value !== undefined && !trainerDirty) {
      setTrainerName(trainerData.value)
    }
  }, [trainerData])

  useEffect(() => {
    if (fullSyncIntervalData?.value) setFullSyncIntervalDays(fullSyncIntervalData.value)
  }, [fullSyncIntervalData])

  useEffect(() => {
    if (priceSyncIntervalData?.value) setPriceSyncIntervalMinutes(priceSyncIntervalData.value)
  }, [priceSyncIntervalData])

  useEffect(() => {
    if (priceAlertsData?.value) setPriceAlertsEnabled(priceAlertsData.value === 'true')
  }, [priceAlertsData])

  useEffect(() => {
    if (alertThresholdData?.value) setAlertThreshold(alertThresholdData.value)
  }, [alertThresholdData])

  useEffect(() => {
    if (geminiKeyData?.value !== undefined && !geminiDirty) setGeminiKey(geminiKeyData.value)
  }, [geminiKeyData])

  useEffect(() => {
    if (ebayAppIdData?.value !== undefined && !ebayDirty) setEbayAppId(ebayAppIdData.value)
  }, [ebayAppIdData])

  useEffect(() => {
    if (telegramBotTokenData?.value !== undefined && !telegramBotTokenDirty) setTelegramBotToken(telegramBotTokenData.value)
  }, [telegramBotTokenData])

  useEffect(() => {
    if (telegramChatIdData?.value !== undefined && !telegramChatIdDirty) setTelegramChatId(telegramChatIdData.value)
  }, [telegramChatIdData])

  // Sync mutation (full)
  const syncMutation = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 5000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  // Price sync mutation
  const priceSyncMutation = useMutation({
    mutationFn: triggerPriceSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 3000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  const isRunning = syncStatus?.is_running || syncMutation.isPending
  const isPriceSyncRunning = syncStatus?.is_price_sync_running || priceSyncMutation.isPending

  // Save helper
  const saveSetting = async (key, value) => {
    try {
      await setSetting(key, value)
      queryClient.invalidateQueries({ queryKey: ['setting', key] })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleSaveTrainerName = async () => {
    await saveSetting('trainer_name', trainerName)
    queryClient.invalidateQueries({ queryKey: ['setting', 'trainer_name'] })
    setTrainerDirty(false)
  }

  const handleFullSyncIntervalChange = async (val) => {
    setFullSyncIntervalDays(val)
    await saveSetting('full_sync_interval_days', val)
    try { await rescheduleFullSync(parseInt(val)) } catch {}
  }

  const handlePriceSyncIntervalChange = async (val) => {
    setPriceSyncIntervalMinutes(val)
    await saveSetting('price_sync_interval_minutes', val)
    try { await reschedulePriceSync(parseInt(val)) } catch {}
  }

  const handlePriceAlertsToggle = async (val) => {
    setPriceAlertsEnabled(val)
    await saveSetting('price_alerts_enabled', val ? 'true' : 'false')
  }

  const handleAlertThresholdBlur = async () => {
    await saveSetting('price_alert_threshold', alertThreshold)
  }

  const handleLanguageChange = async (lang) => {
    try {
      await updateSettings({ language: lang })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleCurrencyChange = async (val) => {
    try {
      await updateSettings({ currency: val })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handlePriceTypeChange = async (val) => {
    try {
      await updateSettings({ price_primary: val })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleRestoreUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.sql')) {
      toast.error(t('settings.selectSql'))
      return
    }
    if (!confirm(t('settings.restoreConfirm'))) return

    setRestoring(true)
    try {
      await restoreBackup(file)
      toast.success(t('settings.restoreSuccess'))
      queryClient.invalidateQueries()
    } catch (err) {
      toast.error(t('settings.errorPrefix') + (err.response?.data?.detail || err.message))
    } finally {
      setRestoring(false)
    }
  }

  const currentLang = settings.language || 'de'
  const currentCurrency = settings.currency || 'EUR'
  const currentPriceType = settings.price_primary || 'trend'

  const lastSyncText = syncStatus?.last_sync?.finished_at
    ? formatDistanceToNow(new Date(syncStatus.last_sync.finished_at), { addSuffix: true })
    : t('settings.neverSynced')

  return (
    <div className="space-y-6 py-6">
      <div className="px-1">
        <h1 className="text-2xl font-black text-text-primary tracking-tight">{t('settings.title')}</h1>
        <p className="text-sm text-text-muted mt-1">{t('settings.appConfig')}</p>
      </div>

      {/* ── 1. TRAINER ── */}
      <section className="space-y-1">
        <SectionHeader title={t('settings.sectionTrainer')} />
        <SettingsCard>
          <SettingsRow
            label={t('settings.trainerName')}
            description={t('settings.trainerNameDesc')}
            last
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={trainerName}
                onChange={(e) => {
                  setTrainerName(e.target.value)
                  setTrainerDirty(true)
                }}
                onBlur={() => { if (trainerDirty) handleSaveTrainerName() }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTrainerName() }}
                placeholder="TRAINER"
                className="text-xs font-semibold text-text-primary rounded-lg px-3 py-1.5 outline-none w-32 text-right"
                style={{
                  background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              />
              {trainerDirty && (
                <button
                  onClick={handleSaveTrainerName}
                  className="text-xs font-semibold text-brand-red hover:opacity-80 transition-opacity"
                >
                  {t('common.save')}
                </button>
              )}
            </div>
          </SettingsRow>
        </SettingsCard>
      </section>

      {/* ── 2. DARSTELLUNG ── */}
      <section className="space-y-1">
        <SectionHeader title={t('settings.sectionAppearance')} />
        <SettingsCard>
          <SettingsRow label={t('settings.language')} description={t('settings.languageDesc')}>
            <SegmentedControl
              value={currentLang}
              options={[
                { value: 'de', label: '🇩🇪 DE' },
                { value: 'en', label: '🇬🇧 EN' },
              ]}
              onChange={handleLanguageChange}
            />
          </SettingsRow>
          <SettingsRow label={t('settings.currency')} description={t('settings.currencyDesc')}>
            <SelectControl
              value={currentCurrency}
              options={[
                { value: 'EUR', label: '€ EUR' },
                { value: 'USD', label: '$ USD' },
              ]}
              onChange={handleCurrencyChange}
            />
          </SettingsRow>
          <SettingsRow label={t('settings.priceType')} description={t('settings.priceTypeDesc')} last>
            <SelectControl
              value={currentPriceType}
              options={[
                { value: 'trend', label: t('settings.priceTrend') },
                { value: 'avg1', label: t('settings.priceAvg1') },
                { value: 'avg7', label: t('settings.priceAvg7') },
                { value: 'avg30', label: t('settings.priceAvg30') },
                { value: 'low', label: t('settings.priceLow') },
              ]}
              onChange={handlePriceTypeChange}
            />
          </SettingsRow>
        </SettingsCard>
      </section>

      {/* ── 3. SYNCHRONISATION ── */}
      <section className="space-y-1">