export function formatBinderCountSummary(cardCount, uniqueCardCount, t) {
  const total = Number(cardCount) || 0
  const unique = Number(uniqueCardCount) || 0
  const totalLabel = total === 1 ? t('binders.card') : t('binders.cards')
  const totalSummary = `${total} ${totalLabel}`
  if (unique === total) return totalSummary
  const uniqueLabel = unique === 1 ? t('binders.uniqueCard') : t('binders.uniqueCards')
  return `${totalSummary} · ${unique} ${uniqueLabel}`
}
