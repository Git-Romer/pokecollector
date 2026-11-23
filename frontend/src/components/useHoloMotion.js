import { useEffect } from 'react'
import { attachHoloMotion } from '../utils/holoMotion'

export function useHoloMotion(ref, effect, card, mode) {
  const metadataKey = JSON.stringify({ category: card?.category, rarity: card?.rarity, name: card?.name,
    stage: card?.stage, localId: card?.localId, number: card?.number,
    set: { id: card?.set?.id }, set_id: card?.set_id })
  useEffect(() => attachHoloMotion(ref.current, effect, JSON.parse(metadataKey), mode),
    [ref, effect, metadataKey, mode])
}
