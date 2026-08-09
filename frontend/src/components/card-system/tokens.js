export const CARD_SYSTEM_TOKENS = Object.freeze({
  border: Object.freeze({
    default: Object.freeze({ base: 'var(--pc-card-border-default, #717a89)', hover: 'var(--pc-card-border-default-hover, #c6ccd7)' }),
    data: Object.freeze({ base: 'var(--pc-card-border-data, #a56cff)', hover: 'var(--pc-card-border-data-hover, #d391ff)' }),
    price: Object.freeze({ base: 'var(--pc-card-border-price, #f0aa38)', hover: 'var(--pc-card-border-price-hover, #ffd16b)' }),
    image: Object.freeze({ base: 'var(--pc-card-border-image, #55a7ff)', hover: 'var(--pc-card-border-image-hover, #86e3ff)' }),
  }),
  variants: Object.freeze(['grid', 'carousel', 'ranking', 'selectable', 'artwork', 'compact-artwork', 'comparison']),
})

export const CARD_DISPLAY_VARIANTS = CARD_SYSTEM_TOKENS.variants
