export const getPokedexGeneration = (searchParams) => {
  const requestedGeneration = Number(searchParams.get('generation'))
  return Number.isInteger(requestedGeneration) && requestedGeneration >= 1 && requestedGeneration <= 9
    ? requestedGeneration
    : null
}
