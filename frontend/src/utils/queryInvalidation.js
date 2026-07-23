export function invalidateTcgdexFilterLanguages(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['tcgdex-filter-languages'] })
  // Collection and wishlist mutations can change species completion and the
  // ordering shown on Pokédex detail pages.
  queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'pokedex' })
}

/** Refresh every cached card-tile view affected by a collection/wishlist mutation. */
export function invalidateCardState(queryClient, { setId } = {}) {
  queryClient.invalidateQueries({ queryKey: ['collection'] })
  queryClient.invalidateQueries({ queryKey: ['wishlist'] })
  queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'card-search' })
  queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'pokedex' })
  if (setId) queryClient.invalidateQueries({ queryKey: ['set-checklist', setId] })
}
