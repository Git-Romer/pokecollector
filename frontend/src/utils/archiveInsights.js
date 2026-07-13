const pluralize = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function deriveArchiveInsights({ recentAdditions = [], totalCards = 0, sets = [] }) {
  const notes = []
  const sortedSets = [...sets].sort((a, b) => ((b.owned_count || 0) / (b.total || b.total_cards || 1)) - ((a.owned_count || 0) / (a.total || a.total_cards || 1)))

  for (const set of sortedSets) {
    const total = set.total || set.total_cards || 0
    const owned = set.owned_count || 0
    const remaining = Math.max(total - owned, 0)
    const percent = total ? (owned / total) * 100 : 0
    if (remaining > 0 && percent >= 90) notes.push({ id: `near-${set.id}`, kind: 'near-completion', title: 'Within reach', body: `Only ${pluralize(remaining, 'card')} left in ${set.name}.`, href: `/sets/${set.id}` })
    if (remaining === 0 && total > 0) notes.push({ id: `complete-${set.id}`, kind: 'complete', title: 'Filed', body: `${set.name} is complete. Filed.`, href: `/sets/${set.id}` })
  }
  for (const card of recentAdditions) {
    if (card?.name) notes.push({ id: `recent-${card.id || card.card_id || card.name}`, kind: 'recent', title: 'Noted', body: `I've had my eye on ${card.name}.`, href: `/collection` })
  }
  if (totalCards > 0 && totalCards % 100 === 0) notes.push({ id: `milestone-${totalCards}`, kind: 'milestone', title: 'Milestone', body: `${totalCards} cards. The archive is growing nicely.`, href: '/collection' })
  return [...new Map(notes.map((note) => [note.id, note])).values()].slice(0, 3)
}
