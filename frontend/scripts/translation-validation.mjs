// Validate JSON before walking its tokens so the duplicate-key scanner can stay small.
// JSON.parse alone silently accepts duplicate keys, including escaped spellings.
export function parseCatalog(source) {
  const value = JSON.parse(source)
  const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || []
  let index = 0
  function walk(path) {
    const token = tokens[index++]
    if (token === '{') {
      const keys = new Set()
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++])
        const keyPath = [...path, key]
        if (keys.has(key)) throw new Error(`Duplicate key: ${keyPath.join('.')}`)
        keys.add(key)
        index++ // colon
        walk(keyPath)
        if (tokens[index] === ',') index++
      }
      index++
    } else if (token === '[') {
      let item = 0
      while (tokens[index] !== ']') {
        walk([...path, String(item++)])
        if (tokens[index] === ',') index++
      }
      index++
    }
  }
  walk([])
  return value
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const placeholders = value => [...new Set([...value.matchAll(/\{([A-Za-z_]\w*)\}/g)].map(match => match[1]))].sort()

export function validateCatalog(catalog, source) {
  const errors = []
  function walk(value, reference, path) {
    const label = path || '<root>'
    if (typeof value === 'string') {
      if (!path || isObject(reference)) {
        errors.push(`${label}: Expected an object.`)
      } else if (!value.trim()) {
        errors.push(`${label}: Empty translation; omit the key to use English fallback.`)
      } else if (typeof reference === 'string') {
        const expected = placeholders(reference)
        if (JSON.stringify(placeholders(value)) !== JSON.stringify(expected)) {
          errors.push(`${label}: Placeholder mismatch; expected ${expected.join(', ') || 'none'}.`)
        }
      }
    } else if (isObject(value) && typeof reference !== 'string') {
      for (const [key, child] of Object.entries(value)) {
        if (!key || key.includes('.') || ['__proto__', 'constructor', 'prototype'].includes(key)) {
          errors.push(`${label}: Invalid translation key ${JSON.stringify(key)}.`)
          continue
        }
        const original = Object.hasOwn(reference || {}, key) ? reference[key] : undefined
        walk(child, original, path ? `${path}.${key}` : key)
      }
    } else {
      errors.push(`${label}: Expected text or a nested object matching the English source.`)
    }
  }
  walk(catalog, source, '')
  return errors
}
