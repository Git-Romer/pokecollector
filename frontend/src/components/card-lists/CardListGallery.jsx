import { CollectionCardDisplay } from '../CollectionCardImage'
import { CardDisplay, CardRequirementProgress, withCollectionItemState } from '../card-system'
import { getEffectiveCardPrice } from '../../utils/prices'

export default function CardListGallery({
  entries = [],
  mode = 'planned',
  onOpen,
  t,
  label,
  formatPrice,
  pricePrimaryField,
  publicQuantityLabel,
  publicDetailLabel,
}) {
  const planned = mode === 'planned'
  const publicView = mode === 'public'

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 md:grid-cols-6 lg:grid-cols-8" data-testid="card-list-gallery">
      {entries.map((entry, index) => {
        const card = entry.card || entry
        const requiredQuantity = Math.max(1, Number(entry.required_quantity ?? card.required_quantity ?? card.quantity) || 1)
        const ownedQuantity = Math.min(requiredQuantity, Math.max(0, Number(entry.available_quantity ?? entry.owned_quantity ?? card.owned_quantity) || 0))
        const variant = entry.display_variant?.variant || entry.variant || null
        const price = publicView ? Number(card.market_value || 0) : getEffectiveCardPrice(card, variant, pricePrimaryField)
        const displayCard = entry.card
          ? { ...card, owned: ownedQuantity > 0, owned_quantity: ownedQuantity }
          : card
        const stateItem = entry.card
          ? { ...displayCard, quantity: requiredQuantity, variant }
          : card
        const collectionItem = entry.card
          ? { id: entry.collection_item_id, has_scan_photo: entry.has_scan_photo, card }
          : { id: card.collection_item_id, has_scan_photo: card.has_scan_photo, card }
        const progressLabel = `${t('cardListPicker.progress')}: ${ownedQuantity}/${requiredQuantity}`
        const publicDetail = [card.set_name, card.rarity, publicDetailLabel?.(entry)].filter(Boolean).join(' · ')

        if (publicView) return (
          <CardDisplay
            key={entry.binder_card_id || entry.id || card.id}
            card={card}
            image={card.image || card.images_small}
            price={price > 0 && formatPrice ? formatPrice(price) : null}
            languageLabel={(card.lang || '').toUpperCase() || null}
            showStateIndicators={false}
            captionAccessory={(
              <span className="inline-flex rounded-full border border-border bg-bg-elevated px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                {publicQuantityLabel ? publicQuantityLabel(requiredQuantity, entry) : `×${requiredQuantity}`}
              </span>
            )}
            captionDetail={publicDetail || null}
            onClick={onOpen ? () => onOpen(entry, index) : undefined}
            actionLabel={label?.('cardListPicker.openCard', { name: card.name || card.id })}
          />
        )

        return (
          <CollectionCardDisplay
            key={entry.binder_card_id || entry.id || card.id}
            item={collectionItem}
            card={displayCard}
            price={price > 0 ? formatPrice(price) : null}
            variantEffectSource={entry.display_variant || variant || card}
            showStateIndicators={!planned}
            dimWhenUnowned={planned}
            stateIndicatorProps={!planned ? {
              card: withCollectionItemState(displayCard, stateItem),
              alwaysShowQuantity: true,
              showWishlist: false,
            } : undefined}
            captionAccessory={planned ? (
              <CardRequirementProgress
                ownedQuantity={ownedQuantity}
                requiredQuantity={requiredQuantity}
                progressLabel={progressLabel}
              />
            ) : undefined}
            onClick={() => onOpen(entry, index)}
            actionLabel={label?.('cardListPicker.openCard', { name: card.name || card.id })}
          />
        )
      })}
    </div>
  )
}
