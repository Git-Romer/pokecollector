import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../../../utils/queryInvalidation.js'
import { ITEM_TYPES, JSON_TIMEOUT_MS } from '../../constants.js'
import { validateShape } from '../classify.js'

export const wishlistAdd = {
  type: ITEM_TYPES.WISHLIST_ADD,
  timeoutMs: JSON_TIMEOUT_MS,

  /** `payload` is the `WishlistItemCreate` body. */
  async buildRequest(item) {
    return {
      url: '/api/wishlist/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item.payload),
    }
  },

  validateResponse: json => validateShape(ITEM_TYPES.WISHLIST_ADD, json),

  summarize(item) {
    return item.display?.title || item.payload?.card_id || 'Wishlist add'
  },

  onSynced(queryClient) {
    if (!queryClient) return
    invalidateCardState(queryClient)
    invalidateTcgdexFilterLanguages(queryClient)
  },
}
