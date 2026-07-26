import { getCardRarityEffectClass } from '../utils/cardRarity'

// Wraps a card image div and adds rarity-based visual effects
// rarity: string from the card data (e.g. "Rare Holo", "Ultra Rare", "Secret Rare", "Common", etc.)
export default function RarityBorder({ rarity = '', language = 'en', children, className = '' }) {
  const rarityClass = getCardRarityEffectClass(rarity, language)

  return (
    <div
      className={`relative ${rarityClass} ${className}`}
      style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {children}
    </div>
  )
}
