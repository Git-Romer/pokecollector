// Feature detection only; no user-agent sniffing (docs/PWA_OFFLINE_DESIGN.md P4 task 4).

export function isStandalone(win = globalThis.window) {
  try {
    if (!win) return false
    if (win.navigator?.standalone === true) return true
    return Boolean(win.matchMedia?.('(display-mode: standalone)')?.matches)
  } catch {
    return false
  }
}

/** §6.7.2: true on iOS only inside the installed app. */
export function pushSupported(win = globalThis.window) {
  return Boolean(win && win.isSecureContext && 'PushManager' in win && 'Notification' in win)
}

export function getCapabilities(win = globalThis.window) {
  const nav = win?.navigator
  return {
    secureContext: Boolean(win?.isSecureContext),
    serviceWorker: Boolean(nav && 'serviceWorker' in nav),
    indexedDB: typeof win?.indexedDB !== 'undefined' && win.indexedDB !== null,
    storageManager: typeof nav?.storage?.persist === 'function',
    standalone: isStandalone(win),
    push: pushSupported(win),
  }
}
