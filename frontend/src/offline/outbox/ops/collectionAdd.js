import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../../../utils/queryInvalidation.js'
import { ITEM_TYPES, JSON_TIMEOUT_MS } from '../../constants.js'
import { validateShape } from '../classify.js'

export const collectionAdd = {
  type: ITEM_TYPES.COLLECTION_ADD,
  timeoutMs: JSON_TIMEOUT_MS,

  /** `payload` is the `CollectionItemCreate` body (purchase price already in EUR). */
  async buildRequest(item) {
    return {
      url: '/api/collection/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item.payload),
    }
  },

  validateResponse: json => validateShape(ITEM_TYPES.COLLECTION_ADD, json),

  summarize(item) {
    return item.display?.title || item.payload?.card_id || 'Collection add'
  },

  onSynced(queryClient) {
    if (!queryClient) return
    invalidateCardState(queryClient)
    invalidateTcgdexFilterLanguages(queryClient)
  },
}
