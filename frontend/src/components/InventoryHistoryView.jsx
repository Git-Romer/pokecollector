import {useMemo} from 'react'
import {useQuery} from '@tanstack/react-query'
import {ArchiveRestore, Box, FileSpreadsheet, MapPin, Package, PenLine, Plus,} from 'lucide-react'

import {getCollection, getInventoryHistory, getProducts, getStorageLocations,} from '../api/client'

const entityDetails = {
    collection_item: {label: 'Card record', icon: ArchiveRestore},
    sealed_product: {label: 'Sealed product', icon: Package},
    storage_location: {label: 'Storage location', icon: MapPin},
}

const actionDetails = {
    added: {label: 'Added', icon: Plus},
    quantity_increased: {label: 'Quantity changed', icon: Plus},
    updated: {label: 'Updated', icon: PenLine},
    moved: {label: 'Moved', icon: MapPin},
    removed: {label: 'Moved to history', icon: ArchiveRestore},
    import_added: {label: 'Imported', icon: FileSpreadsheet},
    import_updated: {label: 'Updated from Excel', icon: FileSpreadsheet},
}

const fieldLabels = {
    acquisition_source: 'Acquisition',
    certification_number: 'Certification',
    condition: 'Condition',
    grade: 'Grade',
    grader: 'Grader',
    inventory_kind: 'Collection',
    is_active: 'Active',
    is_default: 'Default',
    name: 'Name',
    notes: 'Notes',
    protection_type: 'Protection',
    purchase_price: 'Cost basis',
    quantity: 'Quantity',
    removal_reason: 'Reason',
    sealed_condition: 'Condition',
    status: 'Status',
    storage_location_id: 'Storage location',
    variant: 'Variant',
}

const humanize = value => String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase())

function formatDate(value) {
    if (!value) return 'Date unknown'
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(value))
}

function changeSummary(changes = {}) {
    return Object.entries(changes)
        .slice(0, 3)
        .map(([field, values]) => {
            const label = fieldLabels[field] || humanize(field)
            const after = values?.after
            if (after === null || after === undefined || after === '') return `${label} cleared`
            return `${label}: ${humanize(after)}`
        })
}

export default function InventoryHistoryView() {
    const historyQuery = useQuery({
        queryKey: ['inventory-history'],
        queryFn: () => getInventoryHistory({limit: 200}),
    })
    const collectionQuery = useQuery({
        queryKey: ['collection', 'history-lookup'],
        queryFn: () => getCollection({status: 'all'}).then(response => response.data),
    })
    const productsQuery = useQuery({
        queryKey: ['products', 'history-lookup'],
        queryFn: () => getProducts({status: 'all'}).then(response => response.data),
    })
    const locationsQuery = useQuery({
        queryKey: ['storage-locations', 'history-lookup'],
        queryFn: () => getStorageLocations({include_inactive: true}),
    })

    const names = useMemo(() => {
        const lookup = new Map()
        for (const item of collectionQuery.data || []) {
            lookup.set(`collection_item:${item.id}`, item.card?.name || `Card record ${item.id}`)
        }
        for (const product of productsQuery.data || []) {
            lookup.set(`sealed_product:${product.id}`, product.product_name || `Sealed product ${product.id}`)
        }
        for (const location of locationsQuery.data || []) {
            lookup.set(`storage_location:${location.id}`, location.name || `Storage location ${location.id}`)
        }
        return lookup
    }, [collectionQuery.data, locationsQuery.data, productsQuery.data])

    if (historyQuery.isLoading) {
        return (
            <div className="inventory-history-list" aria-label="Loading collection history">
                {[0, 1, 2, 3].map(index => <div key={index} className="skeleton h-24 rounded-2xl"/>)}
            </div>
        )
    }

    if (historyQuery.error) {
        return <div className="card text-sm text-brand-red">Collection history could not be loaded.</div>
    }

    const events = historyQuery.data || []
    if (events.length === 0) {
        return (
            <div className="collection-empty-state">
                <span className="collection-empty-icon"><Box size={28}/></span>
                <h2>The archive is quiet</h2>
                <p>Add or edit something and John John will keep the trail here.</p>
            </div>
        )
    }

    return (
        <div className="inventory-history-list">
            {events.map((event, index) => {
                const entity = entityDetails[event.entity_type] || entityDetails.collection_item
                const action = actionDetails[event.action] || {label: humanize(event.action), icon: PenLine}
                const Icon = action.icon || entity.icon
                const summaries = changeSummary(event.changes)
                const name = names.get(`${event.entity_type}:${event.entity_id}`) || `${entity.label} · ${event.entity_uid.slice(0, 8)}`

                return (
                    <article
                        key={event.id}
                        className="inventory-history-event archive-card-reveal"
                        style={{animationDelay: `${Math.min(index, 12) * 28}ms`}}
                    >
                        <span className="inventory-history-icon"><Icon size={17}/></span>
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                <strong className="text-sm text-text-primary">{action.label}</strong>
                                <span className="truncate text-sm text-text-secondary">{name}</span>
                            </div>
                            <p className="mt-1 text-xs text-text-muted">{entity.label} · {formatDate(event.occurred_at)}</p>
                            {(summaries.length > 0 || event.notes) && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {summaries.map(summary => <span key={summary}
                                                                    className="inventory-history-change">{summary}</span>)}
                                    {event.notes && <span className="inventory-history-note">{event.notes}</span>}
                                </div>
                            )}
                        </div>
                        <span
                            className="hidden font-mono text-[10px] text-text-muted sm:block">{event.entity_uid.slice(0, 8)}</span>
                    </article>
                )
            })}
        </div>
    )
}
