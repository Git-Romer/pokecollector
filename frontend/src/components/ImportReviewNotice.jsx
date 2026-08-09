export default function ImportReviewNotice() {
    return (
        <aside
            role="note"
            className="daisy-alert daisy-alert-info min-h-0 w-full rounded-lg border border-light-blue/30 bg-light-blue/5 px-3 py-2 text-xs leading-relaxed text-text-secondary"
        >
            Review imported records before changing existing collection items. Nothing is merged or overwritten
            until you explicitly confirm the import.
        </aside>
    )
}
