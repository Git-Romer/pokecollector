import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { useSettings } from './SettingsContext'

const ConfirmDialogContext = createContext(null)

export function ConfirmDialogProvider({ children }) {
  const { t } = useSettings()
  const [request, setRequest] = useState(null)
  const resolveRef = useRef(null)

  const confirm = useCallback((options) => new Promise(resolve => {
    resolveRef.current?.(false)
    resolveRef.current = resolve
    setRequest(options)
  }), [])

  const close = useCallback((confirmed) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setRequest(null)
    resolve?.(Boolean(confirmed))
  }, [])

  const value = useMemo(() => confirm, [confirm])

  return (
    <ConfirmDialogContext.Provider value={value}>
      {children}
      <ConfirmDialog
        isOpen={Boolean(request)}
        onClose={() => close(false)}
        onConfirm={() => close(true)}
        title={request?.title || request?.confirmLabel || t('common.delete')}
        message={request?.message || ''}
        confirmLabel={request?.confirmLabel || t('common.delete')}
        cancelLabel={request?.cancelLabel || t('common.cancel')}
        destructive={request?.destructive ?? true}
      />
    </ConfirmDialogContext.Provider>
  )
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext)
  if (!confirm) throw new Error('useConfirmDialog must be used within ConfirmDialogProvider')
  return confirm
}
