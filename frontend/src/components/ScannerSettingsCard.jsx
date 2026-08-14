import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'

import {
  getScannerConfiguration,
  testScannerConfiguration,
  updateScannerConfiguration,
} from '../api/client'


export default function ScannerSettingsCard({ t }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['scanner-configuration'],
    queryFn: getScannerConfiguration,
  })
  const [provider, setProvider] = useState('gemini')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [usingCustomModel, setUsingCustomModel] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testStatus, setTestStatus] = useState('not_tested')

  const selected = useMemo(
    () => data?.providers?.find(item => item.id === provider),
    [data, provider],
  )

  useEffect(() => {
    if (!data || dirty) return
    setProvider(data.provider)
    setModel(data.model)
    const active = data.providers.find(item => item.id === data.provider)
    setUsingCustomModel(Boolean(active?.custom_model && active.custom_model === data.model))
    setApiKey('')
    setClearApiKey(false)
  }, [data, dirty])

  const chooseProvider = (nextProvider) => {
    const next = data.providers.find(item => item.id === nextProvider)
    setProvider(nextProvider)
    setModel(next.selected_model || next.default_model)
    setUsingCustomModel(Boolean(next.custom_model && next.custom_model === next.selected_model))
    setApiKey('')
    setClearApiKey(false)
    setTestStatus('not_tested')
    setDirty(true)
  }

  const changeDraft = (callback) => {
    callback()
    setTestStatus('not_tested')
    setDirty(true)
  }

  const payload = (saveOnSuccess = false) => ({
    provider,
    model,
    api_key: apiKey || null,
    clear_api_key: clearApiKey,
    custom_model: usingCustomModel,
    save_on_success: saveOnSuccess,
  })

  const persistDraft = async () => {
    await updateScannerConfiguration(payload(false))
    await queryClient.invalidateQueries({ queryKey: ['scanner-configuration'] })
    setDirty(false)
    setApiKey('')
    setClearApiKey(false)
    toast.success(t('settings.scannerSaved'))
  }

  const testAndSave = async () => {
    setTesting(true)
    try {
      try {
        await testScannerConfiguration(payload(dirty))
      } catch (error) {
        setTestStatus('failed')
        toast.error(error?.response?.data?.detail || t('settings.scannerTestFailed'))
        return
      }
      setTestStatus('passed')
      if (dirty) {
        try {
          await queryClient.invalidateQueries({ queryKey: ['scanner-configuration'] })
          setDirty(false)
          setApiKey('')
          setClearApiKey(false)
          toast.success(t('settings.scannerSaved'))
          setTestStatus('passed')
        } catch (error) {
          toast.error(error?.response?.data?.detail || t('settings.saveFailed'))
        }
      } else {
        toast.success(t('settings.scannerTestPassed'))
      }
    } finally {
      setTesting(false)
    }
  }

  const saveKeyRemoval = async () => {
    setSaving(true)
    try {
      await persistDraft()
      setTestStatus('not_tested')
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (isLoading) return <div className="px-4 py-5 text-xs text-text-muted">{t('common.loading')}</div>
  if (isError || !selected) return <div className="px-4 py-5 text-xs text-brand-red">{t('settings.scannerLoadFailed')}</div>

  const hasUsableKey = !selected.requires_api_key
    || (!clearApiKey && (Boolean(apiKey) || selected.api_key_configured))
  const status = selected.models.length
    ? (hasUsableKey ? 'ready' : 'api_key_required')
    : 'admin_setup_required'
  const busy = saving || testing

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="px-4 py-4 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-text-primary">{t('settings.scannerConfiguration')}</p>
            <p className="text-xs text-text-muted mt-1 max-w-2xl">{t('settings.scannerConfigurationDesc')}</p>
            {selected.setup_help_url && (
              <a href={selected.setup_help_url} target="_blank" rel="noreferrer" className="inline-block mt-1.5 text-[11px] font-semibold text-brand-yellow hover:underline">
                {t('settings.scannerSetupHelp')} ↗
              </a>
            )}
          </div>
          <span className={`self-start rounded-full px-2.5 py-1 text-[11px] font-bold ${status === 'ready' ? 'bg-green/15 text-green' : 'bg-brand-red/15 text-brand-red'}`}>
            {status === 'ready'
              ? t('settings.scannerReady')
              : status === 'api_key_required'
                ? t('settings.scannerKeyRequired')
                : t('settings.scannerAdminSetupRequired')}
          </span>
        </div>

        {data.providers.length > 1 && (
          <label className="block">
            <span className="text-xs font-semibold text-text-primary">{t('settings.scannerProvider')}</span>
            <select value={provider} onChange={event => chooseProvider(event.target.value)} className="select mt-1.5 w-full text-xs font-semibold">
              {data.providers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        )}

        <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <p className="text-xs font-semibold text-text-primary">{selected.label}</p>
          <p className="text-[11px] text-text-muted mt-1">
            {selected.endpoint_type === 'hosted'
              ? t('settings.scannerHostedProviderDesc')
              : t('settings.scannerCustomProviderDesc')}
          </p>
          <p className="text-[11px] text-text-muted mt-1">
            {selected.requires_api_key
              ? t('settings.scannerPersonalKeyRequired')
              : t('settings.scannerPersonalKeyNotRequired')}
          </p>
        </div>

        {!usingCustomModel && selected.models.length > 1 && (
          <label className="block">
            <span className="text-xs font-semibold text-text-primary">{t('settings.scannerModel')}</span>
            <select
              value={model}
              onChange={event => changeDraft(() => setModel(event.target.value))}
              className="select mt-1.5 w-full text-xs font-semibold"
            >
              {selected.models.map(item => (
                <option key={item} value={item}>
                  {item}{item === selected.default_model ? ` · ${t('settings.scannerRecommended')}` : ''}
                </option>
              ))}
            </select>
            <span className="block text-[11px] text-text-muted mt-1">{t('settings.scannerModelManaged')}</span>
          </label>
        )}

        {selected.custom_model_allowed && (
          <details className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <summary className="cursor-pointer text-xs font-semibold text-text-primary">
              {t('settings.scannerAdvancedModel')}
            </summary>
            <div className="pt-3 space-y-3">
              <p className="text-[11px] text-text-muted">{t('settings.scannerAdvancedModelDesc')}</p>
              <label className="flex items-center gap-2 text-xs text-text-primary">
                <input
                  type="checkbox"
                  checked={usingCustomModel}
                  onChange={event => changeDraft(() => {
                    const enabled = event.target.checked
                    setUsingCustomModel(enabled)
                    setModel(enabled ? (selected.custom_model || '') : selected.default_model)
                  })}
                />
                {t('settings.scannerUseCustomModel')}
              </label>
              {usingCustomModel && (
                <label className="block">
                  <span className="text-xs font-semibold text-text-primary">{t('settings.scannerModel')}</span>
                  <input
                    type="text"
                    autoComplete="off"
                    value={model}
                    onChange={event => changeDraft(() => setModel(event.target.value))}
                    className="input mt-1.5 w-full text-xs font-mono"
                  />
                </label>
              )}
            </div>
          </details>
        )}

        {selected.requires_api_key && (
          <div className="block">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="scanner-api-key" className="text-xs font-semibold text-text-primary">{t('settings.scannerApiKey')}</label>
              {selected.key_help_url && (
                <a href={selected.key_help_url} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-brand-yellow hover:underline">
                  {t('settings.scannerGetKey')} ↗
                </a>
              )}
            </div>
            <input
              id="scanner-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={event => changeDraft(() => { setApiKey(event.target.value); setClearApiKey(false) })}
              placeholder={selected.api_key_configured && !clearApiKey ? t('settings.scannerKeyConfigured') : t('settings.scannerKeyPlaceholder')}
              className="input mt-1.5 w-full text-xs font-mono"
            />
            {selected.api_key_configured && (
              <button
                type="button"
                className="mt-1.5 text-[11px] text-brand-red"
                onClick={() => changeDraft(() => { setApiKey(''); setClearApiKey(true) })}
              >
                {clearApiKey ? t('settings.scannerKeyWillBeRemoved') : t('settings.scannerRemoveKey')}
              </button>
            )}
          </div>
        )}

        <p className="text-[11px] text-text-muted">{t('settings.scannerSameFlow')}</p>
        <p className="text-[11px] text-text-muted">{t('settings.scannerTestDesc')}</p>
        {testStatus !== 'not_tested' && (
          <p role="status" className={`text-[11px] font-semibold ${testStatus === 'passed' ? 'text-green' : 'text-brand-red'}`}>
            {testStatus === 'passed' ? t('settings.scannerTestStatusPassed') : t('settings.scannerTestStatusFailed')}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={hasUsableKey ? testAndSave : saveKeyRemoval}
            disabled={busy || !model || (!hasUsableKey && !clearApiKey)}
            className="btn-primary-sm disabled:opacity-50"
          >
            {testing
              ? (dirty ? t('settings.scannerTestingAndSaving') : t('settings.scannerTesting'))
              : saving
                ? t('common.saving')
                : !hasUsableKey
                  ? (clearApiKey ? t('settings.scannerSaveChanges') : t('settings.scannerEnterKey'))
                  : dirty
                    ? t('settings.scannerTestAndSave')
                    : t('settings.scannerTest')}
          </button>
        </div>

        {data.administrator && (
          <details className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <summary className="cursor-pointer">
              <div>
                <p className="text-xs font-semibold text-text-primary">{t('settings.scannerAdminSummary')}</p>
                <p className="text-[11px] text-text-muted mt-0.5">{t('settings.scannerAdminSummaryDesc')}</p>
              </div>
            </summary>
            <div className="pt-3 space-y-3">
              <a href={data.administrator.setup_guide_url} target="_blank" rel="noreferrer" className="inline-block text-[11px] font-semibold text-brand-yellow hover:underline">
                {t('settings.scannerAdminGuide')} ↗
              </a>
              <div className="grid gap-2 sm:grid-cols-2">
                {data.administrator.providers.map(item => (
                  <div key={item.id} className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-text-primary break-words">{item.label}</p>
                      <span className={`shrink-0 text-[10px] font-bold ${item.enabled ? 'text-green' : 'text-text-muted'}`}>
                        {item.enabled ? t('settings.scannerProviderEnabled') : t('settings.scannerProviderDisabled')}
                      </span>
                    </div>
                    <p className="text-[11px] text-text-muted mt-1 break-all">
                      {item.endpoint_type === 'hosted' ? t('settings.scannerHostedEndpoint') : t('settings.scannerCustomEndpoint')} · {item.endpoint}
                    </p>
                    <p className="text-[11px] text-text-muted mt-1 break-words">
                      {t('settings.scannerApprovedModels')}: {item.models.join(', ') || t('settings.scannerNone')}
                    </p>
                    <p className="text-[11px] text-text-muted mt-1">
                      {item.requires_api_key ? t('settings.scannerPerUserKey') : t('settings.scannerNoUserKey')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  )
}
