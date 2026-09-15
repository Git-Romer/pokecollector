export const getPokedexGeneration = (searchParams) => {
  const requestedGeneration = Number(searchParams.get('generation'))
  return Number.isInteger(requestedGeneration) && requestedGeneration >= 1 && requestedGeneration <= 9
    ? requestedGeneration
    : null
}

export const POKEDEX_FORM_FAMILIES = ['all', 'base', 'mega', 'alola', 'galar', 'hisui', 'paldea']

export const getPokedexMode = (searchParams) => searchParams.get('mode') === 'forms' ? 'forms' : 'grouped'

export const getPokedexFormFamily = (searchParams) => {
  const value = searchParams.get('form')
  return getPokedexMode(searchParams) === 'forms' && POKEDEX_FORM_FAMILIES.includes(value)
    ? value
    : 'all'
}

export const normalizePokedexSearchParams = (searchParams) => {
  const normalized = new URLSearchParams(searchParams)
  const requestedGenerations = normalized.getAll('generation')
  if (requestedGenerations.length) {
    const generation = getPokedexGeneration(normalized)
    if (generation) normalized.set('generation', String(generation))
    else normalized.delete('generation')
  }
  const mode = getPokedexMode(normalized)
  if (mode === 'forms') normalized.set('mode', 'forms')
  else normalized.delete('mode')
  const formFamily = getPokedexFormFamily(normalized)
  if (mode === 'forms' && formFamily !== 'all') normalized.set('form', formFamily)
  else normalized.delete('form')

  return normalized
}

export const setPokedexMode = (searchParams, mode) => {
  const updated = new URLSearchParams(searchParams)
  if (mode === 'forms') updated.set('mode', 'forms')
  else {
    updated.delete('mode')
    updated.delete('form')
  }
  return updated
}

export const setPokedexFormFamily = (searchParams, family) => {
  const updated = new URLSearchParams(searchParams)
  if (getPokedexMode(updated) === 'forms' && POKEDEX_FORM_FAMILIES.includes(family) && family !== 'all') {
    updated.set('form', family)
  } else {
    updated.delete('form')
  }
  return updated
}

export const setPokedexGeneration = (searchParams, generation) => {
  const updated = new URLSearchParams(searchParams)
  if (Number.isInteger(generation) && generation >= 1 && generation <= 9) {
    updated.set('generation', String(generation))
  } else {
    updated.delete('generation')
  }
  return updated
}
