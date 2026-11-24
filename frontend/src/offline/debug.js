// Production-safe debug flags for testing the offline path from an iPhone
// (docs/PWA_OFFLINE_DESIGN.md §6.2.6 "Debug flags").

export const DEBUG_FLAGS = Object.freeze(['forceUnreachable', 'forceQuota', 'forceLostResponse'])

const KEY_PREFIX = 'pc.debug.'

function getStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** True when `localStorage['pc.debug.<name>'] === '1'`. Unknown names are always false. */
export function debugFlag(name, storage = getStorage()) {
  if (!DEBUG_FLAGS.includes(name) || !storage) return false
  try {
    return storage.getItem(KEY_PREFIX + name) === '1'
  } catch {
    return false
  }
}

/**
 * Reads `?pc_debug=a,b` (set) or `?pc_debug=off` (clear all), stores the flags and
 * strips the parameter with `history.replaceState`. Returns the names applied.
 */
export function applyDebugParams({
  location = globalThis.location,
  history = globalThis.history,
  storage = getStorage(),
} = {}) {
  if (!location) return []
  let url
  try {
    url = new URL(location.href)
  } catch {
    return []
  }
  if (!url.searchParams.has('pc_debug')) return []
  const raw = url.searchParams.get('pc_debug') || ''
  const applied = []
  try {
    if (raw.trim() === 'off') {
      DEBUG_FLAGS.forEach(name => storage?.removeItem(KEY_PREFIX + name))
    } else {
      for (const name of raw.split(',').map(part => part.trim())) {
        if (DEBUG_FLAGS.includes(name) && !applied.includes(name)) {
          storage?.setItem(KEY_PREFIX + name, '1')
          applied.push(name)
        }
      }
    }
  } catch {
    // storage unavailable: nothing to apply
  }
  try {
    url.searchParams.delete('pc_debug')
    history?.replaceState(history.state ?? null, '', url.pathname + url.search + url.hash)
  } catch {
    // ignore
  }
  return applied
}
