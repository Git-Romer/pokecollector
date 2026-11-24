// A tiny bus: the API client reports requests that failed without any response (network error,
// timeout) and the reachability monitor listens. Kept free of imports so client.js stays light.

const listeners = new Set()

export function notifyNetworkFailure() {
  listeners.forEach(cb => {
    try {
      cb()
    } catch {
      // a listener must never break the request that failed
    }
  })
}

export function onNetworkFailure(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
