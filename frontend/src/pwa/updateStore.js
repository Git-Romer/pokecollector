// Tiny external store that connects the service-worker registration code to the update banner.
let state = { registration: null, blocked: false }
const listeners = new Set()

function set(next) {
  state = { ...state, ...next }
  listeners.forEach(listener => listener())
}

export const updateStore = {
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot: () => state,
  setReady: registration => set({ registration, blocked: false }),
  setBlocked: blocked => set({ blocked }),
  reset: () => set({ registration: null, blocked: false }),
}
