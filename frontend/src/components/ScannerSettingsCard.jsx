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
    setApiKey('')
    setClearApiKey(false)
    setTestStatus('not_tested')
  }, [data, dirty])

  const chooseProvider = (nextProvider) => {
    const next = data.providers.find(item => item.id === nextProvider)
    setProvider(nextProvider)
    setModel(next.selected_model || next.default_model)
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

  const payload = () => ({
    provider,
    model,
    api_key: apiKey || null,
    clear_api_key: clearApiKey,
  })

  const save = async () => {
    setSaving(true)
    try {
      await updateScannerConfiguration(payload())
      await queryClient.invalidateQueries({ queryKey: ['scanner-configuration'] })
      setDirty(false)
      setApiKey('')
      setClearApiKey(false)
      toast.success(t('settings.scannerSaved'))
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      await testScannerConfiguration(payload())
      setTestStatus('passed')
      toast.success(t('settings.scannerTestPassed'))
    } catch (error) {
      setTestStatus('failed')
      toast.error(error?.response?.data?.detail || t('settings.scannerTestFailed'))
    } finally {
      setTesting(false)
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

        {selected.models.length > 1 && (
          <label className="block">
            <span className="text-xs font-semibold text-text-primary">{t('settings.scannerModel')}</span>
            <select
              value={model}
              onChange={event => changeDraft(() => setModel(event.target.value))}
              className="select mt-1.5 w-full text-xs font-semibold"
            >
              {selected.models.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <span className="block text-[11px] text-text-muted mt-1">{t('settings.scannerModelManaged')}</span>
          </label>
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
          <button type="button" onClick={test} disabled={busy || !model || !hasUsableKey} className="btn-ghost px-3 py-2 text-xs disabled:opacity-50">
            {testing ? t('settings.scannerTesting') : t('settings.scannerTest')}
          </button>
          <button type="button" onClick={save} disabled={busy || !model || !dirty} className="btn-primary-sm disabled:opacity-50">
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>

        {data.administrator && (
          <div className="rounded-xl p-3 space-y-3" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-text-primary">{t('settings.scannerAdminSummary')}</p>
                <p className="text-[11px] text-text-muted mt-0.5">{t('settings.scannerAdminSummaryDesc')}</p>
              </div>
              <a href={data.administrator.setup_guide_url} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-brand-yellow hover:underline">
                {t('settings.scannerAdminGuide')} ↗
              </a>
            </div>
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
        )}
      </div>
    </div>
  )
}
