const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

export function normalizeHandle(raw) {
  return String(raw || '').trim().toLowerCase()
}

export function isValidHandleFormat(raw) {
  const handle = normalizeHandle(raw)
  if (handle.length < 3 || handle.length > 30) return false
  if (handle.includes('--')) return false
  return HANDLE_RE.test(handle)
}
