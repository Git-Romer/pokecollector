import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Zap } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import toast from 'react-hot-toast'
import { getSyncStatus, triggerSync, triggerAllPriceSync, rescheduleFullSync, reschedulePriceSync, getSetting, setSetting, getCustomMatches } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'
import { SettingsCard, SettingsRow, SelectControl, Toggle } from '../ui/SettingsControls'
import { TCGDEX_LANGUAGES, normalizeTcgdexLanguageCsv, tcgdexLanguageLabel } from '../../utils/tcgdexLanguages'
import { invalidateTcgdexFilterLanguages } from '../../utils/queryInvalidation'

function TcgdexLanguageControl({ value, onChange, selectedLabel, fallbackNote }) {
  const selected = new Set(normalizeTcgdexLanguageCsv(value).split(','))

  const toggle = (lang) => {
    const next = new Set(selected)
    if (next.has(lang)) {
      if (next.size === 1) return
      next.delete(lang)
    } else {
      next.add(lang)
    }
    const normalized = TCGDEX_LANGUAGES
      .map((language) => language.code)
      .filter((code) => next.has(code))
      .join(',')
    onChange(normalized || 'en,de')
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {TCGDEX_LANGUAGES.map((language) => (
          <button
            key={language.code}
            type="button"
            onClick={() => toggle(language.code)}
            className={`px-2 py-1.5 rounded-lg text-xs font-semibold text-left transition-colors border ${
              selected.has(language.code)
                ? 'bg-brand-red text-white border-brand-red'
                : 'bg-bg-card text-text-muted border-border hover:text-text-primary'
            }`}
            title={language.name}
          >
            {tcgdexLanguageLabel(language.code)}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">
        {selected.size} {selectedLabel}. {fallbackNote}
      </p>
    </div>
  )
}

export default function ServerSyncSettings() {
  const { user } = useAuth()
  return user?.role === 'admin' ? <AdminServerSyncSettings user={user} /> : null
}

function AdminServerSyncSettings({ user }) {
  const { t, settings, updateSettings } = useSettings()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // Recurring automatic full sync interval (days) and small price sync interval (minutes).
  const [fullSyncIntervalDays, setFullSyncIntervalDays] = useState('5')
  const [priceSyncIntervalMinutes, setPriceSyncIntervalMinutes] = useState('30')

  const { data: fullSyncIntervalData } = useQuery({
    queryKey: ['setting', 'full_sync_interval_days'],
    queryFn: () => getSetting('full_sync_interval_days').catch(() => ({ value: '5' })),
  })

  const { data: priceSyncIntervalData } = useQuery({
    queryKey: ['setting', 'price_sync_interval_minutes'],
    queryFn: () => getSetting('price_sync_interval_minutes').catch(() => ({ value: '30' })),
  })

  const { data: syncStatus } = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus().then((r) => r.data),
    refetchInterval: 10000,
  })

  const { data: customMatches = [] } = useQuery({
    queryKey: ['custom-matches'],
    queryFn: () => getCustomMatches().then((r) => r.data),
    refetchInterval: 60000,
  })

  // Sync fetched data → local state
  useEffect(() => {
    if (fullSyncIntervalData?.value) setFullSyncIntervalDays(fullSyncIntervalData.value)
  }, [fullSyncIntervalData])

  useEffect(() => {
    if (priceSyncIntervalData?.value) setPriceSyncIntervalMinutes(priceSyncIntervalData.value)
  }, [priceSyncIntervalData])

  // Sync mutation (full)
  const syncMutation = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 5000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  // Forced price sync mutation (all tracked collection/wishlist/binder cards)
  const allPriceSyncMutation = useMutation({
    mutationFn: triggerAllPriceSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 5000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  const isRunning = syncStatus?.is_running || syncStatus?.is_price_sync_running || syncMutation.isPending || allPriceSyncMutation.isPending

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

  const handlePriceSyncIntervalChange = async (val) => {
    setPriceSyncIntervalMinutes(val)
    await saveSetting('price_sync_interval_minutes', val)
    try { await reschedulePriceSync(parseInt(val)) } catch {}
  }

  const handleFullSyncIntervalChange = async (val) => {
    setFullSyncIntervalDays(val)
    await saveSetting('full_sync_interval_days', val)
    try { await rescheduleFullSync(parseInt(val)) } catch {}
  }

  const handleTcgdexSyncLanguagesChange = async (val) => {
    try {
      await updateSettings({ tcgdex_sync_languages: normalizeTcgdexLanguageCsv(val) })
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleAdminBooleanSettingToggle = async (key, enabled) => {
    try {
      await updateSettings({ [key]: enabled ? 'true' : 'false' })
      if (key === 'tcgdex_digital_sets_enabled') {
        queryClient.invalidateQueries()
      }
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const currentTcgdexSyncLanguages = normalizeTcgdexLanguageCsv(settings.tcgdex_sync_languages || 'en,de')
  const digitalSetsEnabled = settings.tcgdex_digital_sets_enabled === 'true'
  const crossLanguagePriceFallback = settings.cross_language_price_fallback !== 'false'
  const crossLanguageImageFallback = settings.cross_language_image_fallback !== 'false'
  const lastFullSyncText = syncStatus?.last_full_sync?.finished_at
    ? formatDistanceToNow(new Date(syncStatus.last_full_sync.finished_at), { addSuffix: true })
    : t('settings.neverSynced')
  const lastFullSyncDescription = syncStatus?.last_full_sync?.status === 'error'
    ? `${t('settings.lastSyncFailed')} ${lastFullSyncText}${syncStatus.last_full_sync.error_message ? `: ${syncStatus.last_full_sync.error_message}` : ''}`
    : lastFullSyncText

  return (
          <section className="space-y-3" data-testid="server-sync-settings" aria-labelledby="server-sync-heading">
            <h2 id="server-sync-heading" className="text-sm font-semibold text-text-primary">{t('sync.serverTitle')}</h2>
            <p className="text-xs text-text-secondary">{t('sync.serverDescription')}</p>

            {/* Card 1: Full Sync */}
            <SettingsCard>
              <SettingsRow label={t('settings.syncSetsCards')} description={lastFullSyncDescription}>
                <button
                  type="button"
                  aria-label={t('settings.syncSetsCards')}
                  onClick={() => syncMutation.mutate()}
                  disabled={isRunning}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: 'rgba(227,0,11,0.15)', color: '#e3000b', border: '1px solid rgba(227,0,11,0.3)' }}
                >
                  <RefreshCw size={13} className={isRunning ? 'animate-spin' : ''} />
                  {isRunning ? t('settings.running') : t('settings.syncButton')}
                </button>
              </SettingsRow>
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.tcgdexSyncLanguages')} description={t('settings.tcgdexSyncLanguagesDesc')}>
                  <TcgdexLanguageControl
                    value={currentTcgdexSyncLanguages}
                    onChange={handleTcgdexSyncLanguagesChange}
                    selectedLabel={t('settings.tcgdexSyncLanguagesSelected')}
                    fallbackNote={t('settings.tcgdexSyncLanguagesFallbackNote')}
                  />
                </SettingsRow>
              )}
              {user?.role === 'admin' && (
                <>
                  <SettingsRow label={t('settings.digitalSets')} description={t('settings.digitalSetsDesc')}>
                    <Toggle
                      value={digitalSetsEnabled}
                      label={t('settings.digitalSets')}
                      onChange={(val) => handleAdminBooleanSettingToggle('tcgdex_digital_sets_enabled', val)}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('settings.crossLanguagePriceFallback')} description={t('settings.crossLanguagePriceFallbackDesc')}>
                    <Toggle
                      value={crossLanguagePriceFallback}
                      label={t('settings.crossLanguagePriceFallback')}
                      onChange={(val) => handleAdminBooleanSettingToggle('cross_language_price_fallback', val)}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('settings.crossLanguageImageFallback')} description={t('settings.crossLanguageImageFallbackDesc')}>
                    <Toggle
                      value={crossLanguageImageFallback}
                      label={t('settings.crossLanguageImageFallback')}
                      onChange={(val) => handleAdminBooleanSettingToggle('cross_language_image_fallback', val)}
                    />
                  </SettingsRow>
                </>
              )}
              {customMatches.length > 0 && (
                <SettingsRow label={t('migration.title')} description={`${customMatches.length} ${t('migration.pendingMatches')}`}>
                  <button
                    onClick={() => navigate('/migration')}
                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity"
                    style={{ background: 'rgba(245,200,66,0.15)', color: '#f5c842', border: '1px solid rgba(245,200,66,0.35)' }}
                  >
                    <Zap size={13} />
                    {t('migration.title')}
                  </button>
                </SettingsRow>
              )}
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.interval')} description={t('settings.syncSetsCardsDesc')} last>
                  <SelectControl
                    label={t('settings.interval')}
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
              )}
            </SettingsCard>

            {/* Card 2: Price Sync */}
            <SettingsCard>
              <SettingsRow label={t('settings.syncPricesOnly')} description={t('settings.syncPricesOnlyDesc')}>
                <button
                  type="button"
                  aria-label={t('settings.syncPricesOnly')}
                  onClick={() => allPriceSyncMutation.mutate()}
                  disabled={isRunning}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: 'rgba(227,0,11,0.15)', color: '#e3000b', border: '1px solid rgba(227,0,11,0.3)' }}
                >
                  <RefreshCw size={13} className={isRunning ? 'animate-spin' : ''} />
                  {isRunning ? t('settings.running') : t('settings.syncButton')}
                </button>
              </SettingsRow>
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.priceInterval')} description={t('settings.autoSmallSyncDesc')} last>
                  <SelectControl
                    label={t('settings.priceInterval')}
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
              )}
            </SettingsCard>
          </section>
  )
}
