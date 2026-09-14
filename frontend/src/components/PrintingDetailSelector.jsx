import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { createPrintingDetailTag, getPrintingDetailTags } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import {
  arePrintingDetailNamesSimilar,
  normalizePrintingDetailName,
  PRINTING_DETAIL_MAX_TAGS,
  printingDetailNames,
} from '../utils/printingDetails'

export default function PrintingDetailSelector({ value = [], onChange, disabled = false }) {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [focused, setFocused] = useState(false)
  const selected = printingDetailNames(value)
  const selectedKeys = useMemo(
    () => new Set(selected.map(normalizePrintingDetailName)),
    [selected],
  )
  const { data: tagData = [] } = useQuery({
    queryKey: ['printing-detail-tags'],
    queryFn: getPrintingDetailTags,
    staleTime: 60000,
  })
  const tags = Array.isArray(tagData) ? tagData : []

  const normalizedSearch = normalizePrintingDetailName(search)
  const exact = tags.find(tag => normalizePrintingDetailName(tag.name) === normalizedSearch)
  const suggestions = tags.filter(tag => (
    !selectedKeys.has(normalizePrintingDetailName(tag.name))
    && (!normalizedSearch || normalizePrintingDetailName(tag.name).includes(normalizedSearch))
  ))
  const similar = normalizedSearch && !exact
    ? tags.find(tag => arePrintingDetailNamesSimilar(tag.name, search))
    : null

  const addName = (name) => {
    if (selected.length >= PRINTING_DETAIL_MAX_TAGS) {
      toast.error(t('printingDetails.maxReached'))
      return
    }
    const key = normalizePrintingDetailName(name)
    if (!key || selectedKeys.has(key)) return
    onChange([...selected, name])
    setSearch('')
  }

  const createMutation = useMutation({
    mutationFn: createPrintingDetailTag,
    onSuccess: (tag) => {
      queryClient.setQueryData(['printing-detail-tags'], current => {
        const currentTags = Array.isArray(current) ? current : []
        const next = [...currentTags.filter(item => item.id !== tag.id), tag]
        return next.sort((left, right) => left.name.localeCompare(right.name))
      })
      addName(tag.name)
    },
    onError: (error) => toast.error(error?.response?.data?.detail || t('common.error')),
  })

  const createCurrent = () => {
    const name = search.trim().replace(/\s+/g, ' ')
    if (!name) return
    if (exact) addName(exact.name)
    else createMutation.mutate(name)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {selected.map(name => (
          <span key={normalizePrintingDetailName(name)} className="inline-flex items-center gap-1 rounded-full border border-blue/30 bg-blue/10 px-2 py-1 text-xs font-medium text-blue">
            {name}
            <button
              type="button"
              onClick={() => onChange(selected.filter(item => normalizePrintingDetailName(item) !== normalizePrintingDetailName(name)))}
              disabled={disabled}
              className="rounded-full hover:bg-blue/20"
              aria-label={`${t('common.remove')} ${name}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <div className="flex gap-2">
          <input
            type="text"
            value={search}
            onChange={event => setSearch(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 100)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                createCurrent()
              }
            }}
            disabled={disabled || selected.length >= PRINTING_DETAIL_MAX_TAGS}
            maxLength={80}
            placeholder={t('printingDetails.searchOrCreate')}
            className="input min-w-0 flex-1"
          />
          <button
            type="button"
            className="btn-ghost px-3"
            onClick={createCurrent}
            disabled={disabled || createMutation.isPending || !normalizedSearch || selected.length >= PRINTING_DETAIL_MAX_TAGS}
            aria-label={t('printingDetails.add')}
          >
            <Plus size={16} />
          </button>
        </div>
        {focused && (normalizedSearch || suggestions.length > 0) && (
          <div className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-border bg-bg-surface p-1 shadow-lg">
            {suggestions.slice(0, 8).map(tag => (
              <button key={tag.id} type="button" onClick={() => addName(tag.name)} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-text-primary hover:bg-bg-card">
                <span>{tag.name}</span>
                <span className="text-xs text-text-muted">{tag.usage_count || 0}</span>
              </button>
            ))}
            {normalizedSearch && !exact && (
              <button type="button" onClick={createCurrent} className="w-full rounded px-2 py-1.5 text-left text-sm text-blue hover:bg-bg-card">
                {t('printingDetails.create')} “{search.trim()}”
              </button>
            )}
          </div>
        )}
      </div>
      {similar && (
        <p className="text-xs text-yellow">
          {t('printingDetails.similarWarning')} “{similar.name}”
        </p>
      )}
      <p className="text-xs text-text-muted">{t('printingDetails.priceHelp')}</p>
    </div>
  )
}
