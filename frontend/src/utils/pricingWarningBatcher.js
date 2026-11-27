// One render can mount dozens of price captions. Keep their catalogue checks
// batched while React Query caches/refetches each card independently.
export function createPricingWarningBatcher(fetchBatch) {
  let pending = new Map()
  let scheduled = false

  async function flush() {
    const batch = pending
    pending = new Map()
    scheduled = false
    const ids = [...batch.keys()]
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500)
      try {
        const response = await fetchBatch(chunk)
        chunk.forEach(id => {
          const result = response?.warnings?.[id]
          batch.get(id).forEach(({ resolve, reject }) => {
            if (Array.isArray(result)) resolve(result)
            else reject(new Error('Missing pricing warning result'))
          })
        })
      } catch (error) {
        chunk.forEach(id => batch.get(id).forEach(({ reject }) => reject(error)))
      }
    }
  }

  return id => new Promise((resolve, reject) => {
    if (!pending.has(id)) pending.set(id, [])
    pending.get(id).push({ resolve, reject })
    if (!scheduled) {
      scheduled = true
      setTimeout(flush, 0)
    }
  })
}
