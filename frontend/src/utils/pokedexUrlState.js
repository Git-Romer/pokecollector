export const getPokedexGeneration = (searchParams) => {
  const requestedGeneration = Number(searchParams.get('generation'))
  return Number.isInteger(requestedGeneration) && requestedGeneration >= 1 && requestedGeneration <= 9
    ? requestedGeneration
    : null
}

export const normalizePokedexSearchParams = (searchParams) => {
  const normalized = new URLSearchParams(searchParams)
  const requestedGenerations = normalized.getAll('generation')
  if (!requestedGenerations.length) return normalized

  const generation = getPokedexGeneration(normalized)
  if (generation) normalized.set('generation', String(generation))
  else normalized.delete('generation')

  return normalized
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
