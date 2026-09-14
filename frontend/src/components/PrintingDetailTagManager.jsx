import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  deletePrintingDetailTag,
  getPrintingDetailTags,
  updatePrintingDetailTag,
} from '../api/client'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { useSettings } from '../contexts/SettingsContext'
import Modal from './ui/Modal'

export default function PrintingDetailTagManager({ isOpen, onClose }) {
  const { t } = useSettings()
  const confirm = useConfirmDialog()
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState(null)
  const [name, setName] = useState('')
  const { data: tagData = [] } = useQuery({
    queryKey: ['printing-detail-tags'],
    queryFn: getPrintingDetailTags,
    enabled: isOpen,
  })
  const tags = Array.isArray(tagData) ? tagData : []

  const refresh = () => {
    // A reusable tag can appear in collection, binder, deck, product, trade,
    // dashboard, and public-profile payloads. Renames and removals are rare,
    // so invalidate every cached view rather than maintaining another list
    // that could drift as printing details gain new consumers.
    queryClient.invalidateQueries()
  }

  const renameMutation = useMutation({
    mutationFn: ({ id, nextName }) => updatePrintingDetailTag(id, nextName),
    onSuccess: () => {
      setEditingId(null)
      setName('')
      refresh()
      toast.success(t('printingDetails.renamed'))
    },
    onError: error => toast.error(error?.response?.data?.detail || t('common.error')),
  })

  const deleteMutation = useMutation({
    mutationFn: ({ id, force }) => deletePrintingDetailTag(id, force),
    onSuccess: () => {
      refresh()
      toast.success(t('printingDetails.deleted'))
    },
    onError: error => toast.error(error?.response?.data?.detail || t('common.error')),
  })

  const requestDelete = async (tag) => {
    const accepted = await confirm({
      title: t('printingDetails.delete'),
      message: tag.usage_count
        ? t('printingDetails.deleteUsedConfirm')
          .replace('{name}', tag.name)
          .replace('{count}', tag.usage_count)
        : t('printingDetails.deleteUnusedConfirm').replace('{name}', tag.name),
    })
    if (accepted) deleteMutation.mutate({ id: tag.id, force: tag.usage_count > 0 })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('printingDetails.manage')} size="md" mobileSheet={false}>
      <div className="space-y-3 p-5">
        <p className="text-sm text-text-secondary">{t('printingDetails.manageHelp')}</p>
        {tags.length === 0 ? (
          <p className="rounded-lg border border-border bg-bg-card p-4 text-sm text-text-muted">{t('printingDetails.empty')}</p>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {tags.map(tag => (
              <div key={tag.id} className="flex items-center gap-2 rounded-lg border border-border bg-bg-card p-2">
                {editingId === tag.id ? (
                  <input
                    value={name}
                    onChange={event => setName(event.target.value)}
                    maxLength={80}
                    className="input min-w-0 flex-1 py-1.5 text-sm"
                    autoFocus
                    onKeyDown={event => {
                      if (event.key === 'Enter' && name.trim()) renameMutation.mutate({ id: tag.id, nextName: name })
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">{tag.name}</p>
                    <p className="text-xs text-text-muted">{t('printingDetails.usedBy').replace('{count}', tag.usage_count || 0)}</p>
                  </div>
                )}
                {editingId === tag.id ? (
                  <>
                    <button type="button" className="btn-ghost px-2" disabled={!name.trim() || renameMutation.isPending} onClick={() => renameMutation.mutate({ id: tag.id, nextName: name })} aria-label={t('common.save')}><Check size={15} /></button>
                    <button type="button" className="btn-ghost px-2" onClick={() => setEditingId(null)} aria-label={t('common.cancel')}><X size={15} /></button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn-ghost px-2" onClick={() => { setEditingId(tag.id); setName(tag.name) }} aria-label={t('printingDetails.rename')}><Pencil size={15} /></button>
                    <button type="button" className="btn-ghost px-2 text-brand-red" disabled={deleteMutation.isPending} onClick={() => requestDelete(tag)} aria-label={t('printingDetails.delete')}><Trash2 size={15} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end border-t border-border pt-3">
          <button type="button" className="btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </Modal>
  )
}
