import { useContext, useRef } from 'react'
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query'
import { getHoloEffectForCard } from '../utils/holoEffects'
import { getCardVariantEffectType } from '../utils/cardVariantEffect'
import { useSettings } from '../contexts/SettingsContext'
import { useHoloMotion } from './useHoloMotion'
import '../vendor/pokemon-cards-css/scoped.css'
import './HoloEffectOverlay.css'

const fallbackQueryClient = new QueryClient()
function getVariant(source) {
  const effect = getCardVariantEffectType(source)
  return effect === 'holo' ? 'Holo' : effect === 'reverse' ? 'Reverse Holo' : null
}
function officialId(card) { return card?.card_id || (typeof card?.id === 'string' ? card.id : null) }
export function isHoloEffectSurface({ card, imageUrl, variant, enabled }) {
  if (!enabled || !['Holo', 'Reverse Holo'].includes(variant) || !card || card.is_custom) return false
  if (!card.tcg_card_id || !card.lang || !(card.images_large || card.images?.large)) return false
  const id = officialId(card)
  return Boolean(id && ['large', 'small'].some(size => imageUrl === `/api/images/card/${encodeURIComponent(id)}/${size}`))
}
export default function HoloEffectOverlay({ card, imageUrl, variantSource, mode = 'subtle' }) {
  const { settings } = useSettings()
  const variant = getVariant(variantSource)
  const enabled = settings?.holo_effects_enabled === 'true'
  const eligible = isHoloEffectSurface({ card, imageUrl, variant, enabled })
  const queryClient = useContext(QueryClientContext) || fallbackQueryClient
  const largeImage = officialId(card) ? `/api/images/card/${encodeURIComponent(officialId(card))}/large` : null
  const { data } = useQuery({
    queryKey: ['holo-effect', card?.tcg_card_id, card?.lang, variant, officialId(card), largeImage],
    queryFn: () => getHoloEffectForCard(card, { enabled, variant, imageUrl: largeImage }),
    enabled: eligible, staleTime: 30_000, gcTime: 300_000, retry: false, refetchOnWindowFocus: true,
  }, queryClient)
  const effect = eligible && data?.maskUrl && data?.foilMapUrl ? data : null
  const ref = useRef(null)
  useHoloMotion(ref, effect, card, mode)
  if (!effect) return null
  return (
    <span ref={ref} className="holo-effect-layer" data-holo-profile={effect.foilProfile} aria-hidden="true">
      <span className="pc-holo-card__shine" />
      <span className="pc-holo-card__glare" />
    </span>
  )
}
