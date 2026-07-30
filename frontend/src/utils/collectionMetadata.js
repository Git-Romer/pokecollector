export function defaultPurchasePrice(source) {
    if (source === 'pulled') return 4.49;
    if (source === 'bulk_before_tracking') return 0;
    return null;
}

export const ACQUISITION_SOURCES = [
    {value: 'pulled', label: 'Pulled'},
    {value: 'purchased', label: 'Purchased'},
    {value: 'gift', label: 'Gift'},
    {value: 'trade', label: 'Trade'},
    {value: 'bulk_before_tracking', label: 'Bulk / before tracking'},
    {value: 'other', label: 'Other'}
];

export const RAW_CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG']

export const PROTECTION_TYPES = [
    {value: 'raw', label: 'Raw'},
    {value: 'penny_sleeve', label: 'Penny sleeve'},
    {value: 'card_saver', label: 'Card Saver'},
    {value: 'top_loader', label: 'Top loader / hard sleeve'},
    {value: 'psa_slab', label: 'PSA slab'},
    {value: 'tag_slab', label: 'TAG slab'},
    {value: 'other', label: 'Other'},
]

export const SEALED_CONDITIONS = [
    {value: 'factory_sealed', label: 'Factory sealed'},
    {value: 'sealed_with_wear', label: 'Sealed with wear'},
    {value: 'damaged_seal', label: 'Damaged seal'},
    {value: 'opened', label: 'Opened'},
]

export const REMOVAL_REASONS = [
    {value: 'sold', label: 'Sold'},
    {value: 'traded', label: 'Traded'},
    {value: 'gifted', label: 'Gifted'},
    {value: 'lost_damaged', label: 'Lost / damaged'},
    {value: 'other', label: 'Other'},
]


export function normalizeAcquisitionSourceForUi(value) {
    return value === 'unknown' ? 'other' : (value || '')
}
