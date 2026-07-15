import sys
from sqlalchemy.orm import Session
from database import SessionLocal
from models import Card, CollectionItem

db = SessionLocal()

data = """
| 1 | Forest of Vitality (Trainer) | Mega Evolution (verify) | 133/132 (verify) |
| 1 | Hariyama | Mega Evolution | 061/132 |
| 1 | Registeel | Mega Evolution | 129/132 |
| 1 | Applin | Mega Evolution | 018/132 |
| 1 | Mareep | Mega Evolution | 027/132 |
| 1 | Fennekin | Mega Evolution | 011/132 |
| 1 | Trapinch | Mega Evolution | 030/132 |
| 1 | Flapple | Mega Evolution | 019/132 |
| 1 | Zubat | Mega Evolution | 029/132 |
| 1 | Ange Floette (Stadium) | Mega Evolution | 075/086 (verify) |
| 1 | Metagross | Mega Evolution | 081/132 |
| 1 | Alolan Dugtrio | Mega Evolution | 037/132 |
| 1 | Bronzor | Mega Evolution | 126/132 |
| 1 | Slugma | Mega Evolution | 009/132 |
| 1 | Togetic | Mega Evolution | 071/132 |
| 1 | Baltoy | Mega Evolution | 056/132 |
| 1 | Feebas | Mega Evolution | 036/132 |
| 1 | Mespirit | Mega Evolution | 070/132 |
| 1 | Ambipom | Mega Evolution | 110/132 |
| 1 | Surfer (Trainer) | Mega Evolution | 127/132 |
| 1 | Altaria | Mega Evolution | 044/132 |
| 1 | Castform Sunny Form | Mega Evolution | 010/132 |
| 1 | Tapu Koko | Mega Evolution | 023/132 |
| 1 | Yamask | Mega Evolution | 063/132 |
| 1 | Bouffalant | Mega Evolution | 119/132 |
| 1 | Metang | Mega Evolution | 080/132 |
| 1 | Maushold | Mega Evolution | 118/132 |
"""

lines = [line.strip() for line in data.strip().split('\n') if line.strip()]
mega_sets = ['me01', 'me02', 'me02.5', 'me03', 'me04', 'mee']

# Clean up previously inserted custom cards
for line in lines:
    parts = [p.strip() for p in line.split('|')]
    if len(parts) >= 5:
        num_str = parts[4].split(' (')[0]
        num_raw = num_str.split('/')[0]
        c = db.query(Card).filter(Card.id == f"me01-{num_raw}_en").first()
        if c:
            items = db.query(CollectionItem).filter(CollectionItem.card_id == c.id).all()
            for i in items:
                db.delete(i)
            db.delete(c)
db.commit()

added = 0
for line in lines:
    parts = [p.strip() for p in line.split('|')]
    if len(parts) >= 5:
        qty = int(parts[1])
        name_raw = parts[2]
        name = name_raw.split(' (')[0]
        
        cards = db.query(Card).filter(Card.name.ilike(f"%{name}%"), Card.set_id.in_(mega_sets)).all()
        
        if not cards:
            # If still not found, try searching ALL sets to find the most recent one
            cards = db.query(Card).filter(Card.name.ilike(f"%{name}%")).all()

        if not cards:
            print(f"FAILED: Cannot find {name} anywhere.")
            continue
            
        best_match = cards[-1] # Usually later sets have higher IDs, or we just pick one
        
        # Try to prioritize exact match in a mega set
        for c in cards:
            if c.set_id in mega_sets:
                best_match = c
                break

        print(f"Found {name} -> {best_match.id} ({best_match.number}) in set {best_match.set_id}")
        
        item = CollectionItem(
            card_id=best_match.id,
            user_id=1,
            quantity=qty,
            variant="Normal",
            condition="NM"
        )
        db.add(item)
        added += qty

db.commit()
print(f"Successfully added {added} correct cards.")
