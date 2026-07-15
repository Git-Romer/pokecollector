import sys
from sqlalchemy import func
from database import SessionLocal
from models import Card, CollectionItem

db = SessionLocal()

# 1. Update Variants to Holofoil based on Rarity
holo_rarities = [
    'Holo Rare', 'Ultra Rare', 'Secret Rare', 'Illustration Rare', 
    'Special Illustration Rare', 'Double Rare', 'Rare Holo', 'Rare Holo EX',
    'Rare Holo GX', 'Rare Holo V', 'Rare Holo VMAX', 'Rare Secret', 'Hyper Rare',
    'Amazing Rare', 'Radiant Rare', 'Classic Collection'
]

items = db.query(CollectionItem).all()
updated_variants = 0
for item in items:
    card = db.query(Card).filter(Card.id == item.card_id).first()
    if card and card.rarity:
        is_holo_rarity = any(hr.lower() in card.rarity.lower() for hr in holo_rarities)
        if is_holo_rarity and item.variant == 'Normal':
            item.variant = 'Holofoil'
            updated_variants += 1

db.commit()

# 2. Remove all dupes (keep exactly 1 of each card_id, regardless of variant/condition, or keep 1 of each specific card_id/variant combo?)
# The user said "remove all dupes". I will consolidate so there is only 1 row per card_id + variant, and force quantity = 1 for all items.
from collections import defaultdict
card_map = defaultdict(list)

items = db.query(CollectionItem).all()
for item in items:
    key = (item.card_id, item.variant, item.grade)
    card_map[key].append(item)

removed_dupes = 0
for key, row_list in card_map.items():
    if len(row_list) > 1:
        # keep the first one
        keeper = row_list[0]
        # set qty to 1
        keeper.quantity = 1
        
        # delete the rest
        for dupe in row_list[1:]:
            db.delete(dupe)
            removed_dupes += 1
    else:
        # even if there's only 1 row, ensure qty is 1
        if row_list[0].quantity > 1:
            row_list[0].quantity = 1
            removed_dupes += 1 # counting it as removed dupe

db.commit()

print(f"Updated {updated_variants} cards to Holofoil.")
print(f"Removed dupes / set all quantities to 1. Total adjustments: {removed_dupes}")
