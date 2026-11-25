import { ITEM_TYPES } from '../../constants.js'
import { validateShape } from '../classify.js'

export const scanUpload = {
  type: ITEM_TYPES.SCAN_UPLOAD,

  /**
   * `POST /api/cards/recognize/jobs` as multipart. Every photo becomes a fresh in-memory
   * Blob (stored Blobs are unreliable on Safari). No `Content-Type`: `fetch` must add the
   * multipart boundary itself.
   */
  async buildRequest(item, readPhotos) {
    const form = new FormData()
    for await (const photo of readPhotos(item.id)) {
      form.append('files', new Blob([photo.bytes], { type: photo.type }), photo.name)
    }
    form.append('individual_positions', JSON.stringify(item.payload?.individualPositions ?? []))
    return { url: '/api/cards/recognize/jobs', method: 'POST', headers: {}, body: form }
  },

  validateResponse: json => validateShape(ITEM_TYPES.SCAN_UPLOAD, json),

  summarize(item) {
    return item.display?.title || `${item.photoCount} photo${item.photoCount === 1 ? '' : 's'}`
  },

  onSynced(queryClient) {
    queryClient?.invalidateQueries({ queryKey: ['scan-jobs'] })
  },
}
