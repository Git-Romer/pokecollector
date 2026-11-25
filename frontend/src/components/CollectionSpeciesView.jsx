import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import CardGroupSection from './CardGroupSection'
import WindowedCardGrid from './WindowedCardGrid'
import { formatDexNumber, formatSpeciesCounts, groupCollectionBySpecies, speciesSpriteUrl } from '../utils/species'

/** Independently foldable groups retain full datasets in the shared windowed grid. */
export default function CollectionSpeciesView({ items, speciesByDexId, language, t, formatPrice, itemValue, renderItem }) {
  const { groups, other } = useMemo(() => groupCollectionBySpecies(items, {
    speciesByDexId, language, itemValue,
  }), [items, speciesByDexId, language, itemValue])
  const [collapsed, setCollapsed] = useState(() => new Set())
  const toggledHeader = useRef(null)
  useLayoutEffect(() => {
    const header = toggledHeader.current
    toggledHeader.current = null
    // Collapsing a large preceding grid can clamp the document scroll offset.
    // Keep the header the user just activated reachable, rather than below a
    // now-removed block of card rows.
    if (header?.isConnected) header.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
  }, [collapsed])
  const sections = useMemo(() => [
    ...groups.map(group => ({ ...group, id: String(group.dexId) })),
    ...(other.items.length ? [{ ...other, id: 'other', name: t('collection.otherCards') }] : []),
  ], [groups, other, t])

  return <div className="space-y-3" data-species-view>
    {sections.map(group => <CardGroupSection
      key={group.id} groupId={`collection-species-${group.id}`} heading={group.name}
      eyebrow={group.dexId ? formatDexNumber(group.dexId) : null}
      spriteSrc={group.dexId ? speciesSpriteUrl(group.dexId) : null}
      summary={group.dexId ? formatSpeciesCounts(t, group.printingCount, group.copies) : `${group.copies} ${t('analytics.copies')}`}
      totalValue={group.totalValue} formatPrice={formatPrice}
      open={!collapsed.has(group.id)} onToggle={event => {
        toggledHeader.current = event.currentTarget
        setCollapsed(previous => {
          const next = new Set(previous)
          if (next.has(group.id)) next.delete(group.id)
          else next.add(group.id)
          return next
        })
      }}
    >
      <div className="p-3">
        <WindowedCardGrid deferOffscreen items={group.items} label={group.name} listKey={`collection-species-${group.id}`} renderItem={renderItem} />
      </div>
    </CardGroupSection>)}
  </div>
}
