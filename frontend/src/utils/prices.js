export const PRICE_PRIMARY_TO_FIELD = {
    market: 'price_market',
    avg: 'price_market',
    trend: 'price_trend',
    avg1: 'price_avg1',
    avg7: 'price_avg7',
    avg30: 'price_avg30',
    low: 'price_low',
}

export const HOLO_VARIANTS = new Set(['Holo', 'Holo Rare', 'Holo V', 'Holo VMAX', 'Holo VSTAR', 'Holo ex', 'Reverse Holo'])

export const HOLO_FIELD_MAP = {
    price_market: 'price_market_holo',
    price_trend: 'price_trend_holo',
    price_avg1: 'price_avg1_holo',
    price_avg7: 'price_avg7_holo',
    price_avg30: 'price_avg30_holo',
    price_low: 'price_low_holo',
}

export function priceFieldFromPrimary(pricePrimary) {
    return PRICE_PRIMARY_TO_FIELD[pricePrimary] || 'price_trend'
}

function positivePrice(value) {
    if (value == null) return null
    const price = Number(value)
    return Number.isFinite(price) && price > 0 ? price : null
}

export function getEffectiveCardPrice(card, variant, priceField = 'price_trend') {
    if (!card) return 0
    if (HOLO_VARIANTS.has(variant)) {
        const holoField = HOLO_FIELD_MAP[priceField]
        const candidates = [
            holoField ? card[holoField] : null,
            card[priceField],
            card.price_market_holo,
            card.price_market,
        ]
        for (const candidate of candidates) {
            const price = positivePrice(candidate)
            if (price != null) return price
        }
        return 0
    }

    for (const candidate of [card[priceField], card.price_market]) {
        const price = positivePrice(candidate)
        if (price != null) return price
    }
    return 0
}
