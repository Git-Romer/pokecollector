export function invalidateTcgdexFilterLanguages(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['tcgdex-filter-languages'] })
}
