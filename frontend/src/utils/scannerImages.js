export const SCANNER_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif'

const SUPPORTED_SCANNER_IMAGE_TYPES = new Set(SCANNER_IMAGE_ACCEPT.split(','))

export function isSupportedScannerImage(file) {
  return Boolean(file && SUPPORTED_SCANNER_IMAGE_TYPES.has(String(file.type || '').toLowerCase()))
}
