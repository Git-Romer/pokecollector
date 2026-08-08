import { formatMoneyInputValue, parseMoneyInputValue } from './moneyInput'

export function findNewTradeDraftItem(items, matches) {
  return items.find(item => !item.trade_item_id && matches(item))
}

export function isCashTradeItem(item) {
  if (item?.card_id) return false
  if ((item?.card_name || '').toLowerCase() !== 'cash') return false
  if ((item?.set_id || '').toLowerCase() === 'cash' && (item?.card_number || '').toLowerCase() === 'cash') return true
  return ['cash added to trade', 'cash received in trade'].includes((item?.notes || '').toLowerCase())
}

export function snapshotTradeCard(item) {
  return {
    ...(item.card || {}),
    id: item.card_id,
    name: item.card_name || item.card?.name,
    set_id: item.set_id || item.card?.set_id,
    number: item.card_number || item.card?.number,
    images_small: item.card?.images_small,
    images_large: item.card?.images_large,
    custom_image_url: item.card?.custom_image_url,
  }
}

export function tradeToDraft(trade, exchangeRate) {
  const cardItems = (trade.items || []).filter(item => !isCashTradeItem(item))
  const cashItem = (direction) => (trade.items || []).find(
    item => item.direction === direction && isCashTradeItem(item)
  )
  return {
    partnerName: trade.partner_name || '',
    tradeDate: trade.trade_date,
    notes: trade.notes || '',
    outgoingCash: formatMoneyInputValue(cashItem('outgoing')?.value_total || 0, exchangeRate),
    incomingCash: formatMoneyInputValue(cashItem('incoming')?.value_total || 0, exchangeRate),
    outgoing: cardItems.filter(item => item.direction === 'outgoing').map(item => ({
      key: `existing-out-${item.id}`,
      trade_item_id: item.id,
      collectionItem: {
        id: item.original_collection_item_id,
        card: snapshotTradeCard(item),
        quantity: 999,
        product_sources: item.product_card_id ? [{}] : [],
      },
      maxQuantity: 999,
      quantity: item.quantity,
      value_per_card: formatMoneyInputValue(item.value_per_card, exchangeRate),
      variant: item.variant || 'Normal',
      condition: item.condition || 'NM',
      lang: item.lang || item.card?.lang || 'en',
      notes: item.notes || '',
    })),
    incoming: cardItems.filter(item => item.direction === 'incoming').map(item => ({
      key: `existing-in-${item.id}`,
      trade_item_id: item.id,
      card: snapshotTradeCard(item),
      quantity: item.quantity,
      value_per_card: formatMoneyInputValue(item.value_per_card, exchangeRate),
      variant: item.variant || 'Normal',
      condition: item.condition || 'NM',
      lang: item.lang || item.card?.lang || 'en',
      notes: item.notes || '',
    })),
  }
}

export function buildTradeUpdatePayload({
  partnerName,
  tradeDate,
  notes,
  outgoingCash,
  incomingCash,
  outgoing,
  incoming,
}, exchangeRate) {
  return {
    partner_name: partnerName || null,
    trade_date: tradeDate,
    notes: notes || null,
    outgoing_cash: parseMoneyInputValue(outgoingCash, exchangeRate, 0) || 0,
    incoming_cash: parseMoneyInputValue(incomingCash, exchangeRate, 0) || 0,
    outgoing: outgoing.map(item => ({
      ...(item.trade_item_id
        ? { trade_item_id: item.trade_item_id }
        : { collection_item_id: item.collectionItem.id }),
      quantity: Number(item.quantity) || 1,
      ...(item.trade_item_id ? { condition: item.condition || 'NM' } : {}),
      notes: item.notes || null,
    })),
    incoming: incoming.map(item => ({
      ...(item.trade_item_id
        ? { trade_item_id: item.trade_item_id }
        : { card_id: item.card.id }),
      quantity: Number(item.quantity) || 1,
      condition: item.condition,
      variant: item.variant,
      lang: item.lang || item.card.lang || 'en',
      notes: item.notes || null,
    })),
  }
}
