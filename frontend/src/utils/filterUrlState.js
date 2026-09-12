const cloneValue = (value) => Array.isArray(value) ? [...value] : value

export function cloneFilterState(state) {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, cloneValue(value)]),
  )
}

export function readFilterUrlState(searchParams, definitions) {
  const params = new URLSearchParams(searchParams)

  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
    if (definition.type === 'list') {
      const values = params.getAll(definition.param)
        .map(value => value.trim())
        .filter(Boolean)
      return [key, values.length ? [...new Set(values)] : cloneValue(definition.default)]
    }

    if (definition.type === 'boolean') {
      return [key, params.get(definition.param) === '1']
    }

    const value = params.get(definition.param)
    return [key, value == null ? definition.default : value.trim()]
  }))
}

export function writeFilterUrlState(searchParams, definitions, state) {
  const next = new URLSearchParams(searchParams)

  Object.values(definitions).forEach(definition => next.delete(definition.param))

  Object.entries(definitions).forEach(([key, definition]) => {
    const value = state[key]
    if (definition.type === 'list') {
      ;[...new Set(value || [])]
        .map(item => String(item).trim())
        .filter(Boolean)
        .forEach(item => next.append(definition.param, item))
      return
    }
    if (definition.type === 'boolean') {
      if (value) next.set(definition.param, '1')
      return
    }
    const normalized = String(value ?? '').trim()
    if (normalized && normalized !== String(definition.default ?? '')) {
      next.set(definition.param, normalized)
    }
  })

  return next
}

export function clearFilterUrlState(searchParams, definitions) {
  const next = new URLSearchParams(searchParams)
  Object.values(definitions).forEach(definition => next.delete(definition.param))
  return next
}

export function hasFilterUrlState(searchParams, definitions) {
  const params = new URLSearchParams(searchParams)
  return Object.values(definitions).some(definition => params.has(definition.param))
}
