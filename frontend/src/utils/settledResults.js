export function partitionSettledResults(ids, results) {
  return {
    succeededIds: ids.filter((_id, index) => results[index]?.status === 'fulfilled'),
    failedIds: ids.filter((_id, index) => results[index]?.status === 'rejected'),
    failed: results.filter(result => result.status === 'rejected'),
  }
}
