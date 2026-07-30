import {useEffect, useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {ArchiveRestore, Box, CalendarDays, MapPin, Package, ShieldCheck, Trash2} from 'lucide-react'
import toast from 'react-hot-toast'

import {deleteProduct, getApiErrorMessage, getProducts, getStorageLocations, updateProduct,} from '../api/client'
import {ACQUISITION_SOURCES, REMOVAL_REASONS, SEALED_CONDITIONS} from '../utils/collectionMetadata'
import Modal from './ui/Modal'

const conditionLabel = value => SEALED_CONDITIONS.find(option => option.value === value)?.label || value
const sourceLabel = value => ACQUISITION_SOURCES.find(option => option.value === value)?.label || value || 'Unknown'

function ProductEditor({product, onClose, onAddPulledCards}) {
    const queryClient = useQueryClient()
    const [quantity, setQuantity] = useState(product.quantity || 1)
    const [sealedCondition, setSealedCondition] = useState(product.sealed_condition || 'factory_sealed')
    const [acquisitionSource, setAcquisitionSource] = useState(product.acquisition_source || 'unknown')
    const [collectionIntent, setCollectionIntent] = useState(product.collection_intent || 'main_collection')
    const [locationId, setLocationId] = useState(String(product.storage_location_id || ''))
    const [notes, setNotes] = useState(product.notes || '')
    const [removing, setRemoving] = useState(false)
    const [removalReason, setRemovalReason] = useState('other')
    const [removalNotes, setRemovalNotes] = useState('')
    const [addPulledAfterSave, setAddPulledAfterSave] = useState(false)
    const {data: locations = []} = useQuery({
        queryKey: ['storage-locations'],
        queryFn: () => getStorageLocations(),
    })

    useEffect(() => {
        if (!locationId && locations.length) {
            setLocationId(String((locations.find(location => location.is_default) || locations[0]).id))
        }
    }, [locationId, locations])

    const refresh = () => {
        queryClient.invalidateQueries({queryKey: ['products']})
        queryClient.invalidateQueries({queryKey: ['inventory-history']})
    }

    const updateMutation = useMutation({
        mutationFn: () => updateProduct(product.id, {
            quantity: Number(quantity),
            sealed_condition: sealedCondition,
            acquisition_source: acquisitionSource,
            collection_intent: collectionIntent,
            storage_location_id: Number(locationId),
            notes: notes.trim() || null,
        }),
        onSuccess: () => {
            toast.success('Sealed product updated')
            refresh()
            onClose()
            if (sealedCondition === 'opened' && addPulledAfterSave) onAddPulledCards?.()
        },
        onError: error => toast.error(getApiErrorMessage(error, 'Could not update this product')),
    })

    const removeMutation = useMutation({
        mutationFn: () => deleteProduct(product.id, {
            reason: removalReason,
            notes: removalNotes.trim() || null,
        }),
        onSuccess: () => {
            toast.success('Sealed product moved to history')
            refresh()
            onClose()
        },
        onError: error => toast.error(getApiErrorMessage(error, 'Could not remove this product')),
    })

    const isRemoved = product.status === 'removed'

    return (
        <Modal isOpen onClose={onClose} title={product.product_name} size="md">
            <div className="space-y-4 p-5">
                <div className="sealed-detail-hero">
                    <span className="sealed-detail-icon"><Package size={24}/></span>
                    <div>
                        <span className="archive-eyebrow">{product.product_type || 'Sealed product'}</span>
                        <p className="mt-1 text-sm text-text-secondary">
                            Added {product.purchase_date || 'date unknown'} · record {product.record_uid?.slice(0, 8)}
                        </p>
                    </div>
                </div>

                {!isRemoved && !removing && (
                    <form
                        className="grid gap-4 sm:grid-cols-2"
                        onSubmit={event => {
                            event.preventDefault()
                            updateMutation.mutate()
                        }}
                    >
                        <label>
                            <span className="mb-1 block text-xs font-semibold text-text-secondary">Quantity</span>
                            <input className="input w-full" type="number" min="1" max="999" value={quantity}
                                   onChange={event => setQuantity(event.target.value)}/>
                        </label>
                        <label>
                            <span className="mb-1 block text-xs font-semibold text-text-secondary">Condition</span>
                            <select className="select w-full" value={sealedCondition}
                                    onChange={event => setSealedCondition(event.target.value)}>
                                {SEALED_CONDITIONS.map(option => <option key={option.value}
                                                                         value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <label>
                            <span
                                className="mb-1 block text-xs font-semibold text-text-secondary">Acquisition source</span>
                            <select className="select w-full" value={acquisitionSource}
                                    onChange={event => setAcquisitionSource(event.target.value)}>
                                {ACQUISITION_SOURCES.filter(option => option.value !== 'bulk_before_tracking').map(option => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        </label>
                        <label>
                            <span className="mb-1 block text-xs font-semibold text-text-secondary">Collection</span>
                            <select className="select w-full" value={collectionIntent} onChange={event => setCollectionIntent(event.target.value)}>
                                <option value="main_collection">Main Collection</option>
                                <option value="vault">Vault</option>
                                <option value="pc">PC</option>
                            </select>
                        </label>
                        <label className="sm:col-span-2">
                            <span
                                className="mb-1 block text-xs font-semibold text-text-secondary">Storage location</span>
                            <select className="select w-full" value={locationId}
                                    onChange={event => setLocationId(event.target.value)} required>
                                <option value="">Choose a location</option>
                                {locations.map(location => <option key={location.id}
                                                                   value={location.id}>{location.name}</option>)}
                            </select>
                        </label>
                        <label className="sm:col-span-2">
                            <span className="mb-1 block text-xs font-semibold text-text-secondary">Collector note</span>
                            <textarea className="input min-h-24 w-full" value={notes}
                                      onChange={event => setNotes(event.target.value)}/>
                        </label>
                        {sealedCondition === 'opened' && (
                            <label
                                className="sm:col-span-2 flex cursor-pointer items-start gap-3 rounded-xl border border-yellow/25 bg-yellow/10 p-3">
                                <input
                                    type="checkbox"
                                    className="mt-0.5 h-4 w-4 accent-brand-red"
                                    checked={addPulledAfterSave}
                                    onChange={event => setAddPulledAfterSave(event.target.checked)}
                                />
                                <span>
                  <strong className="block text-sm text-text-primary">Add cards pulled from this product next</strong>
                  <small className="mt-0.5 block text-text-secondary">The sealed-product record stays in the archive as Opened.</small>
                </span>
                            </label>
                        )}
                        <div
                            className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:col-span-2 sm:flex-row sm:justify-between">
                            <button type="button" className="btn-ghost justify-center text-brand-red"
                                    onClick={() => setRemoving(true)}>
                                <Trash2 size={15}/> Remove
                            </button>
                            <div className="flex gap-2">
                                <button type="button" className="btn-ghost flex-1 justify-center sm:flex-none"
                                        onClick={onClose}>Cancel
                                </button>
                                <button className="btn-primary flex-1 justify-center sm:flex-none"
                                        disabled={updateMutation.isPending}>Save changes
                                </button>
                            </div>
                        </div>
                    </form>
                )}

                {removing && (
                    <form
                        className="space-y-4 archive-card-reveal"
                        onSubmit={event => {
                            event.preventDefault()
                            removeMutation.mutate()
                        }}
                    >
                        <div className="rounded-xl border border-brand-red/25 bg-brand-red/10 p-3">
                            <strong className="text-sm text-text-primary">Move this product to history?</strong>
                            <p className="mt-1 text-xs text-text-secondary">The record and its local change history are
                                preserved.</p>
                        </div>
                        <label className="block">
                            <span className="mb-1 block text-xs font-semibold text-text-secondary">Reason</span>
                            <select className="select w-full" value={removalReason}
                                    onChange={event => setRemovalReason(event.target.value)}>
                                {REMOVAL_REASONS.map(option => <option key={option.value}
                                                                       value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <label className="block">
                            <span className="mb-1 block text-xs font-semibold text-text-secondary">Note</span>
                            <textarea className="input min-h-20 w-full" value={removalNotes}
                                      onChange={event => setRemovalNotes(event.target.value)}/>
                        </label>
                        <div className="flex justify-end gap-2">
                            <button type="button" className="btn-ghost" onClick={() => setRemoving(false)}>Back</button>
                            <button className="btn-primary bg-brand-red" disabled={removeMutation.isPending}>Move to
                                history
                            </button>
                        </div>
                    </form>
                )}

                {isRemoved && (
                    <div className="rounded-xl border border-border bg-bg-elevated/45 p-4">
                        <span className="archive-eyebrow">History record</span>
                        <p className="mt-2 text-sm text-text-secondary">
                            Removed as {product.removal_reason || 'other'}. The original product record remains intact.
                        </p>
                    </div>
                )}
            </div>
        </Modal>
    )
}

export default function SealedCollectionView({status = 'active', onAddPulledCards}) {
    const [selectedProduct, setSelectedProduct] = useState(null)
    const {data: response, isLoading, error} = useQuery({
        queryKey: ['products', status],
        queryFn: () => getProducts({status}),
    })
    const products = response?.data || []

    if (isLoading) {
        return (
            <div className="sealed-gallery-grid">
                {[0, 1, 2].map(index => <div key={index} className="skeleton h-48 rounded-2xl"/>)}
            </div>
        )
    }
    if (error) {
        return <div className="card text-sm text-brand-red">Sealed products could not be loaded.</div>
    }
    if (products.length === 0) {
        return (
            <div className="collection-empty-state">
                <span className="collection-empty-icon"><Box size={28}/></span>
                <h2>{status === 'removed' ? 'No sealed history yet' : 'No sealed product filed yet'}</h2>
                <p>{status === 'removed' ? 'Removed products will stay visible here.' : 'Add a box, pack, tin, or bundle from the collection intake.'}</p>
            </div>
        )
    }

    return (
        <>
            <div className="sealed-gallery-grid">
                {products.map((product, index) => (
                    <button
                        key={product.id}
                        type="button"
                        className="sealed-product-card archive-card-reveal"
                        style={{animationDelay: `${Math.min(index, 10) * 35}ms`}}
                        onClick={() => setSelectedProduct(product)}
                    >
                        <span className="sealed-product-art"><Package size={30}/></span>
                        <span className="min-w-0 flex-1 text-left">
              <span className="archive-eyebrow">{product.product_type || 'Sealed product'}</span>
              <strong className="mt-1 block truncate text-lg text-text-primary">{product.product_name}</strong>
              <span className="mt-3 flex flex-wrap gap-2 text-xs text-text-secondary">
                <span><ShieldCheck size={13}/> {conditionLabel(product.sealed_condition)}</span>
                <span><ArchiveRestore size={13}/> {sourceLabel(product.acquisition_source)}</span>
                <span><MapPin size={13}/> {product.storage_location?.name || 'To organize'}</span>
                <span><CalendarDays size={13}/> {product.purchase_date}</span>
              </span>
            </span>
                        {product.quantity > 1 && <span className="sealed-quantity">×{product.quantity}</span>}
                    </button>
                ))}
            </div>
            {selectedProduct && (
                <ProductEditor
                    product={selectedProduct}
                    onClose={() => setSelectedProduct(null)}
                    onAddPulledCards={onAddPulledCards}
                />
            )}
        </>
    )
}
