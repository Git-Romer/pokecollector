import {useRef, useState} from 'react'
import {useMutation, useQueryClient} from '@tanstack/react-query'
import {AlertTriangle, Check, Download, FileSpreadsheet, FileText, RefreshCw, Upload} from 'lucide-react'
import toast from 'react-hot-toast'

import {getApiErrorMessage, importCollectionCsv, importInventoryXlsx} from '../api/client'
import ImportReviewNotice from './ImportReviewNotice'
import Modal from './ui/Modal'

function Metric({value = 0, label, tone = 'default'}) {
    return (
        <div className={`excel-review-metric excel-review-metric-${tone}`}>
            <strong>{Number(value).toLocaleString()}</strong>
            <span>{label}</span>
        </div>
    )
}

export default function ExcelImportModal({isOpen, onClose}) {
    const queryClient = useQueryClient()
    const inputRef = useRef(null)
    const csvInputRef = useRef(null)
    const [file, setFile] = useState(null)
    const [review, setReview] = useState(null)
    const [csvFile, setCsvFile] = useState(null)
    const [csvReview, setCsvReview] = useState(null)

    const close = () => {
        setFile(null)
        setReview(null)
        setCsvFile(null)
        setCsvReview(null)
        if (inputRef.current) inputRef.current.value = ''
        if (csvInputRef.current) csvInputRef.current.value = ''
        onClose()
    }

    const reviewMutation = useMutation({
        mutationFn: selectedFile => importInventoryXlsx(selectedFile, false),
        onSuccess: setReview,
        onError: error => toast.error(getApiErrorMessage(error, 'Could not review this workbook')),
    })

    const commitMutation = useMutation({
        mutationFn: () => importInventoryXlsx(file, true),
        onSuccess: result => {
            if (!result.valid || !result.committed) {
                setReview(result)
                toast.error('The workbook changed or needs attention before it can be imported')
                return
            }
            toast.success('Workbook imported. The archive is up to date.')
            queryClient.invalidateQueries({queryKey: ['collection']})
            queryClient.invalidateQueries({queryKey: ['products']})
            queryClient.invalidateQueries({queryKey: ['storage-locations']})
            queryClient.invalidateQueries({queryKey: ['inventory-history']})
            queryClient.invalidateQueries({queryKey: ['dashboard']})
            close()
        },
        onError: error => toast.error(getApiErrorMessage(error, 'Could not import this workbook')),
    })

    const csvReviewMutation = useMutation({
        mutationFn: selectedFile => importCollectionCsv(selectedFile, false),
        onSuccess: setCsvReview,
        onError: error => toast.error(getApiErrorMessage(error, 'Could not review this CSV')),
    })

    const csvCommitMutation = useMutation({
        mutationFn: () => importCollectionCsv(csvFile, true),
        onSuccess: result => {
            const message = `${result.added} added · ${result.updated} updated`
            if (result.failed || !result.committed) {
                toast.error(`${message} · ${result.failed} failed`)
                setCsvReview(result)
                return
            }
            toast.success(`CSV imported · ${message}`)
            queryClient.invalidateQueries({queryKey: ['collection']})
            queryClient.invalidateQueries({queryKey: ['dashboard']})
            close()
        },
        onError: error => toast.error(getApiErrorMessage(error, 'Could not import this CSV')),
    })

    const chooseCsv = event => {
        const selected = event.target.files?.[0]
        if (!selected) return
        setCsvFile(selected)
        setCsvReview(null)
        csvReviewMutation.mutate(selected)
    }

    const downloadCsvTemplate = () => {
        // Legacy CSV import still accepts the API field name `purchase_price`.
        // The interface presents this as Cost Basis so the backup workflow stays
        // aligned with John John's PC terminology.
        const contents = 'set_code,number,quantity,condition,variant,lang,purchase_price\nASC,152,1,NM,Normal,en,\n'
        const url = URL.createObjectURL(new Blob([contents], {type: 'text/csv;charset=utf-8'}))
        const link = document.createElement('a')
        link.href = url
        link.download = 'collection-import-template.csv'
        link.click()
        URL.revokeObjectURL(url)
    }

    const chooseFile = event => {
        const selected = event.target.files?.[0]
        if (!selected) return
        setFile(selected)
        setReview(null)
        reviewMutation.mutate(selected)
    }

    const summary = review?.summary || {}

    return (
        <Modal isOpen={isOpen} onClose={close} title="Review Excel workbook" size="lg">
            <div className="space-y-5 p-5 sm:p-6">
                <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={chooseFile}/>
                <input ref={csvInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={chooseCsv}/>

                {!file && (
                    <>
                        <button type="button" className="excel-dropzone" onClick={() => inputRef.current?.click()}>
                            <span className="excel-dropzone-icon"><FileSpreadsheet size={26}/></span>
                            <strong>Choose a John John’s PC workbook</strong>
                            <span>Nothing is written until you review and confirm the changes.</span>
                            <span className="btn-primary mt-2"><Upload size={16}/> Choose .xlsx</span>
                        </button>
                        <ImportReviewNotice/>
                        <details className="rounded-xl border border-border bg-bg-elevated/30">
                            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-text-secondary">
                                Legacy CSV tools
                            </summary>
                            <div className="flex flex-wrap gap-2 border-t border-border p-3">
                                <p className="w-full text-xs text-text-muted">
                                    CSV keeps the legacy field name purchase_price; treat it as Cost Basis.
                                    Leave it blank when cost basis is needed.
                                </p>
                                {csvFile && (
                                    <div className="w-full rounded-lg border border-border bg-bg/40 px-3 py-2 text-xs text-text-secondary">
                                        <strong className="text-text-primary">{csvFile.name}</strong>
                                        {csvReviewMutation.isPending && <span> · Reviewing…</span>}
                                        {csvReview && (
                                            <span>
                                                {' '}· {csvReview.added} new · {csvReview.updated} existing
                                                {csvReview.failed ? ` · ${csvReview.failed} errors` : ''}
                                            </span>
                                        )}
                                    </div>
                                )}
                                <button
                                    type="button"
                                    className="btn-ghost text-xs"
                                    disabled={csvReviewMutation.isPending || csvCommitMutation.isPending}
                                    onClick={() => csvInputRef.current?.click()}
                                >
                                    <FileText size={15}/> {csvFile ? 'Replace CSV' : 'Choose CSV'}
                                </button>
                                <button type="button" className="btn-ghost text-xs" onClick={downloadCsvTemplate}>
                                    <Download size={15}/> CSV template
                                </button>
                                {csvReview && !csvReview.failed && (
                                    <button
                                        type="button"
                                        className="btn-primary text-xs"
                                        disabled={csvCommitMutation.isPending}
                                        onClick={() => csvCommitMutation.mutate()}
                                    >
                                        <Check size={15}/>
                                        {csvCommitMutation.isPending ? 'Importing…' : 'Confirm CSV import'}
                                    </button>
                                )}
                                {csvReview?.errors?.length > 0 && (
                                    <ul className="w-full space-y-1 text-xs text-brand-red">
                                        {csvReview.errors.map(error => <li key={error}>{error}</li>)}
                                    </ul>
                                )}
                            </div>
                        </details>
                    </>
                )}

                {file && (
                    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated/45 p-3">
                        <FileSpreadsheet className="text-green" size={22}/>
                        <div className="min-w-0 flex-1">
                            <strong className="block truncate text-sm text-text-primary">{file.name}</strong>
                            <span
                                className="text-xs text-text-muted">{Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB</span>
                        </div>
                        <button type="button" className="btn-ghost text-xs" onClick={() => inputRef.current?.click()}>
                            Replace
                        </button>
                    </div>
                )}

                {reviewMutation.isPending && (
                    <div className="archive-loading" role="status">
                        <span className="archive-loading-orbit"/>
                        John John is comparing the workbook with the local archive…
                    </div>
                )}

                {review && (
                    <div className="space-y-4 archive-card-reveal">
                        <div className="excel-review-grid">
                            <Metric value={summary.matched_cards} label="Matched cards" tone="info"/>
                            <Metric value={summary.new_records} label="New records" tone="success"/>
                            <Metric value={summary.updated_records} label="Updates" tone="warning"/>
                            <Metric value={summary.duplicates} label="Duplicates"/>
                            <Metric value={summary.errors} label="Errors" tone={summary.errors ? 'danger' : 'success'}/>
                        </div>

                        <div
                            className={`excel-review-status ${review.valid ? 'excel-review-status-valid' : 'excel-review-status-invalid'}`}>
                            {review.valid ? <Check size={18}/> : <AlertTriangle size={18}/>}
                            <div>
                                <strong>{review.valid ? 'Ready to import' : 'This workbook needs attention'}</strong>
                                <p>
                                    {review.valid
                                        ? 'Stable record IDs will update existing rows instead of creating duplicates.'
                                        : 'No changes have been written. Correct the listed rows and review again.'}
                                </p>
                            </div>
                        </div>

                        {review.errors?.length > 0 && (
                            <div className="max-h-48 overflow-y-auto rounded-xl border border-brand-red/25">
                                {review.errors.map((error, index) => (
                                    <div key={`${error.sheet}-${error.row}-${index}`}
                                         className="border-b border-border/60 px-3 py-2 text-xs last:border-0">
                                        <strong className="text-brand-red">{error.sheet || 'Workbook'} ·
                                            row {error.row || '—'}</strong>
                                        <p className="mt-0.5 text-text-secondary">{error.error}</p>
                                    </div>
                                ))}
                            </div>
                        )}

                        {review.actions?.length > 0 && (
                            <details className="rounded-xl border border-border bg-bg/40">
                                <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-text-secondary">
                                    Preview {review.actions.length.toLocaleString()} row actions
                                </summary>
                                <div className="max-h-48 overflow-y-auto border-t border-border">
                                    {review.actions.slice(0, 100).map((action, index) => (
                                        <div key={`${action.sheet}-${action.row}-${index}`}
                                             className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs last:border-0">
                                            <span
                                                className={`excel-action excel-action-${action.action}`}>{action.action}</span>
                                            <span
                                                className="min-w-0 flex-1 truncate text-text-secondary">{action.name}</span>
                                            <span className="text-text-muted">{action.sheet} · {action.row}</span>
                                        </div>
                                    ))}
                                </div>
                            </details>
                        )}
                    </div>
                )}

                <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
                    <button type="button" className="btn-ghost justify-center" onClick={close}>Cancel</button>
                    {review && !review.valid && (
                        <button type="button" className="btn-ghost justify-center"
                                onClick={() => reviewMutation.mutate(file)}>
                            <RefreshCw size={16}/> Review again
                        </button>
                    )}
                    {review?.valid && (
                        <button
                            type="button"
                            className="btn-primary justify-center"
                            disabled={commitMutation.isPending}
                            onClick={() => commitMutation.mutate()}
                        >
                            {commitMutation.isPending ? <span className="archive-loading-orbit"/> : <Check size={16}/>}
                            {commitMutation.isPending ? 'Importing…' : 'Confirm import'}
                        </button>
                    )}
                </div>
            </div>
        </Modal>
    )
}
