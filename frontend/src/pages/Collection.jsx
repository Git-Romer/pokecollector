import SplitText from '../components/reactbits/SplitText'
import {useEffect, useId, useMemo, useRef, useState} from 'react'
import {Link, useSearchParams} from 'react-router-dom'
import {createPortal} from 'react-dom'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {
    ArchiveRestore,
    ArrowLeft,
    BookOpen,
    Boxes,
    Check,
    ChevronDown,
    ChevronUp,
    Copy,
    Download,
    FileSpreadsheet,
    Filter,
    Grid2X2,
    Heart,
    Library,
    List,
    Package,
    PenLine,
    Plus,
    Search,
    SortAsc,
    Trash2,
    X
} from 'lucide-react'
import {
    addCollectionItemToBinder,
    addToCollection,
    exportCSV,
    exportPDF,
    exportExcel,
    getBinders,
    getCollection,
    getSets,
    getStorageLocations,
    getWishlist,
    removeFromCollection,
    updateCardCustomImage,
    updateCollectionItem
} from '../api/client'
import {CustomCardModal} from '../components/CardItem'
import {useSettings} from '../contexts/SettingsContext'
import CardImage from '../components/CardImage'
import CardListItem from '../components/CardListItem'
import MoneyInput from '../components/MoneyInput'
import TabNav from '../components/TabNav'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import {useTilt} from '../hooks/useTilt'
import {cardImageUrl, resolveCardImageUrl} from '../utils/imageUrl'
import {cardNumberMatches} from '../utils/cardNumbers'
import {normalizeSearchText, textIncludes} from '../utils/textSearch'
import FallbackBadges from '../components/FallbackBadges'
import {getEffectiveCardPrice} from '../utils/prices'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'
import {tcgdexLanguageBadgeClass, tcgdexLanguageLabel} from '../utils/tcgdexLanguages'
import {invalidateTcgdexFilterLanguages} from '../utils/queryInvalidation'
import {useVisibleTcgdexLanguages} from '../hooks/useVisibleTcgdexLanguages'
import {formatMoneyInputValue, parseMoneyInputValue} from '../utils/moneyInput'
import {
    ACQUISITION_SOURCES,
    defaultPurchasePrice,
    PROTECTION_TYPES,
    RAW_CONDITIONS,
    REMOVAL_REASONS
} from '../utils/collectionMetadata'
import InventoryIntakeModal from '../components/InventoryIntakeModal'
import ExcelImportModal from '../components/ExcelImportModal'
import SealedCollectionView from '../components/SealedCollectionView'
import InventoryHistoryView from '../components/InventoryHistoryView'

function TiltBinderCard({className, onClick, children}) {
    const {ref, onMouseMove, onMouseEnter, onMouseLeave} = useTilt(10)
    return (
        <div
            ref={ref}
            className={className}
            onClick={onClick}
            onMouseMove={onMouseMove}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            {children}
        </div>
    )
}

const CONDITIONS = RAW_CONDITIONS
const CONDITION_COLORS = {
    Mint: 'badge-green',
    NM: 'badge-blue',
    LP: 'badge-yellow',
    MP: 'badge-red',
    HP: 'badge-red',
}
const CARD_VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']
const VARIANT_COLORS = {
    'Holo': 'badge-purple',
    'Reverse Holo': 'badge-blue',
    'First Edition': 'badge-green',
    'Normal': 'badge-gray',
}

const CARD_CATEGORY_OPTIONS = ['Pokémon', 'Trainer', 'Energy']
const CARD_SUBTYPE_OPTIONS = ['Item', 'Supporter', 'Stadium', 'Pokémon Tool', 'EX', 'ex', 'GX', 'Stage 1', 'Stage 2', 'Basic']

const normalizeCardFilterValue = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()

const normalizeCardFilterLabelKey = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()

const CARD_FILTER_DISPLAY_LABELS = new Map(
    [...CARD_CATEGORY_OPTIONS, ...CARD_SUBTYPE_OPTIONS].map(label => [normalizeCardFilterLabelKey(label), label])
)

const getPreferredCardFilterLabel = (value) => (
    CARD_FILTER_DISPLAY_LABELS.get(normalizeCardFilterLabelKey(value)) || String(value || '').trim()
)

const getCardCategoryLabel = (card) => {
    const supertype = String(card?.supertype || '').trim()
    if (normalizeCardFilterValue(supertype) === 'pokemon') return 'Pokémon'
    if (supertype) return getPreferredCardFilterLabel(supertype)
    return ''
}

const getCardSubtypeLabels = (card) => {
    const labels = new Set()
    ;(card?.subtypes || []).forEach(subtype => {
        if (subtype) labels.add(getPreferredCardFilterLabel(subtype))
    })
    ;[card?.trainer_type, card?.energy_type, card?.stage].forEach(subtype => {
        if (subtype) labels.add(getPreferredCardFilterLabel(subtype))
    })
    return [...labels].filter(Boolean)
}

const sortCardFilterLabels = (preferredOrder, labels) => {
    const preferredIndex = new Map(preferredOrder.map((label, index) => [normalizeCardFilterLabelKey(label), index]))
    return [...labels].sort((a, b) => {
        const indexA = preferredIndex.get(normalizeCardFilterLabelKey(a))
        const indexB = preferredIndex.get(normalizeCardFilterLabelKey(b))
        if (indexA !== undefined || indexB !== undefined) {
            return (indexA ?? Number.MAX_SAFE_INTEGER) - (indexB ?? Number.MAX_SAFE_INTEGER)
        }
        return a.localeCompare(b)
    })
}

const toggleFilterValue = (values, value) => (
    values.includes(value) ? values.filter(item => item !== value) : [...values, value]
)

const getProductSourceSummary = (item) => {
    const sources = (item?.product_sources || []).filter(source => (source?.active_quantity || 0) > 0)
    if (sources.length === 0) return null
    const primary = sources[0]
    const totalQuantity = sources.reduce((sum, source) => sum + (source.active_quantity || 0), 0)
    const label = sources.length > 1 ? `${primary.product_name} +${sources.length - 1}` : primary.product_name
    const title = sources
        .map(source => `${source.product_name}${source.active_quantity > 1 ? ` x${source.active_quantity}` : ''}`)
        .join('\n')
    return {sources, primary, totalQuantity, label, title}
}

function ProductSourceBadge({item, t, compact = false, className = ''}) {
    const summary = getProductSourceSummary(item)
    if (!summary) return null

    if (compact) {
        return (
            <span
                title={`${t('collection.foundIn')}: ${summary.title}`}
                className={clsx(
                    'inline-flex items-center justify-center rounded-full border border-yellow/40 bg-bg/85 text-yellow shadow-lg backdrop-blur-sm',
                    className || 'h-6 w-6'
                )}
            >
        <Package size={12}/>
      </span>
        )
    }

    return (
        <span
            title={`${t('collection.foundIn')}: ${summary.title}`}
            className={clsx(
                'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-yellow/30 bg-yellow/10 px-2 py-0.5 text-[10px] font-semibold leading-tight text-yellow',
                className
            )}
        >
      <Package size={12} className="flex-shrink-0"/>
      <span className="truncate">{summary.label}</span>
            {summary.totalQuantity > 1 && <span className="flex-shrink-0">x{summary.totalQuantity}</span>}
    </span>
    )
}


const naturalCardNumberKey = (number) => String(number || '').trim().split(/(\d+)/).map(part => /^\d+$/.test(part) ? part.padStart(8, '0') : part.toLowerCase()).join('')

const collectionCardIdKey = (item) => {
    const card = item.card || {}
    const setKey = (card.set_ref?.abbreviation || card.set_id || '').toLowerCase()
    return `${setKey}|${naturalCardNumberKey(card.number)}|${card.name || ''}`
}

// ─── Holo shimmer overlay ──────────────────────────────────────────────────
const HOLO_KEYFRAMES = `
@keyframes holoShimmer {
  0%   { transform: translateX(-100%) rotate(25deg); opacity: 0; }
  15%  { opacity: 0.7; }
  50%  { opacity: 0.5; }
  85%  { opacity: 0.7; }
  100% { transform: translateX(200%) rotate(25deg); opacity: 0; }
}
@keyframes holoShimmerAlt {
  0%   { transform: translateX(-120%) rotate(-20deg); opacity: 0; }
  20%  { opacity: 0.6; }
  80%  { opacity: 0.4; }
  100% { transform: translateX(220%) rotate(-20deg); opacity: 0; }
}
`

if (typeof document !== 'undefined' && !document.getElementById('holo-keyframes')) {
    const style = document.createElement('style')
    style.id = 'holo-keyframes'
    style.textContent = HOLO_KEYFRAMES
    document.head.appendChild(style)
}

function HoloOverlay({variant}) {
    if (!variant) return null
    const v = variant.toLowerCase()

    let gradient = null
    let animationName = 'holoShimmer'
    let duration = '3s'
    let delay = '0s'

    if (v.includes('reverse')) {
        // Blue/cyan shimmer for Reverse Holo
        gradient = 'linear-gradient(105deg, transparent 30%, rgba(99,179,237,0.25) 50%, rgba(147,210,255,0.15) 55%, transparent 70%)'
        duration = '2.8s'
        animationName = 'holoShimmerAlt'
    } else if (v.includes('holo') || v === 'holo') {
        // Gold/rainbow shimmer for Holo
        gradient = 'linear-gradient(105deg, transparent 25%, rgba(245,200,66,0.20) 45%, rgba(255,230,100,0.15) 52%, rgba(245,200,66,0.20) 58%, transparent 75%)'
        duration = '3.2s'
    } else if (v.includes('alt art') || v.includes('illustration rare') || v.includes('special illustration')) {
        // Purple shimmer for Alt Art / Special Illustration
        gradient = 'linear-gradient(105deg, transparent 20%, rgba(167,139,250,0.20) 42%, rgba(196,181,253,0.15) 50%, rgba(167,139,250,0.20) 58%, transparent 78%)'
        duration = '4s'
    } else if (v.includes('first edition') || v.includes('1st edition')) {
        // Green shimmer for 1st Edition
        gradient = 'linear-gradient(105deg, transparent 30%, rgba(52,211,153,0.25) 50%, rgba(110,231,183,0.15) 55%, transparent 70%)'
        duration = '3.5s'
    } else {
        // Generic shimmer for any other special variant
        gradient = 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.25) 50%, transparent 70%)'
        duration = '3s'
    }

    if (!gradient) return null

    return (
        <div
            className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl"
            style={{zIndex: 2}}
        >
            <div
                style={{
                    position: 'absolute',
                    top: '-20%',
                    left: 0,
                    width: '60%',
                    height: '140%',
                    background: gradient,
                    animation: `${animationName} ${duration} ease-in-out ${delay} infinite`,
                    mixBlendMode: 'screen',
                }}
            />
        </div>
    )
}

// ─── CollectionEditModal ────────────────────────────────────────────────────
// Opens when clicking any card in the collection. Allows editing + deleting.
function CollectionEditModal({item, onClose}) {
    const {t, formatPrice, pricePrimaryField, exchangeRate, exchangeRateReady} = useSettings()
    const queryClient = useQueryClient()
    const card = item.card
    const itemPriceInput = formatMoneyInputValue(item.purchase_price, exchangeRate)
    const productSourceSummary = getProductSourceSummary(item)

    const [quantity, setQuantity] = useState(item.quantity)
    const [condition, setCondition] = useState(item.condition || 'NM')
    const [variant, setVariant] = useState(item.variant || 'Normal')
    const [lang, setLang] = useState(item.lang || 'en')
    const [price, setPrice] = useState(itemPriceInput)
    const [acquisitionSource, setAcquisitionSource] = useState(item.acquisition_source || '');
    const [collectionIntent, setCollectionIntent] = useState(item.collection_intent || 'main_collection');
    const [isGrail, setIsGrail] = useState(Boolean(item.is_grail));
    const [cardHistory, setCardHistory] = useState(item.card_history || '')
    const [protectionType, setProtectionType] = useState(item.protection_type || 'raw')
    const [storageLocationId, setStorageLocationId] = useState(String(item.storage_location_id || ''))
    const [storageType, setStorageType] = useState(item.storage_type || '')
    const [storageDetail, setStorageDetail] = useState(item.storage_detail || '')
    const [grader, setGrader] = useState(item.grader || '')
    const [grade, setGrade] = useState(item.grade || '')
    const [certificationNumber, setCertificationNumber] = useState(item.certification_number || '')
    const [notes, setNotes] = useState(item.notes || '')
    const [showRemoveForm, setShowRemoveForm] = useState(false)
    const [removalReason, setRemovalReason] = useState('other')
    const [removalNotes, setRemovalNotes] = useState('')

    const [showAddVersionForm, setShowAddVersionForm] = useState(false)
    const [newVersionQuantity, setNewVersionQuantity] = useState(1)
    const [newVersionCondition, setNewVersionCondition] = useState(item.condition || 'NM')
    const [newVersionVariant, setNewVersionVariant] = useState(item.variant || 'Normal')
    const [newVersionLang, setNewVersionLang] = useState(item.lang || 'en')
    const [newVersionPrice, setNewVersionPrice] = useState('')
    const [newVersionAcquisitionSource, setNewVersionAcquisitionSource] = useState('')
    const [newVersionProtectionType, setNewVersionProtectionType] = useState(item.protection_type || 'raw')
    const [newVersionStorageLocationId, setNewVersionStorageLocationId] = useState(String(item.storage_location_id || ''))
    const [newVersionStorageType, setNewVersionStorageType] = useState('')
    const [newVersionStorageDetail, setNewVersionStorageDetail] = useState('')
    const [newVersionGrader, setNewVersionGrader] = useState('')
    const [newVersionGrade, setNewVersionGrade] = useState('')
    const [newVersionCertificationNumber, setNewVersionCertificationNumber] = useState('')
    const [newVersionNotes, setNewVersionNotes] = useState('')

    const [customImageUrl, setCustomImageUrl] = useState(card?.custom_image_url || '')
    const [savedCustomImageUrl, setSavedCustomImageUrl] = useState(card?.custom_image_url || '')
    const [customImageVersion, setCustomImageVersion] = useState(0)
    const customImageInputId = useId()

    const {data: storageLocations = []} = useQuery({
        queryKey: ['storage-locations'],
        queryFn: () => getStorageLocations(),
    })

    const handleAcquisitionSourceChange = (newSource) => {
        setAcquisitionSource(newSource)
        if (!price || price.trim() === '') {
            const defaultPrice = defaultPurchasePrice(newSource)
            if (defaultPrice !== null) {
                setPrice(formatMoneyInputValue(defaultPrice, exchangeRate))
            }
        }
    }

    const handleNewVersionAcquisitionSourceChange = (newSource) => {
        setNewVersionAcquisitionSource(newSource)
        if (!newVersionPrice || newVersionPrice.trim() === '') {
            const defaultPrice = defaultPurchasePrice(newSource)
            if (defaultPrice !== null) {
                setNewVersionPrice(formatMoneyInputValue(defaultPrice, exchangeRate))
            }
        }
    }

    const prevItemRef = useRef({
        id: item.id,
        quantity: item.quantity,
        condition: item.condition || 'NM',
        variant: item.variant || 'Normal',
        lang: item.lang || 'en',
        price: itemPriceInput,
        customImageUrl: card?.custom_image_url || '',
        acquisitionSource: item.acquisition_source || '',
        collectionIntent: item.collection_intent || 'main_collection',
        isGrail: Boolean(item.is_grail),
        cardHistory: item.card_history || '',
        protectionType: item.protection_type || 'raw',
        storageLocationId: String(item.storage_location_id || ''),
        storageType: item.storage_type || '',
        storageDetail: item.storage_detail || '',
        grader: item.grader || '',
        grade: item.grade || '',
        certificationNumber: item.certification_number || '',
        notes: item.notes || '',
    })

    useEffect(() => {
        const nextItem = {
            id: item.id,
            quantity: item.quantity,
            condition: item.condition || 'NM',
            variant: item.variant || 'Normal',
            lang: item.lang || 'en',
            price: itemPriceInput,
            customImageUrl: card?.custom_image_url || '',
            acquisitionSource: item.acquisition_source || '',
            collectionIntent: item.collection_intent || 'main_collection',
            isGrail: Boolean(item.is_grail),
            cardHistory: item.card_history || '',
            protectionType: item.protection_type || 'raw',
            storageLocationId: String(item.storage_location_id || ''),
            storageType: item.storage_type || '',
            storageDetail: item.storage_detail || '',
            grader: item.grader || '',
            grade: item.grade || '',
            certificationNumber: item.certification_number || '',
            notes: item.notes || '',
        }

        const prevItem = prevItemRef.current
        const isNewItem = nextItem.id !== prevItem.id

        if (isNewItem) {
            setQuantity(nextItem.quantity)
            setCondition(nextItem.condition)
            setVariant(nextItem.variant)
            setLang(nextItem.lang)
            setPrice(nextItem.price)
            setCustomImageUrl(nextItem.customImageUrl)
            setSavedCustomImageUrl(nextItem.customImageUrl)
            setAcquisitionSource(nextItem.acquisitionSource)
            setCollectionIntent(nextItem.collectionIntent)
            setIsGrail(nextItem.isGrail)
            setCardHistory(nextItem.cardHistory)
            setProtectionType(nextItem.protectionType)
            setStorageLocationId(nextItem.storageLocationId)
            setStorageType(nextItem.storageType)
            setStorageDetail(nextItem.storageDetail)
            setGrader(nextItem.grader)
            setGrade(nextItem.grade)
            setCertificationNumber(nextItem.certificationNumber)
            setNotes(nextItem.notes)
        } else {
            if (quantity === prevItem.quantity && nextItem.quantity !== prevItem.quantity) {
                setQuantity(nextItem.quantity)
            }
            if (condition === prevItem.condition && nextItem.condition !== prevItem.condition) {
                setCondition(nextItem.condition)
            }
            if (variant === prevItem.variant && nextItem.variant !== prevItem.variant) {
                setVariant(nextItem.variant)
            }
            if (lang === prevItem.lang && nextItem.lang !== prevItem.lang) {
                setLang(nextItem.lang)
            }
            if (price === prevItem.price && nextItem.price !== prevItem.price) {
                setPrice(nextItem.price)
            }
            if (customImageUrl === prevItem.customImageUrl && nextItem.customImageUrl !== prevItem.customImageUrl) {
                setCustomImageUrl(nextItem.customImageUrl)
                setSavedCustomImageUrl(nextItem.customImageUrl)
            }
            if (acquisitionSource === prevItem.acquisitionSource && nextItem.acquisitionSource !== prevItem.acquisitionSource) {
                setAcquisitionSource(nextItem.acquisitionSource)
            }
            if (collectionIntent === prevItem.collectionIntent && nextItem.collectionIntent !== prevItem.collectionIntent) {
                setCollectionIntent(nextItem.collectionIntent)
            }
            if (isGrail === prevItem.isGrail && nextItem.isGrail !== prevItem.isGrail) {
                setIsGrail(nextItem.isGrail)
            }
            if (cardHistory === prevItem.cardHistory && nextItem.cardHistory !== prevItem.cardHistory) {
                setCardHistory(nextItem.cardHistory)
            }
            if (protectionType === prevItem.protectionType && nextItem.protectionType !== prevItem.protectionType) {
                setProtectionType(nextItem.protectionType)
            }
            if (storageLocationId === prevItem.storageLocationId && nextItem.storageLocationId !== prevItem.storageLocationId) {
                setStorageLocationId(nextItem.storageLocationId)
            }
            if (storageType === prevItem.storageType && nextItem.storageType !== prevItem.storageType) {
                setStorageType(nextItem.storageType)
            }
            if (storageDetail === prevItem.storageDetail && nextItem.storageDetail !== prevItem.storageDetail) {
                setStorageDetail(nextItem.storageDetail)
            }
            if (grader === prevItem.grader && nextItem.grader !== prevItem.grader) {
                setGrader(nextItem.grader)
            }
            if (grade === prevItem.grade && nextItem.grade !== prevItem.grade) {
                setGrade(nextItem.grade)
            }
            if (certificationNumber === prevItem.certificationNumber && nextItem.certificationNumber !== prevItem.certificationNumber) {
                setCertificationNumber(nextItem.certificationNumber)
            }
            if (notes === prevItem.notes && nextItem.notes !== prevItem.notes) {
                setNotes(nextItem.notes)
            }
        }

        prevItemRef.current = nextItem
    }, [
        item.id,
        item.quantity,
        item.condition,
        item.variant,
        item.lang,
        item.purchase_price,
        itemPriceInput,
        card?.custom_image_url,
        item.acquisition_source,
        item.collection_intent,
        item.is_grail,
        item.card_history,
        item.protection_type,
        item.storage_location_id,
        item.storage_type,
        item.storage_detail,
        item.grader,
        item.grade,
        item.certification_number,
        item.notes
    ])

    const {data: binders = []} = useQuery({
        queryKey: ['binders'],
        queryFn: () => getBinders().then(r => r.data),
    })
    const collectionBinders = binders.filter(binder => (binder.binder_type || 'collection') === 'collection')

    const hasApiImage = Boolean(card?.images?.large || card?.images_large || card?.images?.small || card?.images_small || card?.image)
    const canEditCustomImage = card && !card.is_custom && !hasApiImage && typeof item.card_id === 'string'
    const customImageProxyUrl = canEditCustomImage && savedCustomImageUrl
        ? `${cardImageUrl(item.card_id, 'large')}?v=${customImageVersion}`
        : null
    const cardImage = customImageProxyUrl || resolveCardImageUrl(card, 'large')

    const updateMutation = useMutation({
        mutationFn: () => updateCollectionItem(item.id, {
            quantity,
            condition,
            variant,
            lang,
            purchase_price: parseMoneyInputValue(price, exchangeRate, null),
            acquisition_source: acquisitionSource || null,
            collection_intent: collectionIntent,
            is_grail: isGrail,
            card_history: cardHistory.trim() || null,
            protection_type: protectionType,
            storage_location_id: storageLocationId ? Number(storageLocationId) : null,
            storage_type: storageType || null,
            storage_detail: storageDetail || null,
            grader: grader || null,
            grade: grade || null,
            certification_number: certificationNumber || null,
            notes: notes || null,
        }),
        onSuccess: () => {
            toast.success(t('collection.updated'))
            queryClient.invalidateQueries({queryKey: ['collection']})
            invalidateTcgdexFilterLanguages(queryClient)
            queryClient.invalidateQueries({queryKey: ['dashboard']})
            queryClient.invalidateQueries({predicate: (query) => query.queryKey[0] === 'card-search'})
            onClose()
        },
        onError: () => toast.error(t('collection.updateFailed')),
    })

    const deleteMutation = useMutation({
        mutationFn: () => removeFromCollection(item.id, {
            reason: removalReason,
            notes: removalNotes.trim() || null,
        }),
        onSuccess: () => {
            toast.success(t('collection.removed'))
            queryClient.invalidateQueries({queryKey: ['collection']})
            invalidateTcgdexFilterLanguages(queryClient)
            queryClient.invalidateQueries({queryKey: ['dashboard']})
            queryClient.invalidateQueries({predicate: (query) => query.queryKey[0] === 'card-search'})
            onClose()
        },
        onError: () => toast.error(t('collection.removeFailed')),
    })

    const cloneMutation = useMutation({
        mutationFn: () => addToCollection({
            card_id: item.card_id,
            quantity: Math.max(1, parseInt(newVersionQuantity, 10) || 1),
            condition: newVersionCondition,
            variant: newVersionVariant,
            lang: newVersionLang,
            purchase_price: parseMoneyInputValue(newVersionPrice, exchangeRate),
            acquisition_source: newVersionAcquisitionSource || null,
            protection_type: newVersionProtectionType,
            storage_location_id: newVersionStorageLocationId ? Number(newVersionStorageLocationId) : null,
            storage_type: newVersionStorageType || null,
            storage_detail: newVersionStorageDetail || null,
            grader: newVersionGrader || null,
            grade: newVersionGrade || null,
            certification_number: newVersionCertificationNumber || null,
            notes: newVersionNotes || null,
        }),
        onSuccess: () => {
            toast.success(t('collection.versionAdded'))
            queryClient.invalidateQueries({queryKey: ['collection']})
            invalidateTcgdexFilterLanguages(queryClient)
            queryClient.invalidateQueries({queryKey: ['dashboard']})
            queryClient.invalidateQueries({predicate: (query) => query.queryKey[0] === 'card-search'})
            onClose()
        },
        onError: () => toast.error(t('card.addFailed')),
    })

    const addToBinderMutation = useMutation({
        mutationFn: (binderId) => addCollectionItemToBinder(binderId, item.id),
        onSuccess: () => {
            toast.success(t('collection.addedToBinder'))
            queryClient.invalidateQueries({queryKey: ['binders']})
            invalidateTcgdexFilterLanguages(queryClient)
        },
        onError: (err) => toast.error(err?.response?.data?.detail || t('card.addFailed')),
    })

    const customImageMutation = useMutation({
        mutationFn: (url) => updateCardCustomImage(item.card_id, {custom_image_url: url || null}),
        onSuccess: (updatedCard) => {
            const nextUrl = updatedCard?.custom_image_url || ''
            setCustomImageUrl(nextUrl)
            setSavedCustomImageUrl(nextUrl)
            setCustomImageVersion((version) => version + 1)
            toast.success(t('card.customImageSaved'))
            queryClient.invalidateQueries({queryKey: ['collection']})
            invalidateTcgdexFilterLanguages(queryClient)
            queryClient.invalidateQueries({queryKey: ['dashboard']})
            queryClient.invalidateQueries({queryKey: ['wishlist']})
            queryClient.invalidateQueries({queryKey: ['set-checklist']})
        },
        onError: (err) => {
            const detail = err?.response?.data?.detail || t('common.error')
            toast.error(detail)
        },
    })

    const handleDelete = () => {
        setShowRemoveForm(true)
    }

    const openAddVersionForm = () => {
        setNewVersionQuantity(1)
        setNewVersionCondition(condition)
        setNewVersionVariant(variant)
        setNewVersionLang(lang)
        setNewVersionPrice('')
        setNewVersionAcquisitionSource(acquisitionSource)
        setNewVersionProtectionType(protectionType)
        setNewVersionStorageLocationId(storageLocationId)
        setNewVersionStorageType(storageType)
        setNewVersionStorageDetail(storageDetail)
        setNewVersionGrader(grader)
        setNewVersionGrade(grade)
        setNewVersionCertificationNumber(certificationNumber)
        setNewVersionNotes(notes)
        setShowAddVersionForm(true)
    }

    const binderSelect = (
        collectionBinders.length === 0 ? (
            <div
                className="select select-no-arrow text-sm flex items-center justify-center text-center text-text-muted cursor-not-allowed">
                {t('collection.noCollectionBinders')}
            </div>
        ) : (
            <select
                className="select text-sm text-center [text-align-last:center] font-medium"
                value=""
                onChange={(e) => {
                    if (e.target.value) addToBinderMutation.mutate(parseInt(e.target.value, 10))
                }}
                disabled={addToBinderMutation.isPending}
            >
                <option value="">{t('collection.addToBinder')}</option>
                {collectionBinders.map(binder => <option key={binder.id} value={binder.id}>{binder.name}</option>)}
            </select>
        )
    )

    const renderCardHeader = () => (
        <div className="flex items-start gap-4 mb-5">
            {cardImage && (
                <img src={cardImage} alt={card?.name} className="w-20 rounded-xl shadow-lg flex-shrink-0"/>
            )}
            <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-base font-bold text-text-primary break-words">{card?.name}</h2>
                        {card?.set_ref?.name && (
                            <p className="text-xs text-text-secondary mt-0.5">
                                {card.set_ref.name}{card?.number ? ` · #${card.number}` : ''}
                            </p>
                        )}
                        {card?.rarity && <p className="text-xs text-text-muted mt-0.5">{card.rarity}</p>}
                        {getEffectiveCardPrice(card, item.variant, pricePrimaryField) > 0 && (
                            <p className="text-sm font-bold text-green mt-1">{formatPrice(getEffectiveCardPrice(card, item.variant, pricePrimaryField))}</p>
                        )}
                    </div>
                    <button onClick={onClose} className="text-text-muted hover:text-text-primary flex-shrink-0 p-1">
                        <X size={18}/>
                    </button>
                </div>
            </div>
        </div>
    )

    return createPortal(
        <div
            className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm md:flex md:items-center md:justify-center md:bg-black/80"
            onClick={onClose}
        >
            <div
                className={[
                    'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
                    'bg-bg-surface border-t border-border more-sheet-enter',
                    'md:static md:rounded-2xl md:border md:max-w-lg md:w-full md:max-h-[85vh] md:animate-none',
                ].join(' ')}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex justify-center pt-3 pb-1 md:hidden">
                    <div className="w-10 h-1 bg-border rounded-full"/>
                </div>

                <div className="grid overflow-hidden [perspective:1200px]">
                    <div
                        aria-hidden={showAddVersionForm}
                        className={clsx(
                            'col-start-1 row-start-1 p-5 transition-all duration-300 ease-out transform-gpu',
                            showAddVersionForm
                                ? '-translate-x-10 -rotate-2 scale-[0.97] opacity-0 pointer-events-none'
                                : 'translate-x-0 rotate-0 scale-100 opacity-100'
                        )}
                    >
                        {renderCardHeader()}

                        {productSourceSummary && (
                            <div className="mb-4 rounded-xl border border-yellow/25 bg-yellow/10 px-3 py-2">
                                <div
                                    className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-yellow">
                                    <Package size={14}/>
                                    <span>{t('collection.foundIn')}</span>
                                </div>
                                <div className="mt-2 space-y-1">
                                    {productSourceSummary.sources.map(source => (
                                        <div key={source.product_card_id}
                                             className="flex items-center justify-between gap-3 text-sm">
                                            <div className="min-w-0">
                                                <p className="truncate font-medium text-text-primary">{source.product_name}</p>
                                                {[source.product_type, source.purchase_date].filter(Boolean).length > 0 && (
                                                    <p className="truncate text-xs text-text-muted">
                                                        {[source.product_type, source.purchase_date].filter(Boolean).join(' · ')}
                                                    </p>
                                                )}
                                            </div>
                                            {source.active_quantity > 1 && (
                                                <span
                                                    className="flex-shrink-0 rounded-full bg-bg/70 px-2 py-0.5 text-xs font-bold text-yellow">
                          x{source.active_quantity}
                        </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Edit Form */}
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                                    <input
                                        type="number" min="1" value={quantity}
                                        onChange={e => setQuantity(parseInt(e.target.value) || 1)}
                                        className="input"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                                    <select value={condition} onChange={e => setCondition(e.target.value)}
                                            className="select">
                                        {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
                                <select value={variant} onChange={e => setVariant(e.target.value)} className="select">
                                    {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                                </select>
                            </div>

                            <div>
                                <label
                                    className="text-xs text-text-muted mb-1.5 block">🌐 {t('lang.selectLabel')}</label>
                                <TcgdexLanguageSelect value={lang} onChange={setLang} className="select w-full"/>
                            </div>

                            <div>
                                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                                <MoneyInput
                                    placeholder={t('card.purchasePricePlaceholder')}
                                    value={price}
                                    onChange={e => setPrice(e.target.value)}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Acquisition Source</label>
                                    <select
                                        value={acquisitionSource}
                                        onChange={e => handleAcquisitionSourceChange(e.target.value)}
                                        className="select"
                                    >
                                        <option value="">Select source</option>
                                        {ACQUISITION_SOURCES.map(src => (
                                            <option key={src.value} value={src.value}>{src.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Protection</label>
                                    <select value={protectionType} onChange={e => setProtectionType(e.target.value)}
                                            className="select w-full">
                                        {PROTECTION_TYPES.map(option => <option key={option.value}
                                                                                value={option.value}>{option.label}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Collection</label>
                                    <select value={collectionIntent} onChange={e => setCollectionIntent(e.target.value)} className="select w-full">
                                        <option value="main_collection">Main Collection</option>
                                        <option value="vault">Vault</option>
                                        <option value="pc">PC</option>
                                    </select>
                                </div>
                                <label className="flex items-end gap-2 pb-2 text-sm text-text-secondary cursor-pointer">
                                    <input type="checkbox" checked={isGrail} onChange={e => setIsGrail(e.target.checked)} className="h-4 w-4 accent-yellow"/>
                                    <span>★ Grail Card</span>
                                </label>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Storage Location</label>
                                    <select value={storageLocationId}
                                            onChange={e => setStorageLocationId(e.target.value)}
                                            className="select w-full" required>
                                        <option value="">Choose a location</option>
                                        {storageLocations.map(location => <option key={location.id}
                                                                                  value={location.id}>{location.name}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Grader</label>
                                    <input
                                        type="text"
                                        value={grader}
                                        placeholder={['psa_slab', 'tag_slab'].includes(protectionType) ? (protectionType === 'tag_slab' ? 'TAG' : 'PSA, BGS, CGC…') : 'Only for graded slabs'}
                                        onChange={e => setGrader(e.target.value)}
                                        className="input w-full"
                                        disabled={!['psa_slab', 'tag_slab'].includes(protectionType)}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Grade</label>
                                    <input
                                        type="text"
                                        value={grade}
                                        placeholder="e.g. Gem Mint 10"
                                        onChange={e => setGrade(e.target.value)}
                                        className="input w-full"
                                        disabled={!['psa_slab', 'tag_slab'].includes(protectionType)}
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Certification #</label>
                                    <input
                                        type="text"
                                        value={certificationNumber}
                                        placeholder="e.g. 12345678"
                                        onChange={e => setCertificationNumber(e.target.value)}
                                        className="input w-full"
                                        disabled={!['psa_slab', 'tag_slab'].includes(protectionType)}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Storage Type</label>
                                    <input
                                        type="text"
                                        value={storageType}
                                        placeholder="e.g. Binder, slab case"
                                        onChange={e => setStorageType(e.target.value)}
                                        className="input w-full"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Storage Detail</label>
                                    <input
                                        type="text"
                                        value={storageDetail}
                                        placeholder="e.g. Binder 2, page 4"
                                        onChange={e => setStorageDetail(e.target.value)}
                                        className="input w-full"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="text-xs text-text-muted mb-1 block">Card History</label>
                                <textarea
                                    value={cardHistory}
                                    placeholder="Origin, receipt, certification, or provenance notes…"
                                    onChange={e => setCardHistory(e.target.value)}
                                    className="input w-full h-16 resize-none py-1"
                                />
                            </div>

                            <div>
                                <label className="text-xs text-text-muted mb-1 block">Notes</label>
                                <textarea
                                    value={notes}
                                    placeholder="Notes about acquisition or condition..."
                                    onChange={e => setNotes(e.target.value)}
                                    className="input w-full h-16 resize-none py-1"
                                />
                            </div>

                            {canEditCustomImage && (
                                <div className="bg-bg-card rounded-xl p-3 space-y-2 border border-border">
                                    <div>
                                        <label htmlFor={customImageInputId}
                                               className="text-xs text-text-muted font-medium uppercase tracking-wide block">
                                            {t('card.customImageUrl')}
                                        </label>
                                        <p className="text-xs text-text-secondary mt-1">
                                            {t('card.customImageUrlDesc')}
                                        </p>
                                    </div>
                                    <input
                                        id={customImageInputId}
                                        type="url"
                                        placeholder="https://..."
                                        value={customImageUrl}
                                        onChange={(e) => setCustomImageUrl(e.target.value)}
                                        className="input w-full"
                                    />
                                    {customImageProxyUrl && (
                                        <div className="w-20 h-28 rounded overflow-hidden border border-border">
                                            <img src={customImageProxyUrl} alt=""
                                                 className="w-full h-full object-cover"/>
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => customImageMutation.mutate(customImageUrl.trim())}
                                            disabled={customImageMutation.isPending || customImageUrl.trim() === savedCustomImageUrl}
                                            className="btn-primary text-sm"
                                        >
                                            {customImageMutation.isPending ? t('common.saving') : t('card.saveCustomImage')}
                                        </button>
                                        {savedCustomImageUrl && (
                                            <button
                                                type="button"
                                                onClick={() => customImageMutation.mutate('')}
                                                disabled={customImageMutation.isPending}
                                                className="btn-ghost text-sm"
                                            >
                                                {t('card.clearCustomImage')}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={openAddVersionForm}
                                    className="btn-ghost justify-center border-brand-red/30 text-brand-red hover:bg-brand-red/10"
                                >
                                    <Copy size={14}/> {t('collection.addAnotherVersion')}
                                </button>
                                {binderSelect}
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 mt-5">
                            <button
                                onClick={() => updateMutation.mutate()}
                                disabled={updateMutation.isPending || !exchangeRateReady}
                                className="btn-primary flex-1"
                            >
                                <Check size={16}/> {updateMutation.isPending ? t('common.saving') : t('common.save')}
                            </button>
                            <button
                                onClick={handleDelete}
                                disabled={deleteMutation.isPending}
                                className="btn-ghost text-brand-red border-brand-red/30 hover:bg-brand-red/10 px-3"
                                title={t('collection.remove')}
                            >
                                <Trash2 size={16}/>
                            </button>
                        </div>
                        {showRemoveForm && (
                            <div
                                className="mt-3 space-y-3 rounded-xl border border-brand-red/25 bg-brand-red/10 p-3 archive-card-reveal">
                                <div>
                                    <p className="text-sm font-semibold text-text-primary">Move this card to
                                        history?</p>
                                    <p className="mt-0.5 text-xs text-text-secondary">The record is kept locally with
                                        its removal date and reason.</p>
                                </div>
                                <select className="select w-full" value={removalReason}
                                        onChange={e => setRemovalReason(e.target.value)}>
                                    {REMOVAL_REASONS.map(option => <option key={option.value}
                                                                           value={option.value}>{option.label}</option>)}
                                </select>
                                <textarea
                                    className="input min-h-16 w-full"
                                    value={removalNotes}
                                    onChange={e => setRemovalNotes(e.target.value)}
                                    placeholder="Optional note"
                                />
                                <div className="flex justify-end gap-2">
                                    <button type="button" className="btn-ghost"
                                            onClick={() => setShowRemoveForm(false)}>Keep card
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-primary"
                                        disabled={deleteMutation.isPending}
                                        onClick={() => deleteMutation.mutate()}
                                    >
                                        Move to history
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <form
                        aria-hidden={!showAddVersionForm}
                        className={clsx(
                            'col-start-1 row-start-1 p-5 transition-all duration-300 ease-out transform-gpu',
                            showAddVersionForm
                                ? 'translate-x-0 rotate-0 scale-100 opacity-100'
                                : 'translate-x-[115%] rotate-6 scale-[0.96] opacity-0 pointer-events-none'
                        )}
                        onSubmit={(e) => {
                            e.preventDefault()
                            if (!exchangeRateReady) return
                            cloneMutation.mutate()
                        }}
                    >
                        {renderCardHeader()}

                        <div className="space-y-3">
                            <div
                                className="bg-bg-card rounded-xl p-3 border border-brand-red/30 shadow-lg shadow-black/10">
                                <h3 className="text-sm font-bold text-text-primary">{t('collection.newVersionDetails')}</h3>
                                <p className="text-xs text-text-secondary mt-1">{t('collection.addAnotherVersionHelp')}</p>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                                    <input
                                        type="number" min="1" value={newVersionQuantity}
                                        onChange={e => setNewVersionQuantity(parseInt(e.target.value, 10) || 1)}
                                        className="input"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                                    <select value={newVersionCondition}
                                            onChange={e => setNewVersionCondition(e.target.value)} className="select">
                                        {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
                                <select value={newVersionVariant} onChange={e => setNewVersionVariant(e.target.value)}
                                        className="select">
                                    {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                                </select>
                            </div>

                            <div>
                                <label
                                    className="text-xs text-text-muted mb-1.5 block">🌐 {t('lang.selectLabel')}</label>
                                <TcgdexLanguageSelect value={newVersionLang} onChange={setNewVersionLang}
                                                      className="select w-full"/>
                            </div>

                            <div>
                                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                                <MoneyInput
                                    placeholder={t('card.purchasePricePlaceholder')}
                                    value={newVersionPrice}
                                    onChange={e => setNewVersionPrice(e.target.value)}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Acquisition Source</label>
                                    <select
                                        value={newVersionAcquisitionSource}
                                        onChange={e => handleNewVersionAcquisitionSourceChange(e.target.value)}
                                        className="select"
                                    >
                                        <option value="">Select source</option>
                                        {ACQUISITION_SOURCES.map(src => (
                                            <option key={src.value} value={src.value}>{src.label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Protection</label>
                                    <select value={newVersionProtectionType}
                                            onChange={e => setNewVersionProtectionType(e.target.value)}
                                            className="select w-full">
                                        {PROTECTION_TYPES.map(option => <option key={option.value}
                                                                                value={option.value}>{option.label}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Storage Location</label>
                                    <select value={newVersionStorageLocationId}
                                            onChange={e => setNewVersionStorageLocationId(e.target.value)}
                                            className="select w-full" required>
                                        <option value="">Choose a location</option>
                                        {storageLocations.map(location => <option key={location.id}
                                                                                  value={location.id}>{location.name}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Grader</label>
                                    <input
                                        type="text"
                                        value={newVersionGrader}
                                        placeholder={newVersionProtectionType === 'tag_slab' ? 'TAG' : 'e.g. PSA, BGS'}
                                        onChange={e => setNewVersionGrader(e.target.value)}
                                        className="input w-full"
                                        disabled={!['psa_slab', 'tag_slab'].includes(newVersionProtectionType)}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Storage Type</label>
                                    <input
                                        type="text"
                                        value={newVersionStorageType}
                                        placeholder="e.g. Binder, slab case"
                                        onChange={e => setNewVersionStorageType(e.target.value)}
                                        className="input w-full"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Storage Detail</label>
                                    <input
                                        type="text"
                                        value={newVersionStorageDetail}
                                        placeholder="e.g. Binder 2, page 4"
                                        onChange={e => setNewVersionStorageDetail(e.target.value)}
                                        className="input w-full"
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Grade</label>
                                    <input
                                        type="text"
                                        value={newVersionGrade}
                                        placeholder="e.g. 10, 9.5, Raw"
                                        onChange={e => setNewVersionGrade(e.target.value)}
                                        className="input w-full"
                                        disabled={!['psa_slab', 'tag_slab'].includes(newVersionProtectionType)}
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-text-muted mb-1 block">Certification #</label>
                                    <input
                                        type="text"
                                        value={newVersionCertificationNumber}
                                        placeholder="e.g. 12345678"
                                        onChange={e => setNewVersionCertificationNumber(e.target.value)}
                                        className="input w-full"
                                        disabled={!['psa_slab', 'tag_slab'].includes(newVersionProtectionType)}
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="text-xs text-text-muted mb-1 block">Notes</label>
                                <textarea
                                    value={newVersionNotes}
                                    placeholder="Notes about acquisition or condition..."
                                    onChange={e => setNewVersionNotes(e.target.value)}
                                    className="input w-full h-16 resize-none py-1"
                                />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                                <button
                                    type="submit"
                                    disabled={cloneMutation.isPending || !exchangeRateReady}
                                    className="btn-primary justify-center"
                                >
                                    <Copy
                                        size={14}/> {cloneMutation.isPending ? t('card.adding') : t('collection.addVersionToCollection')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowAddVersionForm(false)}
                                    disabled={cloneMutation.isPending}
                                    className="btn-ghost justify-center"
                                >
                                    <ArrowLeft size={14}/> {t('common.back')}
                                </button>
                            </div>
                        </div>
                    </form>
                </div>
            </div>
        </div>,
        document.body
    )
}

export default function Collection() {
    const {t, formatPrice, pricePrimaryField, currency, exchangeRate} = useSettings()
    const visibleLanguages = useVisibleTcgdexLanguages()
    const [viewMode, setViewMode] = useState('grid')
    const [editingCollectionItem, setEditingCollectionItem] = useState(null) // for CollectionEditModal
    const [showCustomModal, setShowCustomModal] = useState(false)
    const [editCard, setEditCard] = useState(null)
    const [sortBy, setSortBy] = useState('added_at')
    const [sortOrder, setSortOrder] = useState('desc')
    const [filterRarity, setFilterRarity] = useState('')
    const [filterCondition, setFilterCondition] = useState('')
    const [filterVariant, setFilterVariant] = useState('')
    const [filterSet, setFilterSet] = useState('')
    const [filterType, setFilterType] = useState('')
    const [filterCategories, setFilterCategories] = useState([])
    const [filterSubtypes, setFilterSubtypes] = useState([])
    const [filterLegality, setFilterLegality] = useState('')
    const [filterLang, setFilterLang] = useState('')
    const [filterMinPrice, setFilterMinPrice] = useState('')
    const [filterMaxPrice, setFilterMaxPrice] = useState('')
    const [filterDuplicates, setFilterDuplicates] = useState(false)
    const [searchText, setSearchText] = useState('')
    const [showFilters, setShowFilters] = useState(false)
    const [showInventoryIntake, setShowInventoryIntake] = useState(false)
    const [showExcelImport, setShowExcelImport] = useState(false)
    const [intakeKind, setIntakeKind] = useState('owned')
    const [intakeSource, setIntakeSource] = useState(null)
    const queryClient = useQueryClient()
    const [searchParams, setSearchParams] = useSearchParams()
    const requestedView = searchParams.get('view') || 'owned'
    const activeView = ['owned', 'bulk', 'sealed', 'history'].includes(requestedView) ? requestedView : 'owned'
    const setActiveView = (view) => {
        const next = new URLSearchParams(searchParams)
        if (view === 'owned') next.delete('view')
        else next.set('view', view)
        next.delete('itemId')
        next.delete('cardId')
        setSearchParams(next, {replace: true})
        setEditingCollectionItem(null)
        setSearchText('')
    }

    const {data: items = [], isLoading, error} = useQuery({
        queryKey: ['collection', activeView],
        queryFn: () => getCollection({
            status: 'owned',
            inventory_kind: activeView,
        }).then(r => r.data),
        enabled: activeView === 'owned' || activeView === 'bulk',
        refetchInterval: 60000,
    })

    const {data: wishlistItems = []} = useQuery({
        queryKey: ['wishlist'],
        queryFn: () => getWishlist().then(r => r.data),
        staleTime: 60000,
    })

    const COLLECTION_TABS = [
        {to: '/collection', label: t('nav.collection'), icon: Library},
        {to: '/binders', label: t('nav.binders'), icon: BookOpen},
        {to: '/wishlist', label: t('nav.wishlist'), icon: Heart, badge: wishlistItems.length},
    ]

    const {data: allSets = []} = useQuery({
        queryKey: ['sets'],
        queryFn: () => getSets().then(r => r.data),
        staleTime: 5 * 60 * 1000,
    })

    const targetItemId = searchParams.get('itemId')
    const targetCardId = searchParams.get('cardId')

    const clearTargetParams = () => {
        const next = new URLSearchParams(searchParams)
        next.delete('itemId')
        next.delete('cardId')
        setSearchParams(next, {replace: true})
    }

    useEffect(() => {
        if (isLoading || editingCollectionItem || (!targetItemId && !targetCardId)) return

        const targetItem = items.find(item => {
            if (targetItemId && String(item.id) === targetItemId) return true
            if (!targetItemId && targetCardId) {
                return item.card_id === targetCardId || item.card?.id === targetCardId || item.card?.tcg_card_id === targetCardId
            }
            return false
        })

        if (targetItem) setEditingCollectionItem(targetItem)
        else clearTargetParams()
    }, [isLoading, items, editingCollectionItem, targetItemId, targetCardId])

    useEffect(() => {
        if (!editingCollectionItem) return

        const freshItem = items.find(item => String(item.id) === String(editingCollectionItem.id))
        if (freshItem && freshItem !== editingCollectionItem) {
            setEditingCollectionItem(freshItem)
        }
    }, [items, editingCollectionItem])

    const closeCollectionItemModal = () => {
        setEditingCollectionItem(null)
        if (targetItemId || targetCardId) clearTargetParams()
    }

    function getEffectivePrice(card, variant, primaryField = pricePrimaryField) {
        return getEffectiveCardPrice(card, variant, primaryField)
    }

    const rarities = useMemo(() => [...new Set(items.map(i => i.card?.rarity).filter(Boolean))].sort(), [items])
    const sets = useMemo(() => {
        const map = new Map()
        items.forEach(i => {
            const s = i.card?.set_ref
            if (s?.id) map.set(s.id, s.name)
        })
        return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
    }, [items])
    const types = useMemo(() => {
        const all = new Set()
        items.forEach(i => (i.card?.types || []).forEach(tp => all.add(tp)))
        return [...all].sort()
    }, [items])
    const cardCategories = useMemo(() => {
        const all = new Set(CARD_CATEGORY_OPTIONS)
        items.forEach(i => {
            const label = getCardCategoryLabel(i.card)
            if (label) all.add(label)
        })
        return sortCardFilterLabels(CARD_CATEGORY_OPTIONS, all)
    }, [items])
    const cardSubtypes = useMemo(() => {
        const all = new Set(CARD_SUBTYPE_OPTIONS)
        items.forEach(i => getCardSubtypeLabels(i.card).forEach(label => all.add(label)))
        return sortCardFilterLabels(CARD_SUBTYPE_OPTIONS, all)
    }, [items])

    const hasActiveFilters = filterRarity || filterCondition || filterVariant || filterSet || filterType || filterCategories.length > 0 || filterSubtypes.length > 0 || filterLegality || filterLang || filterMinPrice || filterMaxPrice || filterDuplicates || searchText

    const filtered = useMemo(() => {
        let result = items.filter(item => {
            const card = item.card
            const marketPrice = getEffectivePrice(card, item.variant)
            if (filterRarity && card?.rarity !== filterRarity) return false
            if (filterCondition && item.condition !== filterCondition) return false
            if (filterVariant && item.variant !== filterVariant) return false
            if (filterSet) {
                if (item.card?.set_ref?.id !== filterSet) return false
            }
            if (filterType && !(card?.types || []).includes(filterType)) return false
            if (filterCategories.length > 0) {
                const category = normalizeCardFilterValue(getCardCategoryLabel(card))
                const categoryMatches = filterCategories.some(filter => normalizeCardFilterValue(filter) === category)
                if (!categoryMatches) return false
            }
            if (filterSubtypes.length > 0) {
                const subtypes = getCardSubtypeLabels(card).map(normalizeCardFilterLabelKey)
                const subtypeMatches = filterSubtypes.some(filter => subtypes.includes(normalizeCardFilterLabelKey(filter)))
                if (!subtypeMatches) return false
            }
            if (filterLegality === 'standard' && !item.standard_legal) return false
            if (filterLang && item.lang !== filterLang) return false
            if (filterMinPrice && marketPrice < parseFloat(filterMinPrice)) return false
            if (filterMaxPrice && marketPrice > parseFloat(filterMaxPrice)) return false
            if (filterDuplicates && item.quantity < 2) return false
            if (searchText) {
                const q = normalizeSearchText(searchText)
                const nameMatch = textIncludes(card?.name, q)
                const setMatch = textIncludes(card?.set_name, q) || textIncludes(card?.set?.name, q) || textIncludes(card?.set_ref?.name, q)
                const numberMatch = cardNumberMatches(card?.number, q) || cardNumberMatches(card?.localId, q)
                // Support "SET NUMBER" shortcode (e.g. "PFL 001", "OBF 125")
                const codeMatch = /^([A-Za-z]+\d*)\s+(\d+)$/.exec(q)
                let shortcodeMatch = false
                if (codeMatch) {
                    const [, setCode, num] = codeMatch
                    const normalizedNum = String(parseInt(num, 10))
                    const cardAbbr = normalizeSearchText(card?.set_ref?.abbreviation)
                    const cardSetId = normalizeSearchText(card?.set_id || card?.set?.id)
                    const cardTcgSetId = normalizeSearchText(card?.set_ref?.tcg_set_id)
                    shortcodeMatch = (cardAbbr === setCode || cardSetId.includes(setCode) || cardTcgSetId === setCode) && cardNumberMatches(card?.number || card?.localId, normalizedNum)
                }
                if (!nameMatch && !setMatch && !numberMatch && !shortcodeMatch) return false
            }
            return true
        })

        result = [...result].sort((a, b) => {
            let valA, valB
            switch (sortBy) {
                case 'added_at':
                    valA = a.added_at || '';
                    valB = b.added_at || '';
                    break
                case 'quantity':
                    valA = a.quantity;
                    valB = b.quantity;
                    break
                case 'purchase_price':
                    valA = a.purchase_price ?? -1;
                    valB = b.purchase_price ?? -1;
                    break
                case 'market_price':
                    valA = getEffectivePrice(a.card, a.variant);
                    valB = getEffectivePrice(b.card, b.variant);
                    break
                case 'price_trend':
                    valA = getEffectivePrice(a.card, a.variant, 'price_trend');
                    valB = getEffectivePrice(b.card, b.variant, 'price_trend');
                    break
                case 'set':
                    valA = a.card?.set_ref?.name || '';
                    valB = b.card?.set_ref?.name || '';
                    break
                case 'card_id':
                    valA = collectionCardIdKey(a);
                    valB = collectionCardIdKey(b);
                    break
                case 'name':
                    valA = a.card?.name?.toLowerCase() || '';
                    valB = b.card?.name?.toLowerCase() || '';
                    break
                default:
                    return 0
            }
            if (valA < valB) return sortOrder === 'asc' ? -1 : 1
            if (valA > valB) return sortOrder === 'asc' ? 1 : -1
            return 0
        })

        return result
    }, [items, filterRarity, filterCondition, filterVariant, filterSet, filterType, filterCategories, filterSubtypes, filterLegality, filterLang, filterMinPrice, filterMaxPrice, filterDuplicates, searchText, sortBy, sortOrder, pricePrimaryField])

    const totalCards = filtered.reduce((sum, item) => sum + item.quantity, 0)
    // Unfiltered total, so the header can say "12 of 78" while a filter is on.
    const allCards = items.reduce((sum, item) => sum + item.quantity, 0)
    const exportParams = {price_field: pricePrimaryField, currency, exchange_rate: exchangeRate}

    const resetFilters = () => {
        setFilterRarity('');
        setFilterCondition('');
        setFilterVariant('')
        setFilterSet('');
        setFilterType('');
        setFilterCategories([]);
        setFilterSubtypes([]);
        setFilterLegality('');
        setFilterLang('');
        setFilterMinPrice('')
        setFilterMaxPrice('');
        setFilterDuplicates(false);
        setSearchText('')
    }

    if (isLoading) {
        return (
            <div className="space-y-4">
                <TabNav tabs={COLLECTION_TABS}/>
                <div className="skeleton h-8 w-48 rounded"/>
                {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-16 rounded-xl"/>)}
            </div>
        )
    }

    return (
        <>
            <div className="space-y-4 pb-2">
                <TabNav tabs={COLLECTION_TABS}/>

                {/* ─── Header ───────────────────────────────────────────────── */}
                <div className="collection-hero">
                    <div className="min-w-0">
                        <span className="archive-eyebrow">Private Collection</span>
                        <h1 className="mt-2 text-5xl font-bold text-text-primary mag-heading uppercase leading-none">
                            <SplitText text={'My Collection'} delay={40}/></h1>
                        <p className="mt-2 text-sm text-text-secondary">
                            {activeView === 'sealed'
                                ? 'Sealed product, filed alongside the cards it belongs with.'
                                : activeView === 'history'
                                    ? 'Every collection change, kept locally and in order.'
                                    : hasActiveFilters
                                        ? `${totalCards.toLocaleString()} ${t('collection.ofTotal')} ${allCards.toLocaleString()} ${t('collection.cards')}`
                                        : `${totalCards.toLocaleString()} ${t('collection.cards')}`}
                            {(activeView === 'owned' || activeView === 'bulk') && <> · {filtered.length.toLocaleString()} {t('collection.unique')}</>}
                        </p>
                    </div>
                    <div className="collection-hero-actions">
                        <Link to="/products" className="btn-ghost text-sm py-1.5">
                            <Package size={14}/> Sealed product
                        </Link>

                        {/* VIEW TOGGLE */}
                        {(activeView === 'owned' || activeView === 'bulk') &&
                            <div className="flex items-center gap-0.5 bg-bg-elevated rounded-lg p-1">
                                <button
                                    onClick={() => setViewMode('grid')}
                                    title={t('collection.binderView')}
                                    className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-brand-red text-white' : 'text-text-muted hover:text-text-primary'}`}
                                >
                                    <Grid2X2 size={15}/>
                                </button>
                                <button
                                    onClick={() => setViewMode('list')}
                                    title={t('collection.listView')}
                                    className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-brand-red text-white' : 'text-text-muted hover:text-text-primary'}`}
                                >
                                    <List size={15}/>
                                </button>
                            </div>}

                        <button onClick={() => setShowCustomModal(true)}
                                className="btn-ghost text-sm py-1.5">
                            <PenLine size={14}/> Custom
                        </button>
                        <button
                            onClick={() => setShowExcelImport(true)}
                            className="btn-ghost text-sm py-1.5"
                        >
                            <FileSpreadsheet size={15}/> Import
                        </button>
                        <details className="relative">
                            <summary className="btn-ghost cursor-pointer list-none text-sm py-1.5">
                                <Download size={15}/> Export
                            </summary>
                            <div
                                className="absolute right-0 z-30 mt-2 grid min-w-36 gap-1 rounded-xl border border-border bg-bg-surface p-2 shadow-xl">
                                <button type="button" onClick={() => exportExcel(exportParams)}
                                        className="btn-ghost justify-start text-xs">Excel workbook
                                </button>
                                <button type="button" onClick={() => exportCSV(exportParams)}
                                        className="btn-ghost justify-start text-xs">CSV
                                </button>
                                <button type="button" onClick={() => exportPDF(exportParams)}
                                        className="btn-ghost justify-start text-xs">PDF
                                </button>
                            </div>
                        </details>
                        <button
                            onClick={() => {
                                setIntakeKind(activeView === 'bulk' ? 'bulk' : activeView === 'sealed' ? 'sealed' : 'owned')
                                setIntakeSource(null)
                                setShowInventoryIntake(true)
                            }}
                            className="btn-primary text-sm py-2"
                        >
                            <Plus size={16}/> Add to collection
                        </button>
                    </div>
                </div>

                <div className="collection-ledger-tabs" role="tablist" aria-label="Collection views">
                    {[
                        {value: 'owned', label: 'Owned', icon: Library},
                        {value: 'bulk', label: 'Bulk', icon: Boxes},
                        {value: 'sealed', label: 'Sealed', icon: Package},
                        {value: 'history', label: 'History', icon: ArchiveRestore},
                    ].map(option => {
                        const Icon = option.icon
                        return (
                            <button
                                type="button"
                                role="tab"
                                id={`collection-tab-${option.value}`}
                                data-view={option.value}
                                aria-controls={`collection-panel-${option.value}`}
                                aria-selected={activeView === option.value}
                                tabIndex={activeView === option.value ? 0 : -1}
                                key={option.value}
                                className={activeView === option.value ? 'collection-ledger-tab collection-ledger-tab-active' : 'collection-ledger-tab'}
                                onClick={() => setActiveView(option.value)}
                                onKeyDown={event => {
                                    const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')]
                                    const currentIndex = tabs.indexOf(event.currentTarget)
                                    let nextIndex = currentIndex
                                    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
                                    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
                                    else if (event.key === 'Home') nextIndex = 0
                                    else if (event.key === 'End') nextIndex = tabs.length - 1
                                    else return
                                    event.preventDefault()
                                    const nextTab = tabs[nextIndex]
                                    nextTab.focus()
                                    setActiveView(nextTab.dataset.view)
                                }}
                            >
                                <Icon size={15}/> {option.label}
                            </button>
                        )
                    })}
                </div>

                <div
                    id={`collection-panel-${activeView}`}
                    role="tabpanel"
                    aria-labelledby={`collection-tab-${activeView}`}
                    tabIndex={0}
                >
                    {activeView === 'sealed' ? (
                        <SealedCollectionView
                            onAddPulledCards={() => {
                                setIntakeKind('owned')
                                setIntakeSource('pulled')
                                setShowInventoryIntake(true)
                            }}
                        />
                    ) : activeView === 'history' ? (
                        <InventoryHistoryView/>
                    ) : (
                        <>

                            {/* ─── Filter & Sort Bar ────────────────────────────────────── */}
                            <div className="card space-y-3">
                                <div className="flex flex-wrap items-center gap-3">
                                    <div className="flex items-center gap-2">
                                        <SortAsc size={14} className="text-text-muted"/>
                                        <select className="select w-40 py-1.5 text-sm" value={sortBy}
                                                onChange={(e) => setSortBy(e.target.value)}>
                                            <option value="added_at">{t('collection.sortDateAdded')}</option>
                                            <option value="name">{t('common.name')}</option>
                                            <option value="quantity">{t('collection.sortQuantity')}</option>
                                            <option value="set">{t('collection.sortSet')}</option>
                                            <option value="card_id">{t('collection.sortCardId')}</option>
                                        </select>
                                        <button onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')}
                                                className="btn-ghost py-1.5 px-2">
                                            {sortOrder === 'asc' ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}
                                        </button>
                                    </div>

                                    <div className="relative flex-1 min-w-[160px] max-w-xs">
                                        <Search size={14}
                                                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"/>
                                        <input type="text" placeholder={t('collection.searchCards')} value={searchText}
                                               onChange={(e) => setSearchText(e.target.value)}
                                               className="input pl-8 text-sm py-1.5"/>
                                    </div>

                                    <button onClick={() => setShowFilters(f => !f)}
                                            className={`btn-ghost text-sm py-1.5 ${showFilters || hasActiveFilters ? 'border-brand-red/30 text-brand-red' : ''}`}>
                                        <Filter size={14}/> {t('common.filter')}
                                        {hasActiveFilters && <span
                                            className="ml-1 bg-brand-red text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">!</span>}
                                    </button>

                                    {hasActiveFilters && (
                                        <button onClick={resetFilters} className="btn-ghost text-sm py-1.5">
                                            <X size={14}/> {t('collection.clearFilters')}
                                        </button>
                                    )}
                                </div>

                                {showFilters && (
                                    <div
                                        className="pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-3">
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
                                            <select className="select py-1.5 text-sm" value={filterRarity}
                                                    onChange={(e) => setFilterRarity(e.target.value)}>
                                                <option value="">{t('common.allRarities')}</option>
                                                {rarities.map(r => <option key={r} value={r}>{r}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('common.condition')}</label>
                                            <select className="select py-1.5 text-sm" value={filterCondition}
                                                    onChange={(e) => setFilterCondition(e.target.value)}>
                                                <option value="">{t('common.allConditions')}</option>
                                                {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">✨ {t('variants.filterVariant')}</label>
                                            <select className="select py-1.5 text-sm" value={filterVariant}
                                                    onChange={(e) => setFilterVariant(e.target.value)}>
                                                <option value="">{t('variants.allVariants')}</option>
                                                {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('collection.filterSet')}</label>
                                            <select className="select py-1.5 text-sm" value={filterSet}
                                                    onChange={(e) => setFilterSet(e.target.value)}>
                                                <option value="">{t('collection.allSets')}</option>
                                                {sets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('collection.filterEnergyType')}</label>
                                            <select className="select py-1.5 text-sm" value={filterType}
                                                    onChange={(e) => setFilterType(e.target.value)}>
                                                <option value="">{t('collection.allEnergyTypes')}</option>
                                                {types.map(tp => <option key={tp} value={tp}>{tp}</option>)}
                                            </select>
                                        </div>
                                        <div className="col-span-2 sm:col-span-3 lg:col-span-2">
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('collection.filterCardCategory')}</label>
                                            <div
                                                className="min-h-[34px] rounded-lg border border-border bg-bg px-2 py-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
                                                {cardCategories.map(category => (
                                                    <label key={category}
                                                           className="inline-flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer whitespace-nowrap">
                                                        <input
                                                            type="checkbox"
                                                            checked={filterCategories.includes(category)}
                                                            onChange={() => setFilterCategories(values => toggleFilterValue(values, category))}
                                                            className="w-3.5 h-3.5 accent-brand-red"
                                                        />
                                                        <span>{category}</span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="col-span-2 sm:col-span-3 lg:col-span-3">
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('collection.filterSubtype')}</label>
                                            <div
                                                className="min-h-[34px] rounded-lg border border-border bg-bg px-2 py-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
                                                {cardSubtypes.map(subtype => (
                                                    <label key={subtype}
                                                           className="inline-flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer whitespace-nowrap">
                                                        <input
                                                            type="checkbox"
                                                            checked={filterSubtypes.includes(subtype)}
                                                            onChange={() => setFilterSubtypes(values => toggleFilterValue(values, subtype))}
                                                            className="w-3.5 h-3.5 accent-brand-red"
                                                        />
                                                        <span>{subtype}</span>
                                                    </label>
                                                ))}
                                            </div>
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('collection.filterLegality')}</label>
                                            <select className="select py-1.5 text-sm" value={filterLegality}
                                                    onChange={(e) => setFilterLegality(e.target.value)}>
                                                <option value="">{t('collection.allLegalities')}</option>
                                                <option value="standard">{t('collection.standardLegal')}</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('lang.filter')}</label>
                                            <TcgdexLanguageSelect
                                                value={filterLang || 'all'}
                                                includeAll
                                                allLabel={t('lang.all')}
                                                compact
                                                languages={visibleLanguages}
                                                onChange={(value) => setFilterLang(value === 'all' ? '' : value)}
                                                className="select py-1.5 text-sm"
                                            />
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('collection.filterMinPrice')}</label>
                                            <input type="number" min="0" step="0.01" placeholder="0"
                                                   value={filterMinPrice}
                                                   onChange={(e) => setFilterMinPrice(e.target.value)}
                                                   className="input py-1.5 text-sm"/>
                                        </div>
                                        <div>
                                            <label
                                                className="text-xs text-text-muted mb-1 block">{t('collection.filterMaxPrice')}</label>
                                            <input type="number" min="0" step="0.01" placeholder="∞"
                                                   value={filterMaxPrice}
                                                   onChange={(e) => setFilterMaxPrice(e.target.value)}
                                                   className="input py-1.5 text-sm"/>
                                        </div>
                                        <div className="flex items-center gap-2 col-span-2 sm:col-span-1">
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input type="checkbox" checked={filterDuplicates}
                                                       onChange={(e) => setFilterDuplicates(e.target.checked)}
                                                       className="w-4 h-4 accent-brand-red"/>
                                                <span
                                                    className="text-xs text-text-secondary">{t('collection.filterDuplicates')}</span>
                                            </label>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* ─── GRID BINDER VIEW ─────────────────────────────────────── */}
                            {viewMode === 'grid' && (
                                <>
                                    {items.length === 0 ? (
                                        <div className="card text-center py-20">
                                            <img src="/pokeball.svg" className="w-16 h-16 mx-auto mb-4 opacity-20"
                                                 alt=""/>
                                            <p className="text-text-muted">{t('collection.empty')}</p>
                                            <p className="text-xs text-text-muted mt-1">{t('collection.emptyHint')}</p>
                                        </div>
                                    ) : (
                                        <div className="binder-grid">
                                            <div
                                                className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                                                {filtered.map(item => {
                                                    const card = item.card
                                                    const rarityLower = (card?.rarity || '').toLowerCase()
                                                    let rarityClass = ''
                                                    if (rarityLower.includes('secret') || rarityLower.includes('rainbow')) {
                                                        rarityClass = 'card-secret'
                                                    } else if (
                                                        rarityLower.includes('ultra') ||
                                                        rarityLower.includes('vmax') ||
                                                        rarityLower.includes('v max') ||
                                                        rarityLower.includes('full art')
                                                    ) {
                                                        rarityClass = 'card-holo'
                                                    } else if (rarityLower.includes('holo') || rarityLower.includes('rare')) {
                                                        rarityClass = 'card-holo'
                                                    }

                                                    return (
                                                        <TiltBinderCard
                                                            key={item.id}
                                                            className={`binder-card ${rarityClass} cursor-pointer`}
                                                            onClick={() => item.status !== 'removed' && setEditingCollectionItem(item)}
                                                        >
                                                            <div
                                                                className="aspect-[2.5/3.5] relative rounded-xl overflow-hidden flex-shrink-0"
                                                            >
                                                                <CardImage src={resolveCardImageUrl(card)}
                                                                           alt={card?.name}
                                                                           className="w-full h-full object-cover"/>
                                                                <HoloOverlay variant={item.variant}/>
                                                                <ProductSourceBadge item={item} t={t} compact
                                                                                    className="absolute right-1 top-1 z-10 h-6 w-6"/>
                                                            </div>
                                                            {(() => {
                                                                const abbr = card?.set_ref?.abbreviation
                                                                const num = card?.number
                                                                const setName = card?.set_ref?.name
                                                                if (abbr && num) {
                                                                    return (
                                                                        <p className="text-[10px] font-mono font-bold text-brand-red/70 leading-tight truncate mt-0.5 px-0.5">
                                                                            {abbr} {num}
                                                                        </p>
                                                                    )
                                                                } else if (setName) {
                                                                    return (
                                                                        <p className="text-[10px] text-text-muted leading-tight truncate mt-0.5 px-0.5">
                                                                            {setName}
                                                                        </p>
                                                                    )
                                                                }
                                                                return null
                                                            })()}
                                                            <div className="flex flex-wrap gap-0.5 mt-0.5 px-0.5">
                                                                {item.is_grail && (
                                                                    <span className="inline-flex items-center text-[10px] font-black px-1.5 py-0.5 rounded-full bg-yellow/20 text-yellow border border-yellow/40" title="Grail Card">★ Grail</span>
                                                                )}
                                                                {item.collection_intent && item.collection_intent !== "main_collection" && (
                                                                    <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple/20 text-purple border border-purple/40">{item.collection_intent === "vault" ? "Vault" : "PC"}</span>
                                                                )}
                                                                {item.quantity > 1 && (
                                                                    <span
                                                                        className="inline-flex items-center gap-0.5 text-[10px] font-black px-1.5 py-0.5 rounded-full bg-brand-red/20 text-brand-red border border-brand-red/40">
                            ×{item.quantity}
                          </span>
                                                                )}
                                                                {item.variant && item.variant !== 'Normal' && (
                                                                    <span
                                                                        className="inline-flex max-w-full min-w-0 items-center justify-center text-center text-[10px] font-semibold leading-tight px-1.5 py-0.5 rounded-full bg-yellow/15 text-yellow border border-yellow/30 whitespace-normal break-words">
                            ✨ {item.variant}
                          </span>
                                                                )}
                                                                {item.lang && (
                                                                    <span
                                                                        className={`text-[10px] font-black px-1.5 py-0.5 rounded-full ${tcgdexLanguageBadgeClass(item.lang)}`}>
                            {tcgdexLanguageLabel(item.lang)}
                          </span>
                                                                )}
                                                                <FallbackBadges card={card} compact/>
                                                            </div>
                                                        </TiltBinderCard>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}
                                    {filtered.length > 0 && (
                                        <div className="flex items-center justify-between text-sm pt-1 px-1">
                                            <span
                                                className="text-text-muted">{filtered.length} {t('collection.filtered')}</span>
                                            <span className="font-bold text-highlight">Gallery Showcase</span>
                                        </div>
                                    )}
                                </>
                            )}

                            {/* ─── LIST VIEW (table + mobile cards) ────────────────────── */}
                            {viewMode === 'list' && (
                                <>
                                    {items.length === 0 ? (
                                        <div className="card text-center py-20">
                                            <div className="w-24 h-24 pokeball-bg mx-auto mb-4 opacity-20"/>
                                            <p className="text-text-muted">{t('collection.empty')}</p>
                                            <p className="text-xs text-text-muted mt-1">{t('collection.emptyHint')}</p>
                                        </div>
                                    ) : (
                                        <div className="card p-0 overflow-hidden">
                                            {/* Desktop Table */}
                                            <div className="hidden md:block overflow-x-auto">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                    <tr className="border-b border-border bg-bg/50">
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">{t('collection.card')}</th>
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.set')}</th>
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.rarity')}</th>
                                                        <th className="text-center px-4 py-3 text-text-muted font-medium">{t('collection.qty')}</th>
                                                        <th className="text-center px-4 py-3 text-text-muted font-medium">{t('common.condition')}</th>
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">✨ {t('variants.label')}</th>
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">Source</th>
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">Storage</th>
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">Grading</th>
                                                        <th className="text-left px-4 py-3 text-text-muted font-medium">Notes</th>
                                                    </tr>
                                                    </thead>
                                                    <tbody>
                                                    {filtered.map((item) => {
                                                        const card = item.card
                                                        const grading = [item.grader, item.grade].filter(Boolean).join(' ')

                                                        return (
                                                            <tr
                                                                key={item.id}
                                                                className="border-b border-border/50 hover:bg-bg-elevated/50 transition-colors cursor-pointer"
                                                                onClick={() => item.status !== 'removed' && setEditingCollectionItem(item)}
                                                            >
                                                                <td className="px-4 py-3">
                                                                    <div className="flex items-center gap-3">
                                                                        <div
                                                                            className="w-8 h-10 flex-shrink-0 rounded overflow-hidden">
                                                                            <CardImage src={resolveCardImageUrl(card)}
                                                                                       alt={card?.name}
                                                                                       className="w-full h-full object-cover"/>
                                                                        </div>
                                                                        <div className="min-w-0">
                                                                            <div
                                                                                className="flex items-center gap-1 flex-wrap">
                                                                                <p className="text-sm font-medium text-text-primary hover:text-brand-red transition-colors truncate max-w-[130px]">
                                                                                    {card?.name}
                                                                                </p>
                                                                                {card?.is_custom && (
                                                                                    <span
                                                                                        className="text-xs bg-yellow/20 text-yellow px-1 rounded"
                                                                                        title={t('migration.custom')}>✏️</span>
                                                                                )}
                                                                                {item.lang && (
                                                                                    <span
                                                                                        className={`text-[9px] font-black px-1 py-0.5 rounded leading-none ${tcgdexLanguageBadgeClass(item.lang)}`}>
                                      {tcgdexLanguageLabel(item.lang)}
                                    </span>
                                                                                )}
                                                                                <FallbackBadges card={card} compact/>
                                                                            </div>
                                                                            {(() => {
                                                                                const abbr = card?.set_ref?.abbreviation
                                                                                const num = card?.number
                                                                                if (abbr && num) return <p
                                                                                    className="text-[10px] font-mono text-brand-red/70">{abbr} {num}</p>
                                                                                if (num) return <p
                                                                                    className="text-[10px] font-mono text-text-muted">#{num}</p>
                                                                                return null
                                                                            })()}
                                                                            <ProductSourceBadge item={item} t={t}
                                                                                                className="mt-1 max-w-[180px]"/>
                                                                        </div>
                                                                    </div>
                                                                </td>
                                                                <td className="px-4 py-3 text-text-secondary truncate max-w-[120px]">{card?.set_ref?.name || '-'}</td>
                                                                <td className="px-4 py-3 text-text-secondary text-xs">{card?.rarity || '-'}</td>
                                                                <td className="px-4 py-3 text-center">
                            <span className="font-medium text-text-primary">
                              {item.quantity}
                                {item.quantity > 1 &&
                                    <span className="ml-1 text-xs text-brand-red">×{item.quantity}</span>}
                            </span>
                                                                </td>
                                                                <td className="px-4 py-3 text-center">
                                                                    <span
                                                                        className={clsx('badge text-xs', CONDITION_COLORS[item.condition] || 'badge-blue')}>{item.condition}</span>
                                                                </td>
                                                                <td className="px-4 py-3 text-left">
                                                                    {item.variant ? (
                                                                        <span
                                                                            className={clsx('badge text-xs max-w-[150px] justify-center whitespace-normal break-words text-center leading-tight', VARIANT_COLORS[item.variant] || 'badge-gray')}>{item.variant}</span>
                                                                    ) : (
                                                                        <span
                                                                            className="text-text-muted text-xs">—</span>
                                                                    )}
                                                                </td>
                                                                <td className="px-4 py-3 text-text-secondary text-xs">
                                                                    {item.acquisition_source || '—'}
                                                                </td>
                                                                <td className="px-4 py-3 text-text-secondary text-xs">
                                                                    {[item.storage_location?.name, PROTECTION_TYPES.find(option => option.value === item.protection_type)?.label].filter(Boolean).join(' · ') || '—'}
                                                                </td>
                                                                <td className="px-4 py-3 text-text-secondary text-xs">
                                                                    {grading || '—'}
                                                                </td>
                                                                <td className="px-4 py-3 text-text-secondary text-xs max-w-[180px] truncate">
                                                                    {item.notes || '—'}
                                                                </td>
                                                            </tr>
                                                        )
                                                    })}
                                                    </tbody>
                                                    <tfoot>
                                                    <tr className="border-t border-border bg-bg/50">
                                                        <td colSpan={10}
                                                            className="px-4 py-3 text-text-muted text-sm">{filtered.length} {t('collection.filtered')}</td>
                                                    </tr>
                                                    </tfoot>
                                                </table>
                                            </div>

                                            {/* Mobile Card Layout */}
                                            <div className="md:hidden space-y-2 p-2">
                                                {filtered.map((item) => {
                                                    const card = item.card

                                                    const badges = []
                                                    if (item.lang) badges.push({
                                                        label: tcgdexLanguageLabel(item.lang),
                                                        variant: 'blue'
                                                    })
                                                    if (item.variant) badges.push({
                                                        label: item.variant,
                                                        variant: 'purple'
                                                    })
                                                    if (item.condition) badges.push({
                                                        label: item.condition,
                                                        variant: item.condition === 'Mint' ? 'green' : item.condition === 'NM' ? 'blue' : 'yellow'
                                                    })
                                                    if (item.quantity > 1) badges.push({
                                                        label: `×${item.quantity}`,
                                                        variant: 'red'
                                                    })
                                                    if (item.acquisition_source) badges.push({
                                                        label: item.acquisition_source,
                                                        variant: 'gold'
                                                    })
                                                    if (item.storage_location?.name) badges.push({
                                                        label: item.storage_location.name,
                                                        variant: 'blue'
                                                    })
                                                    const sourceSummary = getProductSourceSummary(item)
                                                    if (sourceSummary) badges.push({
                                                        label: `${t('collection.foundIn')}: ${sourceSummary.label}`,
                                                        variant: 'gold'
                                                    })
                                                    if (card?.is_custom) badges.push({label: '✏️', variant: 'yellow'})

                                                    return (
                                                        <CardListItem
                                                            key={item.id}
                                                            image={resolveCardImageUrl(card)}
                                                            name={card?.name}
                                                            subtext={[card?.set_ref?.name, card?.number ? `#${card.number}` : null].filter(Boolean).join(' · ') || '-'}
                                                            badges={badges}
                                                            value={`${item.quantity} × ${item.condition}`}
                                                            valueSecondary={[item.storage_location?.name, PROTECTION_TYPES.find(option => option.value === item.protection_type)?.label].filter(Boolean).join(' · ') || undefined}
                                                            onClick={() => item.status !== 'removed' && setEditingCollectionItem(item)}
                                                        />
                                                    )
                                                })}
                                                <div
                                                    className="border-t border-border pt-2 px-1 flex items-center justify-between text-sm">
                                                    <span
                                                        className="text-text-muted">{filtered.length} {t('collection.filtered')}</span>
                                                    <span className="font-bold text-green">
                    {activeView === 'bulk' ? 'Bulk archive' : 'Owned archive'}
                  </span>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}

                        </>
                    )}
                </div>
            </div>

            <InventoryIntakeModal
                isOpen={showInventoryIntake}
                onClose={() => setShowInventoryIntake(false)}
                initialKind={intakeKind}
                initialSource={intakeSource}
                onSaved={kind => setActiveView(kind)}
            />
            <ExcelImportModal isOpen={showExcelImport} onClose={() => setShowExcelImport(false)}/>

            {/* ─── CollectionEditModal ──────────────────────────────────── */}
            {editingCollectionItem && (
                <CollectionEditModal
                    item={editingCollectionItem}
                    onClose={closeCollectionItemModal}
                />
            )}

            {editCard && (
                <CustomCardModal
                    editCard={editCard}
                    onClose={() => setEditCard(null)}
                    onCreated={() => {
                        setEditCard(null)
                        queryClient.invalidateQueries({queryKey: ['collection']})
                        invalidateTcgdexFilterLanguages(queryClient)
                        queryClient.invalidateQueries({queryKey: ['dashboard']})
                    }}
                    sets={allSets}
                />
            )}

            {showCustomModal && (
                <CustomCardModal
                    onClose={() => setShowCustomModal(false)}
                    onCreated={() => {
                        setShowCustomModal(false)
                    }}
                    sets={allSets}
                    autoAddCollection={true}
                />
            )}
        </>
    )
}
