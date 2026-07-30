// Collapse a public binder's flat card list (one entry per print) into one tile
// per card, carrying every owned variant. The API already returns entries sorted
// by set -> card number -> variant, so a card's prints arrive contiguously; we
// preserve first-seen order for both cards and their prints.
export function groupCardsByPrint(cards) {
  const byId = new Map()
  for (const c of cards || []) {
    let tile = byId.get(c.id)
    if (!tile) {
      tile = {
        id: c.id,
        name: c.name,
        image: c.image,
        set_name: c.set_name,
        number: c.number,
        rarity: c.rarity,
        lang: c.lang,
        data_source_lang: c.data_source_lang,
        price_source_lang: c.price_source_lang,
        image_source_lang: c.image_source_lang,
        prints: [],
      }
      byId.set(c.id, tile)
    }
    tile.prints.push({
      variant: c.variant,
      quantity: c.quantity,
      market_value: c.market_value,
    })
  }

  return [...byId.values()].map(tile => {
    const priced = tile.prints.filter(p => p.market_value != null)
    const total_value = priced.length
      ? priced.reduce((sum, p) => sum + p.market_value * (p.quantity || 1), 0)
      : null
    return { ...tile, variantCount: tile.prints.length, total_value }
  })
}
