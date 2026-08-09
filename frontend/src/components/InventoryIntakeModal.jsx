import {useEffect, useMemo, useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {Archive, Box, Check, ChevronLeft, ChevronRight, MapPin, PackageOpen, Plus, Search, Sparkles} from 'lucide-react'
import toast from 'react-hot-toast'

import {
    addToCollection,
    createProduct,
    createStorageLocation,
    getApiErrorMessage,
    getStorageLocations,
    searchCards,
} from '../api/client'
import {
    ACQUISITION_SOURCES,
    defaultPurchasePrice,
    PROTECTION_TYPES,
    RAW_CONDITIONS,
    SEALED_CONDITIONS,
} from '../utils/collectionMetadata'
import {resolveCardImageUrl} from '../utils/imageUrl'
import Modal from './ui/Modal'
import CardImage from './CardImage'

const CARD_VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']
const PRODUCT_TYPES = [
    'Booster Pack',
    'Booster Box',
    'Elite Trainer Box',
    'Tin',
    'Bundle',
    'Collection Box',
    'Blister',
    'Other',
]

const today = () => new Date().toISOString().slice(0, 10)

function Field({label, required = false, children, hint}) {
    return (
        <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-semibold text-text-secondary">
        {label}{required && <span className="ml-1 text-brand-red">*</span>}
      </span>
            {children}
            {hint && <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>}
        </label>
    )
}

function IntakeTypeButton({active, icon: Icon, label, description, onClick}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={`inventory-kind-card ${active ? 'inventory-kind-card-active' : ''}`}
        >
            <span className="inventory-kind-icon"><Icon size={18}/></span>
            <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
        </button>
    )
}

const INTAKE_STEPS = ['Identify', 'Document', 'Review']

function IntakeStepper({step}) {
    return (
        <ol className="intake-stepper" aria-label="Collection lot steps">
            {INTAKE_STEPS.map((label, index) => {
                const stepNumber = index + 1
                const isCurrent = stepNumber === step
                const isComplete = stepNumber < step
                return (
                    <li key={label} className={`intake-step ${isCurrent ? 'intake-step-current' : ''} ${isComplete ? 'intake-step-complete' : ''}`} aria-current={isCurrent ? 'step' : undefined}>
                        <span className="intake-step-index">{isComplete ? <Check size={13}/> : stepNumber}</span>
                        <span>{label}</span>
                    </li>
                )
            })}
        </ol>
    )
}

function ReviewRow({label, value, muted = false}) {
    return (
        <div className="intake-review-row">
            <span>{label}</span>
            <strong className={muted ? 'text-brand-red' : ''}>{value || 'Cost Basis Needed'}</strong>
        </div>
    )
}

function CardPicker({selectedCard, onSelect}) {
    const [query, setQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')

    useEffect(() => {
        const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
        return () => window.clearTimeout(timeout)
    }, [query])

    const {data, isFetching} = useQuery({
        queryKey: ['inventory-card-search', debouncedQuery],
        queryFn: () => searchCards({
            name: debouncedQuery,
            lang: 'all',
            page: 1,
            page_size: 8,
        }).then(response => response.data),
        enabled: debouncedQuery.length >= 2,
    })
    const cards = data?.data || []

    if (selectedCard) {
        return (
            <div className="inventory-selected-card archive-card-reveal">
                <CardImage
                    src={resolveCardImageUrl(selectedCard)}
                    alt={selectedCard.name}
                    className="h-24 w-[4.3rem] rounded-lg object-cover"
                />
                <div className="min-w-0 flex-1">
                    <span className="archive-eyebrow">Exact printing selected</span>
                    <h3 className="mt-1 truncate text-lg font-black text-text-primary">{selectedCard.name}</h3>
                    <p className="text-sm text-text-secondary">
                        {[selectedCard.set_ref?.name || selectedCard.set_name, selectedCard.number && `#${selectedCard.number}`]
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                    <p className="mt-2 text-xs text-text-muted">{selectedCard.id}</p>
                </div>
                <button type="button" className="btn-ghost self-start text-xs" onClick={() => onSelect(null)}>
                    Change
                </button>
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <Field label="Find the exact card printing" required
                   hint="Search by card name, set code, or collector number.">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16}/>
                    <input
                        autoFocus
                        className="input w-full pl-9"
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        placeholder="Latias ex, SSP 239…"
                    />
                </div>
            </Field>
            {isFetching && (
                <div className="archive-loading" role="status">
                    <span className="archive-loading-orbit"/> John John is checking the catalog…
                </div>
            )}
            {debouncedQuery.length >= 2 && !isFetching && cards.length === 0 && (
                <div className="inventory-empty-result">
                    <Archive size={18}/>
                    <span>No exact printing found. Try the set code and number.</span>
                </div>
            )}
            {cards.length > 0 && (
                <div className="inventory-search-results" role="listbox" aria-label="Card search results">
                    {cards.map(card => (
                        <button
                            type="button"
                            key={card.id}
                            className="inventory-search-result"
                            onClick={() => onSelect(card)}
                        >
                            <CardImage
                                src={resolveCardImageUrl(card)}
                                alt=""
                                className="h-14 w-10 rounded object-cover"
                            />
                            <span className="min-w-0 flex-1 text-left">
                <strong className="block truncate text-sm text-text-primary">{card.name}</strong>
                <small className="block truncate text-text-muted">
                  {[card.set_ref?.name || card.set_name, card.number && `#${card.number}`]
                      .filter(Boolean)
                      .join(' · ')}
                </small>
              </span>
                            <Plus size={16} className="text-brand-red"/>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

function LocationSelect({value, onChange}) {
    const queryClient = useQueryClient()
    const [adding, setAdding] = useState(false)
    const [name, setName] = useState('')
    const {data: locations = [], isLoading} = useQuery({
        queryKey: ['storage-locations'],
        queryFn: () => getStorageLocations(),
    })

    useEffect(() => {
        if (!value && locations.length) {
            const preferred = locations.find(location => location.is_default) || locations[0]
            onChange(String(preferred.id))
        }
    }, [locations, value, onChange])

    const createMutation = useMutation({
        mutationFn: () => createStorageLocation({name: name.trim()}),
        onSuccess: location => {
            queryClient.invalidateQueries({queryKey: ['storage-locations']})
            onChange(String(location.id))
            setName('')
            setAdding(false)
            toast.success(`${location.name} is ready`)
        },
        onError: error => toast.error(getApiErrorMessage(error, 'Could not create the storage location')),
    })

    return (
        <Field label="Storage location" required hint="Every item needs a home. New intake defaults to To organize.">
            <div className="flex gap-2">
                <select
                    className="select min-w-0 flex-1"
                    value={value}
                    onChange={event => onChange(event.target.value)}
                    disabled={isLoading}
                    required
                >
                    <option value="">Choose a location</option>
                    {locations.map(location => (
                        <option key={location.id} value={location.id}>
                            {location.name}{location.is_default ? ' · default' : ''}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="btn-ghost px-3"
                    aria-label="Add storage location"
                    onClick={() => setAdding(current => !current)}
                >
                    <MapPin size={16}/>
                </button>
            </div>
            {adding && (
                <div className="mt-2 flex gap-2 archive-card-reveal">
                    <input
                        className="input min-w-0 flex-1"
                        value={name}
                        onChange={event => setName(event.target.value)}
                        placeholder="Binder 1, PSA case, Shelf A…"
                    />
                    <button
                        type="button"
                        className="btn-primary"
                        disabled={!name.trim() || createMutation.isPending}
                        onClick={() => createMutation.mutate()}
                    >
                        Add
                    </button>
                </div>
            )}
        </Field>
    )
}

export default function InventoryIntakeModal({
                                                 isOpen,
                                                 onClose,
                                                 initialKind = 'owned',
                                                 initialSource = null,
                                                 onSaved,
                                             }) {
    const queryClient = useQueryClient()
    const [step, setStep] = useState(1)
    const [kind, setKind] = useState(initialKind)
    const [selectedCard, setSelectedCard] = useState(null)
    const [quantity, setQuantity] = useState(1)
    const [condition, setCondition] = useState('NM')
    const [variant, setVariant] = useState('Normal')
    const [source, setSource] = useState(
        initialKind === 'bulk' ? 'bulk_before_tracking' : initialSource || (initialKind === 'sealed' ? 'purchased' : 'other'),
    )
    const [collectionIntent, setCollectionIntent] = useState('main_collection')
    const [protection, setProtection] = useState('raw')
    const [locationId, setLocationId] = useState('')
    const [costBasis, setCostBasis] = useState('')
    const [grader, setGrader] = useState('PSA')
    const [grade, setGrade] = useState('')
    const [certificationNumber, setCertificationNumber] = useState('')
    const [notes, setNotes] = useState('')
    const [productName, setProductName] = useState('')
    const [productType, setProductType] = useState('Elite Trainer Box')
    const [sealedCondition, setSealedCondition] = useState('factory_sealed')
    const [purchaseDate, setPurchaseDate] = useState(today())

    useEffect(() => {
        if (!isOpen) return
        const nextSource = initialKind === 'bulk'
            ? 'bulk_before_tracking'
            : initialSource || (initialKind === 'sealed' ? 'purchased' : 'other')
        setKind(initialKind)
        setSource(nextSource)
        setCostBasis(defaultPurchasePrice(nextSource) === null ? '' : String(defaultPurchasePrice(nextSource)))
        setStep(1)
    }, [initialKind, initialSource, isOpen])

    const isSealed = kind === 'sealed'
    const isBulk = kind === 'bulk'
    const {data: storageLocations = []} = useQuery({
        queryKey: ['storage-locations'],
        queryFn: () => getStorageLocations(),
        enabled: isOpen,
    })
    const canSubmit = isSealed
        ? productName.trim() && locationId && purchaseDate
        : selectedCard && locationId

    const reset = () => {
        setStep(1)
        setSelectedCard(null)
        setQuantity(1)
        setCondition('NM')
        setVariant('Normal')
        setSource(kind === 'bulk' ? 'bulk_before_tracking' : 'other')
        setCollectionIntent('main_collection')
        setProtection('raw')
        setLocationId('')
        setCostBasis('')
        setGrader('PSA')
        setGrade('')
        setCertificationNumber('')
        setNotes('')
        setProductName('')
        setProductType('Elite Trainer Box')
        setSealedCondition('factory_sealed')
        setPurchaseDate(today())
    }

    const close = () => {
        reset()
        onClose()
    }

    const mutation = useMutation({
        mutationFn: () => {
            if (isSealed) {
                return createProduct({
                    product_name: productName.trim(),
                    product_type: productType,
                    quantity: Number(quantity),
                    sealed_condition: sealedCondition,
                    acquisition_source: source || null,
                    collection_intent: collectionIntent,
                    purchase_price: costBasis === '' ? null : Number(costBasis),
                    purchase_date: purchaseDate,
                    storage_location_id: Number(locationId),
                    notes: notes.trim() || null,
                })
            }
            return addToCollection({
                card_id: selectedCard.id,
                lang: selectedCard.lang || 'en',
                quantity: Number(quantity),
                condition,
                variant,
                acquisition_source: isBulk ? 'bulk_before_tracking' : source,
                collection_intent: isBulk ? 'main_collection' : collectionIntent,
                inventory_kind: isBulk ? 'bulk' : 'owned',
                protection_type: isBulk ? 'raw' : protection,
                storage_location_id: Number(locationId),
                purchase_price: isBulk || costBasis === '' ? null : Number(costBasis),
                grader: ['psa_slab', 'tag_slab'].includes(protection)
                    ? (grader.trim() || (protection === 'tag_slab' ? 'TAG' : 'PSA'))
                    : null,
                grade: ['psa_slab', 'tag_slab'].includes(protection) ? (grade.trim() || null) : null,
                certification_number: ['psa_slab', 'tag_slab'].includes(protection)
                    ? (certificationNumber.trim() || null)
                    : null,
                notes: notes.trim() || null,
            })
        },
        onSuccess: () => {
            toast.success(isSealed ? 'Sealed product filed' : `${selectedCard?.name || 'Card'} filed`)
            queryClient.invalidateQueries({queryKey: ['collection']})
            queryClient.invalidateQueries({queryKey: ['products']})
            queryClient.invalidateQueries({queryKey: ['dashboard']})
            onSaved?.(kind)
            close()
        },
        onError: error => toast.error(getApiErrorMessage(error, 'Could not add this item')),
    })

    const changeKind = nextKind => {
        setKind(nextKind)
        setStep(1)
        setSelectedCard(null)
        setSource(nextKind === 'bulk' ? 'bulk_before_tracking' : nextKind === 'sealed' ? 'purchased' : 'other')
        setCollectionIntent('main_collection')
        setCostBasis('')
        setProtection('raw')
        setGrader('PSA')
    }

    const sourceOptions = useMemo(
        () => ACQUISITION_SOURCES.filter(option => !['bulk_before_tracking', 'unknown'].includes(option.value)),
        [],
    )

    const handleSource = nextSource => {
        setSource(nextSource)
        const suggested = defaultPurchasePrice(nextSource)
        if (suggested !== null && costBasis === '') setCostBasis(String(suggested))
    }

    const handleProtection = nextProtection => {
        setProtection(nextProtection)
        if (nextProtection === 'tag_slab') setGrader('TAG')
        else if (nextProtection === 'psa_slab') setGrader('PSA')
    }

    const canAdvanceFromIdentify = isSealed ? productName.trim() : Boolean(selectedCard)
    const costBasisLabel = costBasis === '' ? 'Cost Basis Needed' : `$${Number(costBasis).toFixed(2)}`
    const selectedItemLabel = isSealed
        ? productName.trim() || 'Sealed product'
        : selectedCard?.name || 'Exact card printing'
    const sourceLabel = isBulk
        ? 'Bulk / before tracking'
        : sourceOptions.find(option => option.value === source)?.label || source
    const protectionLabel = PROTECTION_TYPES.find(option => option.value === protection)?.label || protection
    const storageLabel = storageLocations.find(location => String(location.id) === String(locationId))?.name
        || 'Storage location'

    const back = () => setStep(current => Math.max(1, current - 1))
    const next = () => {
        if (step === 1 && canAdvanceFromIdentify) setStep(2)
        if (step === 2 && canSubmit) setStep(3)
    }

    return (
        <Modal isOpen={isOpen} onClose={close} title="Add collection lot" size="xl" placement="right" className="inventory-intake-modal">
            <form
                className="space-y-5 p-5 sm:p-6"
                onSubmit={event => {
                    event.preventDefault()
                    if (canSubmit) mutation.mutate()
                }}
            >
                <IntakeStepper step={step}/>

                {step === 1 && <>
                <div className="inventory-kind-grid" role="group" aria-label="Collection item type">
                    <IntakeTypeButton
                        active={kind === 'owned'}
                        icon={Sparkles}
                        label="Individual card"
                        description="Raw card or graded slab"
                        onClick={() => changeKind('owned')}
                    />
                    <IntakeTypeButton
                        active={kind === 'bulk'}
                        icon={Box}
                        label="Bulk / before tracking"
                        description="Tracked without per-card value"
                        onClick={() => changeKind('bulk')}
                    />
                    <IntakeTypeButton
                        active={kind === 'sealed'}
                        icon={PackageOpen}
                        label="Sealed product"
                        description="Boxes, packs, tins, bundles"
                        onClick={() => changeKind('sealed')}
                    />
                </div>

                <p className="rounded-xl border border-white/10 bg-black/10 p-3 text-xs text-text-secondary">
                    A Collection Lot is one tracked ownership record: quantity, condition, acquisition source, protection, storage, cost basis, and Card History.
                </p>

                {!isSealed && <CardPicker selectedCard={selectedCard} onSelect={setSelectedCard}/>}

                {isSealed && (
                    <div className="grid gap-4 sm:grid-cols-2 archive-card-reveal">
                        <Field label="Product name" required>
                            <input
                                autoFocus
                                className="input w-full"
                                value={productName}
                                onChange={event => setProductName(event.target.value)}
                                placeholder="Mega Evolution Elite Trainer Box"
                                required
                            />
                        </Field>
                        <Field label="Product type">
                            <select className="select w-full" value={productType}
                                    onChange={event => setProductType(event.target.value)}>
                                {PRODUCT_TYPES.map(type => <option key={type}>{type}</option>)}
                            </select>
                        </Field>
                    </div>
                )}
                </>}

                {step === 2 && isSealed ? (
                    <div className="grid gap-4 sm:grid-cols-2 archive-card-reveal">
                        <Field label="Quantity" required>
                            <input className="input w-full" type="number" min="1" max="999" value={quantity}
                                   onChange={event => setQuantity(event.target.value)}/>
                        </Field>
                        <Field label="Seal condition" required>
                            <select className="select w-full" value={sealedCondition}
                                    onChange={event => setSealedCondition(event.target.value)}>
                                {SEALED_CONDITIONS.map(option => <option key={option.value}
                                                                         value={option.value}>{option.label}</option>)}
                            </select>
                        </Field>
                        <Field label="Acquisition source">
                            <select className="select w-full" value={source}
                                    onChange={event => handleSource(event.target.value)}>
                                {sourceOptions.map(option => <option key={option.value}
                                                                     value={option.value}>{option.label}</option>)}
                            </select>
                        </Field>
                        <Field label="Collection intent">
                            <select className="select w-full" value={collectionIntent}
                                    onChange={event => setCollectionIntent(event.target.value)}>
                                <option value="main_collection">Main Collection</option>
                                <option value="vault">Vault</option>
                                <option value="pc">PC</option>
                            </select>
                        </Field>
                        <Field label="Acquisition date" required>
                            <input className="input w-full" type="date" value={purchaseDate}
                                   onChange={event => setPurchaseDate(event.target.value)}/>
                        </Field>
                        <Field label="Cost basis">
                            <input className="input w-full" type="number" min="0" step="0.01" value={costBasis}
                                   onChange={event => setCostBasis(event.target.value)} placeholder="Cost Basis Needed"/>
                            <p className="mt-1 text-[11px] text-text-muted">Leave blank until the receipt or allocation is known.</p>
                        </Field>
                    </div>
                ) : step === 2 && selectedCard ? (
                    <div className="grid gap-4 sm:grid-cols-2 archive-card-reveal">
                        <Field label="Quantity" required>
                            <input className="input w-full" type="number" min="1" max="999" value={quantity}
                                   onChange={event => setQuantity(event.target.value)}/>
                        </Field>
                        <Field label="Condition" required>
                            <select className="select w-full" value={condition}
                                    onChange={event => setCondition(event.target.value)}>
                                {RAW_CONDITIONS.map(value => <option key={value}>{value}</option>)}
                            </select>
                        </Field>
                        <Field label="Variant" required>
                            <select className="select w-full" value={variant}
                                    onChange={event => setVariant(event.target.value)}>
                                {CARD_VARIANTS.map(value => <option key={value}>{value}</option>)}
                            </select>
                        </Field>
                        {!isBulk && (
                            <Field label="Acquisition source">
                                <select className="select w-full" value={source}
                                        onChange={event => handleSource(event.target.value)}>
                                    {sourceOptions.map(option => <option key={option.value}
                                                                         value={option.value}>{option.label}</option>)}
                                </select>
                            </Field>
                        )}
                        {!isBulk && (
                            <Field label="Protection">
                                <select className="select w-full" value={protection}
                                        onChange={event => handleProtection(event.target.value)}>
                                    {PROTECTION_TYPES.map(option => <option key={option.value}
                                                                            value={option.value}>{option.label}</option>)}
                                </select>
                            </Field>
                        )}
                        {!isBulk && (
                            <Field label="Collection intent">
                                <select className="select w-full" value={collectionIntent}
                                        onChange={event => setCollectionIntent(event.target.value)}>
                                    <option value="main_collection">Main Collection</option>
                                    <option value="vault">Vault</option>
                                    <option value="pc">PC</option>
                                </select>
                            </Field>
                        )}
                        {!isBulk && (
                            <Field label="Cost basis"
                                   hint={source === 'pulled' ? 'Pulled cards default to $4.49.' : 'Optional for manually added cards.'}>
                                <input className="input w-full" type="number" min="0" step="0.01" value={costBasis}
                                       onChange={event => setCostBasis(event.target.value)}
                                       placeholder="No cost entered"/>
                            </Field>
                        )}
                        {['psa_slab', 'tag_slab'].includes(protection) && !isBulk && (
                            <>
                                <Field label="Grading company" required>
                                    <input className="input w-full" value={grader}
                                           onChange={event => setGrader(event.target.value)}
                                           placeholder={protection === 'tag_slab' ? 'TAG' : 'PSA'}/>
                                </Field>
                                <Field label="Grade">
                                    <input className="input w-full" value={grade}
                                           onChange={event => setGrade(event.target.value)} placeholder="Gem Mint 10"/>
                                </Field>
                                <Field label="Certification number">
                                    <input className="input w-full" value={certificationNumber}
                                           onChange={event => setCertificationNumber(event.target.value)}/>
                                </Field>
                            </>
                        )}
                    </div>
                ) : null}

                {step === 2 && (isSealed || selectedCard) && (
                    <div className="grid gap-4 sm:grid-cols-2">
                        <LocationSelect value={locationId} onChange={setLocationId}/>
                        <Field label="Collector note" hint="Optional context that stays with this exact record.">
                            <textarea className="input min-h-24 w-full resize-y" value={notes}
                                      onChange={event => setNotes(event.target.value)}
                                      placeholder="Protection, provenance, pull story, or filing note…"/>
                        </Field>
                    </div>
                )}

                {step === 3 && (
                    <section className="intake-review archive-card-reveal" aria-label="Collection lot review">
                        <div>
                            <span className="archive-eyebrow">Ready to file</span>
                            <h3>{selectedItemLabel}</h3>
                            <p>Review the ownership record before John John files it locally.</p>
                        </div>
                        <div className="intake-review-grid">
                            <ReviewRow label="Type" value={isSealed ? productType : isBulk ? 'Bulk / before tracking' : 'Individual card'}/>
                            <ReviewRow label="Quantity" value={quantity}/>
                            {!isSealed && <ReviewRow label="Condition" value={condition}/>} 
                            {!isSealed && !isBulk && <ReviewRow label="Protection" value={protectionLabel}/>} 
                            {!isBulk && <ReviewRow label="Collection" value={collectionIntent === 'main_collection' ? 'Main Collection' : collectionIntent === 'vault' ? 'Vault' : 'PC'}/>} 
                            <ReviewRow label="Source" value={sourceLabel}/>
                            <ReviewRow label="Cost basis" value={costBasisLabel} muted={costBasis === ''}/>
                            <ReviewRow label="Storage" value={storageLabel}/>
                        </div>
                        {notes.trim() && <p className="intake-review-note">“{notes.trim()}”</p>}
                    </section>
                )}

                <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
                    <button type="button" className="btn-ghost justify-center" onClick={close}>Cancel</button>
                    {step > 1 && <button type="button" className="btn-ghost justify-center" onClick={back}><ChevronLeft size={16}/> Back</button>}
                    {step < 3 ? (
                        <button type="button" className="btn-primary justify-center"
                                disabled={step === 1 ? !canAdvanceFromIdentify : !canSubmit}
                                onClick={next}>
                            Continue <ChevronRight size={16}/>
                        </button>
                    ) : (
                        <button type="submit" className="btn-primary justify-center" disabled={!canSubmit || mutation.isPending}>
                            {mutation.isPending ? <span className="archive-loading-orbit"/> : <Plus size={16}/>}
                            {mutation.isPending ? 'Filing…' : 'Add to collection'}
                        </button>
                    )}
                </div>
            </form>
        </Modal>
    )
}
