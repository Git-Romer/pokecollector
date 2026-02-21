// Wraps a card image div and adds rarity-based visual effects
// rarity: string from the card data (e.g. "Rare Holo", "Ultra Rare", "Secret Rare", "Common", etc.)
export default function RarityBorder({ rarity = '', children, className = '' }) {
  const rarityLower = (rarity || '').toLowerCase()
  let rarityClass = ''

  if (
    rarityLower.includes('secret') ||
    rarityLower.includes('rainbow') ||
    rarityLower.includes('hyper')
  ) {
    rarityClass = 'card-secret'
  } else if (
    rarityLower.includes('ultra') ||
    rarityLower.includes('full art') ||
    rarityLower.includes('v max') ||
    rarityLower.includes('vmax')
  ) {
    rarityClass = 'card-holo'
  } else if (rarityLower.includes('holo') || rarityLower.includes('rare')) {
    rarityClass = 'card-holo'
  }

  return (
    <div
      className={`relative ${rarityClass} ${className}`}
      style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {children}
    </div>
  )
}
