// Runtime PWA feature flags (docs/PWA_OFFLINE_DESIGN.md §6.3.4).
// The frontend container writes <meta name="pokecollector-pwa" content="sw=1;queue=0">
// into index.html at start (docker-entrypoint.d/45-configure-pwa.sh). Without the
// meta tag (dev server, a plain static host) the build-time default applies.

const META_NAME = 'pokecollector-pwa'

function parseFlags(content) {
  const flags = { sw: false, queue: false }
  for (const part of String(content || '').split(';')) {
    const [key, value] = part.split('=').map(piece => piece.trim())
    if (key === 'sw' || key === 'queue') flags[key] = value === '1'
  }
  return flags
}

function buildDefault() {
  return typeof __PWA_DEFAULT__ === 'string' ? __PWA_DEFAULT__ : 'sw=0;queue=0'
}

export function readPwaFlags(doc = globalThis.document) {
  const meta = doc?.querySelector?.(`meta[name="${META_NAME}"]`)
  const content = meta?.getAttribute('content')
  return parseFlags(content == null ? buildDefault() : content)
}
