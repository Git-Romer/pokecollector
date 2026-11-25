// Upload hardening for WebKit's empty-File-body bug (docs/PWA_OFFLINE_DESIGN.md §6.5.1, X2).
// A disk-backed File from the iOS photo picker can upload as an empty body once its
// temporary file goes away. Re-wrapping the bytes in memory avoids that. Active only
// when the PWA flags are on, so flag-off installs keep today's exact behaviour.

const EAGER_COPY_MAX_BYTES = 8 * 1024 * 1024

export async function prepareUploadPart(file, { enabled = false } = {}) {
  if (!enabled || !file || typeof file.size !== 'number') return file
  if (file.size <= EAGER_COPY_MAX_BYTES) {
    return new Blob([await file.arrayBuffer()], { type: file.type })
  }
  return file.slice(0, file.size, file.type)
}
