import { useState } from 'react'
import { Download } from 'lucide-react'
import toast from 'react-hot-toast'
import { exportDeckAllocationCsv, getApiErrorMessage } from '../../api/client'
import { useSettings } from '../../contexts/SettingsContext'

const filenameFrom = header => header?.match(/filename="?([^";]+)"?/i)?.[1]

export default function InventoryExportMenu() {
  const { t } = useSettings()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(null)
  const download = async nextMode => {
    if (mode) return
    setMode(nextMode)
    try {
      const response = await exportDeckAllocationCsv(nextMode)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(response.data)
      link.download = filenameFrom(response.headers?.['content-disposition']) || `pokecollector-${nextMode}-inventory.csv`
      link.click()
      URL.revokeObjectURL(link.href)
      setOpen(false)
    } catch (error) {
      toast.error(getApiErrorMessage(error, t('decks.inventoryExportFailed')))
    } finally {
      setMode(null)
    }
  }
  const options = [['all', t('decks.inventoryExportAll')], ['free', t('decks.inventoryExportFree')], ['conflicts', t('decks.inventoryExportConflicts')]]
  return <div className="relative"><button className="btn-secondary" onClick={() => setOpen(value => !value)} disabled={Boolean(mode)} aria-expanded={open} aria-haspopup="menu"><Download size={16} /> {mode ? t('decks.inventoryExporting') : t('decks.inventoryExport')}</button>{open && <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-border bg-bg-card p-1 shadow-lg">{options.map(([value, text]) => <button key={value} role="menuitem" className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-bg-elevated disabled:opacity-50" disabled={Boolean(mode)} onClick={() => download(value)}>{text}</button>)}</div>}</div>
}
