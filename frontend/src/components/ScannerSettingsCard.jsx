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
  }, [data, dirty])

  const chooseProvider = (nextProvider) => {
    const next = data.providers.find(item => item.id === nextProvider)
    setProvider(nextProvider)
    setModel(next.selected_model || next.default_model)
    setApiKey('')
    setClearApiKey(false)
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
      toast.success(t('settings.scannerTestPassed'))
    } catch (error) {
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

        <label className="block">
          <span className="text-xs font-semibold text-text-primary">{t('settings.scannerModel')}</span>
          <select
            value={model}
            onChange={event => { setModel(event.target.value); setDirty(true) }}
            className="select mt-1.5 w-full text-xs font-semibold"
            disabled={selected.models.length === 1}
          >
            {selected.models.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
          <span className="block text-[11px] text-text-muted mt-1">{t('settings.scannerModelManaged')}</span>
        </label>

        {selected.requires_api_key && (
          <label className="block">
            <span className="text-xs font-semibold text-text-primary">{t('settings.scannerApiKey')}</span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={event => { setApiKey(event.target.value); setClearApiKey(false); setDirty(true) }}
              placeholder={selected.api_key_configured && !clearApiKey ? t('settings.scannerKeyConfigured') : t('settings.scannerKeyPlaceholder')}
              className="input mt-1.5 w-full text-xs font-mono"
            />
            {selected.api_key_configured && (
              <button
                type="button"
                className="mt-1.5 text-[11px] text-brand-red"
                onClick={() => { setApiKey(''); setClearApiKey(true); setDirty(true) }}
              >
                {clearApiKey ? t('settings.scannerKeyWillBeRemoved') : t('settings.scannerRemoveKey')}
              </button>
            )}
          </label>
        )}

        <p className="text-[11px] text-text-muted">{t('settings.scannerSameFlow')}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={test} disabled={busy || !model || !hasUsableKey} className="btn-ghost px-3 py-2 text-xs disabled:opacity-50">
            {testing ? t('settings.scannerTesting') : t('settings.scannerTest')}
          </button>
          <button type="button" onClick={save} disabled={busy || !model || !dirty} className="btn-primary-sm disabled:opacity-50">
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
