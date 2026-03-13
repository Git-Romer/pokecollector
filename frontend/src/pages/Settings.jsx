import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Download, Upload, Plus, Pencil, Trash2, UserCheck, UserX } from 'lucide-react'
import {
  getSyncStatus, triggerSync, triggerPriceSync, rescheduleFullSync, reschedulePriceSync,
  downloadBackup, restoreBackup, exportCSV,
  getSetting, setSetting, getTelegramStatus, saveSettings,
  getUsers, createUser, updateUser, deleteUser, changePassword,
} from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import Modal from '../components/ui/Modal'
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
  const { user } = useAuth()
  const { settings, updateSettings, t } = useSettings()
  const [activeTab, setActiveTab] = useState('general')

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
      <div className="flex gap-1 border-b border-border px-1 overflow-x-auto">
        {[
          { key: 'general', label: t('settings.tabs.general') },
          { key: 'sync', label: t('settings.tabs.dataSync') },
          { key: 'notifications', label: t('settings.tabs.notifications') },
          ...(user?.role === 'admin' ? [{ key: 'users', label: t('settings.tabs.users') }] : []),
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors border-b-2 ${
              activeTab === tab.key ? 'border-brand-red text-brand-red' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'general' && (
        <>
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

          {/* ── 6. KI / KARTEN-SCANNER ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionAI')} />
            <SettingsCard>
              <SettingsRow label={t('settings.geminiApiKey')} description={t('settings.geminiApiKeyDesc')} last>
                <div className="flex items-center gap-2 w-full mt-2">
                  <input
                    type="password"
                    value={geminiKey}
                    onChange={e => { setGeminiKey(e.target.value); setGeminiDirty(true) }}
                    placeholder="AIza..."
                    className="input flex-1 text-xs font-mono"
                    style={{ minWidth: 0 }}
                  />
                  {geminiDirty && (
                    <button
                      onClick={async () => {
                        await saveSetting('gemini_api_key', geminiKey)
                        setGeminiDirty(false)
                        queryClient.invalidateQueries({ queryKey: ['setting', 'gemini_api_key'] })
                        toast.success(t('settings.apiKeySaved'))
                      }}
                      className="btn-primary-sm flex-shrink-0"
                    >
                      {t('common.save')}
                    </button>
                  )}
                </div>
              </SettingsRow>
            </SettingsCard>
          </section>

          {/* ── 7. EBAY API ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionEbay')} />
            <SettingsCard>
              <SettingsRow
                label={t('settings.ebayAppId')}
                description={t('settings.ebayAppIdDesc')}
                last
              >
                <div className="flex flex-col items-end gap-2 w-full">
                  <div className="flex items-center gap-2 w-full justify-end">
                    <input
                      type="password"
                      value={ebayAppId}
                      onChange={e => { setEbayAppId(e.target.value); setEbayDirty(true) }}
                      placeholder="YourApp-abc12-34def-56789-gh0ij"
                      className="input flex-1 text-xs font-mono"
                      style={{ minWidth: 0, maxWidth: 220 }}
                    />
                    {ebayDirty && (
                      <button
                        onClick={async () => {
                          await saveSetting('ebay_app_id', ebayAppId)
                          setEbayDirty(false)
                          queryClient.invalidateQueries({ queryKey: ['setting', 'ebay_app_id'] })
                          toast.success(t('settings.apiKeySaved'))
                        }}
                        className="btn-primary-sm flex-shrink-0"
                      >
                        {t('common.save')}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {ebayAppId && ebayAppId.trim() ? (
                      <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                        style={{ background: 'rgba(102,187,106,0.15)', color: '#66bb6a', border: '1px solid rgba(102,187,106,0.3)' }}>
                        ✅ {t('settings.ebayConfigured')}
                      </span>
                    ) : (
                      <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                        style={{ background: 'rgba(255,152,0,0.15)', color: '#ff9800', border: '1px solid rgba(255,152,0,0.3)' }}>
                        ⚠️ {t('settings.ebayNotConfigured')}
                      </span>
                    )}
                    <a
                      href="https://developer.ebay.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-semibold text-brand-red hover:opacity-80 transition-opacity"
                    >
                      developer.ebay.com ↗
                    </a>
                  </div>
                </div>
              </SettingsRow>
            </SettingsCard>
          </section>

          {/* ── 8. ÜBER DIE APP ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionAbout')} />
            <SettingsCard>
              <SettingsRow label={t('settings.app')} description="Pokemon TCG Collection">
                <span className="text-xs font-bold text-text-muted px-2 py-1 rounded-lg"
                  style={{ background: 'rgba(255,255,255,0.05)' }}>
                  v38.0
                </span>
              </SettingsRow>
              <SettingsRow label={t('settings.dataSource')} description={t('settings.dataSourceDesc')} last>
                <a
                  href="https://tcgdex.net"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-brand-red hover:opacity-80 transition-opacity"
                >
                  TCGdex ↗
                </a>
              </SettingsRow>
            </SettingsCard>
          </section>
        </>
      )}

      {activeTab === 'sync' && (
        <>
          {/* ── 3. SYNCHRONISATION ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionSync')} />

            {/* Card 1: Full Sync */}
            <SettingsCard>
              <SettingsRow label={t('settings.syncSetsCards')} description={lastSyncText}>
                <button
                  onClick={() => syncMutation.mutate()}
                  disabled={isRunning}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: 'rgba(227,0,11,0.15)', color: '#e3000b', border: '1px solid rgba(227,0,11,0.3)' }}
                >
                  <RefreshCw size={13} className={isRunning ? 'animate-spin' : ''} />
                  {isRunning ? t('settings.running') : t('settings.syncButton')}
                </button>
              </SettingsRow>
              <SettingsRow label={t('settings.interval')} description={t('settings.syncSetsCardsDesc')} last>
                <SelectControl
                  value={fullSyncIntervalDays}
                  options={[
                    { value: '1',  label: t('settings.day1') },
                    { value: '2',  label: t('settings.days2') },
                    { value: '3',  label: t('settings.days3') },
                    { value: '5',  label: t('settings.days5') },
                    { value: '7',  label: t('settings.days7') },
                    { value: '14', label: t('settings.days14') },
                    { value: '30', label: t('settings.days30') },
                  ]}
                  onChange={handleFullSyncIntervalChange}
                />
              </SettingsRow>
            </SettingsCard>

            {/* Card 2: Price Sync */}
            <SettingsCard>
              <SettingsRow label={t('settings.syncPricesOnly')} description={lastSyncText}>
                <button
                  onClick={() => priceSyncMutation.mutate()}
                  disabled={isPriceSyncRunning}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: 'rgba(227,0,11,0.15)', color: '#e3000b', border: '1px solid rgba(227,0,11,0.3)' }}
                >
                  <RefreshCw size={13} className={isPriceSyncRunning ? 'animate-spin' : ''} />
                  {isPriceSyncRunning ? t('settings.running') : t('settings.syncButton')}
                </button>
              </SettingsRow>
              <SettingsRow label={t('settings.priceInterval')} description={t('settings.syncPricesOnlyDesc')} last>
                <SelectControl
                  value={priceSyncIntervalMinutes}
                  options={[
                    { value: '60',   label: t('settings.min60') },
                    { value: '120',  label: t('settings.min120') },
                    { value: '180',  label: t('settings.min180') },
                    { value: '360',  label: t('settings.min360') },
                    { value: '720',  label: t('settings.min720') },
                    { value: '1440', label: t('settings.min1440') },
                  ]}
                  onChange={handlePriceSyncIntervalChange}
                />
              </SettingsRow>
            </SettingsCard>
          </section>

          {/* ── 5. DATEN ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionData')} />
            <SettingsCard>
              <SettingsRow label={t('settings.csvExport')} description={t('settings.csvExportDesc')}>
                <button
                  onClick={exportCSV}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity"
                  style={{ background: 'rgba(255,255,255,0.07)', color: '#90a4ae', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  <Download size={13} /> {t('settings.exportButton')}
                </button>
              </SettingsRow>
              <SettingsRow label={t('settings.backupDownload')} description={t('settings.backupDownloadDesc')}>
                <button
                  onClick={downloadBackup}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity"
                  style={{ background: 'rgba(255,255,255,0.07)', color: '#90a4ae', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  <Download size={13} /> {t('settings.backupButton')}
                </button>
              </SettingsRow>
              <SettingsRow label={t('settings.backupImport')} description={t('settings.backupImportDesc')} last>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={restoring}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: 'rgba(255,255,255,0.07)', color: '#90a4ae', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  <Upload size={13} /> {restoring ? t('settings.importing') : t('settings.importButton')}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".sql"
                  className="hidden"
                  onChange={handleRestoreUpload}
                />
              </SettingsRow>
            </SettingsCard>
          </section>
        </>
      )}

      {activeTab === 'notifications' && (
        <>
          {/* ── 4. BENACHRICHTIGUNGEN ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionNotifications')} />
            <SettingsCard>
              <SettingsRow
                label={t('settings.telegramBot')}
                description={t('settings.telegramBotDesc')}
              >
                {telegramStatus?.configured ? (
                  <span
                    className="text-xs font-bold px-2.5 py-1 rounded-full"
                    style={{ background: 'rgba(102,187,106,0.15)', color: '#66bb6a', border: '1px solid rgba(102,187,106,0.3)' }}
                  >
                    {t('settings.telegramConfigured')}
                  </span>
                ) : (
                  <span
                    className="text-xs font-bold px-2.5 py-1 rounded-full"
                    style={{ background: 'rgba(227,0,11,0.1)', color: '#e3000b', border: '1px solid rgba(227,0,11,0.25)' }}
                  >
                    {t('settings.telegramNotConfigured')}
                  </span>
                )}
              </SettingsRow>
              <SettingsRow label={t('settings.telegramBotToken')} description={t('settings.telegramBotTokenDesc')}>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={telegramBotToken}
                    onChange={e => { setTelegramBotToken(e.target.value); setTelegramBotTokenDirty(true) }}
                    placeholder="1234567890:AAF..."
                    className="input text-xs font-mono"
                    style={{ minWidth: 0, width: 180 }}
                  />
                  {telegramBotTokenDirty && (
                    <button
                      onClick={async () => {
                        await saveSetting('telegram_bot_token', telegramBotToken)
                        setTelegramBotTokenDirty(false)
                        queryClient.invalidateQueries({ queryKey: ['setting', 'telegram_bot_token'] })
                        queryClient.invalidateQueries({ queryKey: ['telegram-status'] })
                        toast.success(t('settings.apiKeySaved'))
                      }}
                      className="btn-primary-sm flex-shrink-0"
                    >
                      {t('common.save')}
                    </button>
                  )}
                </div>
              </SettingsRow>
              <SettingsRow label={t('settings.telegramChatId')} description={t('settings.telegramChatIdDesc')}>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={telegramChatId}
                    onChange={e => { setTelegramChatId(e.target.value); setTelegramChatIdDirty(true) }}
                    placeholder="-100123456789"
                    className="input text-xs font-mono"
                    style={{ minWidth: 0, width: 140 }}
                  />
                  {telegramChatIdDirty && (
                    <button
                      onClick={async () => {
                        await saveSetting('telegram_chat_id', telegramChatId)
                        setTelegramChatIdDirty(false)
                        queryClient.invalidateQueries({ queryKey: ['setting', 'telegram_chat_id'] })
                        queryClient.invalidateQueries({ queryKey: ['telegram-status'] })
                        toast.success(t('settings.apiKeySaved'))
                      }}
                      className="btn-primary-sm flex-shrink-0"
                    >
                      {t('common.save')}
                    </button>
                  )}
                </div>
              </SettingsRow>
              <SettingsRow
                label={t('settings.priceAlerts')}
                description={t('settings.priceAlertsDesc')}
              >
                <Toggle value={priceAlertsEnabled} onChange={handlePriceAlertsToggle} />
              </SettingsRow>
              {priceAlertsEnabled && (
                <SettingsRow
                  label={t('settings.threshold')}
                  description={t('settings.thresholdDesc')}
                  last
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={alertThreshold}
                      onChange={(e) => setAlertThreshold(e.target.value)}
                      onBlur={handleAlertThresholdBlur}
                      min="1"
                      max="100"
                      className="text-xs font-semibold text-text-primary rounded-lg px-3 py-1.5 outline-none w-16 text-right"
                      style={{
                        background: 'rgba(255,255,255,0.07)',
                        border: '1px solid rgba(255,255,255,0.1)',
                      }}
                    />
                    <span className="text-xs text-text-muted">%</span>
                  </div>
                </SettingsRow>
              )}
              {!priceAlertsEnabled && <div style={{ height: 0 }} />}
            </SettingsCard>
          </section>
        </>
      )}

      {activeTab === 'users' && user?.role === 'admin' && (
        <UsersTab t={t} queryClient={queryClient} />
      )}
    </div>
  )
}

function UsersTab({ t, queryClient }) {
  const [showModal, setShowModal] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [formUsername, setFormUsername] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [formRole, setFormRole] = useState('trainer')
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const { user: currentUser } = useAuth()

  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers })

  const createMut = useMutation({
    mutationFn: (data) => createUser(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success(t('settings.users.userCreated')); setShowModal(false) },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => updateUser(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success(t('settings.users.userUpdated')); setShowModal(false); setEditingUser(null) },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })
  const deleteMut = useMutation({
    mutationFn: (id) => deleteUser(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success(t('settings.users.userDeleted')) },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })
  const changePwMut = useMutation({
    mutationFn: (data) => changePassword(data),
    onSuccess: () => { toast.success(t('settings.users.passwordChanged')); setCurrentPw(''); setNewPw('') },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })

  const openCreate = () => { setEditingUser(null); setFormUsername(''); setFormPassword(''); setFormRole('trainer'); setShowModal(true) }
  const openEdit = (u) => { setEditingUser(u); setFormUsername(u.username); setFormPassword(''); setFormRole(u.role); setShowModal(true) }
  const handleSubmit = (e) => {
    e.preventDefault()
    if (editingUser) {
      const data = {}
      if (formUsername !== editingUser.username) data.username = formUsername
      if (formPassword) data.password = formPassword
      if (formRole !== editingUser.role) data.role = formRole
      updateMut.mutate({ id: editingUser.id, data })
    } else {
      createMut.mutate({ username: formUsername, password: formPassword, role: formRole })
    }
  }

  return (
    <>
      <section className="space-y-1">
        <div className="flex items-center justify-between px-1 mb-3">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">{t('settings.users.title')}</p>
          <button onClick={openCreate} className="flex items-center gap-1 text-xs font-semibold text-brand-red hover:text-brand-red/80">
            <Plus size={14} /> {t('settings.users.addUser')}
          </button>
        </div>
        <SettingsCard>
          {users.map((u, i) => (
            <SettingsRow key={u.id} label={u.username} description={`${u.role} · ${u.is_active ? t('settings.users.active') : t('settings.users.inactive')}`} last={i === users.length - 1}>
              <div className="flex items-center gap-2">
                <button onClick={() => updateMut.mutate({ id: u.id, data: { is_active: !u.is_active } })} className="text-text-muted hover:text-text-primary" title={u.is_active ? 'Deactivate' : 'Activate'}>
                  {u.is_active ? <UserCheck size={15} /> : <UserX size={15} />}
                </button>
                <button onClick={() => openEdit(u)} className="text-text-muted hover:text-text-primary"><Pencil size={15} /></button>
                {u.id !== currentUser?.id && (
                  <button onClick={() => { if (window.confirm(t('settings.users.deleteConfirm'))) deleteMut.mutate(u.id) }} className="text-text-muted hover:text-brand-red"><Trash2 size={15} /></button>
                )}
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      </section>

      <section className="space-y-1">
        <SectionHeader title={t('settings.users.changePassword')} />
        <SettingsCard>
          <div className="px-4 py-3 space-y-3">
            <input type="password" placeholder={t('settings.users.currentPassword')} value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="input w-full" />
            <input type="password" placeholder={t('settings.users.newPassword')} value={newPw} onChange={(e) => setNewPw(e.target.value)} className="input w-full" />
            <button onClick={() => changePwMut.mutate({ current_password: currentPw, new_password: newPw })} disabled={!currentPw || !newPw || changePwMut.isPending} className="btn-primary text-sm">
              {t('settings.users.changePassword')}
            </button>
          </div>
        </SettingsCard>
      </section>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editingUser ? t('common.edit') : t('settings.users.addUser')} size="sm">
        <form onSubmit={handleSubmit} className="space-y-4 p-4">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.username')}</label>
            <input type="text" value={formUsername} onChange={(e) => setFormUsername(e.target.value)} className="input w-full" required />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.password')}{editingUser && ' (leave blank to keep)'}</label>
            <input type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} className="input w-full" {...(!editingUser && { required: true })} />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.role')}</label>
            <select value={formRole} onChange={(e) => setFormRole(e.target.value)} className="input w-full">
              <option value="trainer">{t('settings.users.trainer')}</option>
              <option value="admin">{t('settings.users.admin')}</option>
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="btn-ghost flex-1">{t('common.cancel')}</button>
            <button type="submit" disabled={createMut.isPending || updateMut.isPending} className="btn-primary flex-1">
              {editingUser ? t('common.save') : t('settings.users.addUser')}
            </button>
          </div>
        </form>
      </Modal>
    </>
  )
}
