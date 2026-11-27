import { useSettings } from '../../contexts/SettingsContext'
import { resolveCardImageUrl } from '../../utils/imageUrl'
import { getPrimaryCardPrice } from '../../utils/prices'
import { UnifiedCardDialog } from '../UnifiedCard'
import CardPriceDetails from './CardPriceDetails'

// Open a read-only Prices view. A warning must not select a bulk-removal row,
// add a card, or change the user's current editing dialog/tab.
export default function PricingWarningDialog({ card, variant, onClose }) {
  const { t, formatPrice, pricePrimary, pricePrimaryField } = useSettings()
  const price = getPrimaryCardPrice(card, variant, pricePrimary, pricePrimaryField)
  return (
    <UnifiedCardDialog
      card={card}
      image={resolveCardImageUrl(card, 'large')}
      price={price != null ? formatPrice(price) : null}
      variantEffectSource={variant}
      tabs={[{ id: 'prices', label: t('cardTabs.prices') }]}
      activeTab="prices"
      onClose={onClose}
    >
      <CardPriceDetails card={card} variant={variant} />
    </UnifiedCardDialog>
  )
}
