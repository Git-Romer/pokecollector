import sys
from sqlalchemy.orm import Session
from sqlalchemy import func
from database import SessionLocal
from models import CollectionItem

db = SessionLocal()

# 1. Standardize variants
print("Standardizing variants...")
items = db.query(CollectionItem).all()
for item in items:
    v = item.variant
    if v:
        v_lower = v.lower()
        if "reverse" in v_lower:
            item.variant = "Reverse Holo"
        elif "holo" in v_lower:
            item.variant = "Holo"
        elif "first" in v_lower or "1st" in v_lower:
            item.variant = "First Edition"
        elif v_lower in ["normal", "regular", "standard"]:
            item.variant = "Normal"

db.commit()

# 2. Merge duplicate rows (same card_id, user_id, variant, condition, grader, grade, storage_type)
print("Merging identical rows...")
from collections import defaultdict

grouped = defaultdict(list)
for item in db.query(CollectionItem).all():
    key = (item.card_id, item.user_id, item.variant, item.condition, item.grader, item.grade, item.storage_type)
    grouped[key].append(item)

merged_count = 0
for key, row_list in grouped.items():
    if len(row_list) > 1:
        # Sort so we keep the oldest one (first added)
        row_list.sort(key=lambda x: x.id)
        primary = row_list[0]
        for duplicate in row_list[1:]:
            primary.quantity += duplicate.quantity
            db.delete(duplicate)
            merged_count += 1

db.commit()

# 3. Remove zero or negative quantity
print("Removing empty rows...")
deleted_zeroes = db.query(CollectionItem).filter(CollectionItem.quantity <= 0).delete()
db.commit()

print(f"Sanitization complete. Merged {merged_count} duplicate rows. Deleted {deleted_zeroes} empty rows.")
