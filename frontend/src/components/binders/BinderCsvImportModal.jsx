import { Download, Upload, X } from 'lucide-react'

export const BINDER_CSV_IMPORT_HEADER = 'set_code,number,required_quantity,lang,variant,condition,collection_item_id'
const BINDER_CSV_IMPORT_TEMPLATE = `${BINDER_CSV_IMPORT_HEADER}\nBLK,057,4,de,Holo,NM,\n`

export const downloadBinderCsvTemplate = () => {
  const blob = new Blob([BINDER_CSV_IMPORT_TEMPLATE], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'card-list-import-template.csv'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export default function BinderCsvImportModal({ t, listType = 'collection', onClose, onChooseFile, onDownloadTemplate = downloadBinderCsvTemplate, isImporting }) {
  const isCollection = listType === 'collection'
  const descriptionKey = listType === 'deck'
    ? 'binderTypes.csvImportDeckDescription'
    : isCollection
      ? 'binderTypes.csvImportCollectionDescription'
      : 'binderTypes.csvImportWishlistDescription'
  const behaviorKey = listType === 'deck'
    ? 'binderTypes.csvImportDeckBehavior'
    : isCollection
      ? 'binderTypes.csvImportCollectionBehavior'
      : 'binderTypes.csvImportWishlistBehavior'

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm md:flex md:items-center md:justify-center md:bg-black/80" onClick={onClose}>
      <div
        className="fixed bottom-0 left-0 right-0 max-h-[90dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-bg-surface md:static md:max-h-[85vh] md:w-full md:max-w-lg md:rounded-2xl md:border"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex justify-center pb-1 pt-3 md:hidden"><div className="h-1 w-10 rounded-full bg-border" /></div>
        <div className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-text-primary">{t('binderTypes.csvImportTitle')}</h2>
              <p className="mt-1 text-xs text-text-secondary">{t(descriptionKey)}</p>
            </div>
            <button type="button" onClick={onClose} className="flex-shrink-0 p-1 text-text-muted hover:text-text-primary" aria-label={t('common.close')}><X size={18} /></button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={onChooseFile} disabled={isImporting} className="btn-primary justify-center">
              <Upload size={16} /> {isImporting ? t('binderTypes.importingCsv') : t('binderTypes.chooseCsvFile')}
            </button>
            <button type="button" onClick={onDownloadTemplate} className="btn-ghost justify-center">
              <Download size={16} /> {t('binderTypes.downloadCsvTemplate')}
            </button>
          </div>

          <div className="space-y-3 rounded-xl bg-bg-elevated/35 p-3 text-xs text-text-secondary">
            <div className="space-y-1">
              <p className="font-semibold text-text-primary">{t('binderTypes.csvImportSectionCardCode')}</p>
              <p>{t('binderTypes.csvImportValueHelp')}</p>
              <p className="font-mono text-[11px] text-text-primary"><span className="text-brand-red">BLK</span> → set_code · <span className="text-brand-red">057</span> → number</p>
            </div>
            <div className="space-y-2 border-t border-white/5 pt-3">
              <p className="font-semibold text-text-primary">{t('binderTypes.csvImportSectionColumns')}</p>
              <code className="block overflow-x-auto rounded-lg bg-bg/70 px-3 py-2 font-mono text-[11px] text-text-primary">{BINDER_CSV_IMPORT_HEADER}</code>
              <p className="rounded-lg bg-brand-red/10 px-3 py-2 text-[11px] text-text-secondary">{t('binderTypes.csvImportRequiredOptionalHint')}</p>
            </div>
            <div className="space-y-2 border-t border-white/5 pt-3">
              <p className="font-semibold text-text-primary">{t('binderTypes.csvImportSectionValues')}</p>
              <div className="rounded-lg bg-bg/60 px-3 py-2">
                <p className="mb-1 text-[11px] font-semibold text-text-primary">{t('binderTypes.csvImportDefaultsTitle')}</p>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div><span className="font-mono text-text-primary">required_quantity</span><br /><span className="text-text-muted">1</span></div>
                  <div><span className="font-mono text-text-primary">lang</span><br /><span className="text-text-muted">en</span></div>
                </div>
              </div>
              <p>{t(behaviorKey)}</p>
            </div>
          </div>
          <p className="rounded-lg bg-yellow/10 px-3 py-2 text-[11px] text-yellow/90">{t('binderTypes.csvImportErrorBehavior')}</p>
        </div>
      </div>
    </div>
  )
}
