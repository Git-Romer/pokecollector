import sys
from sqlalchemy.orm import Session
from database import SessionLocal
from models import Card, CollectionItem, Set

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

db = SessionLocal()

lines = [line.strip() for line in data.strip().split('\n') if line.strip()]

added_cards = 0
added_collection = 0
for line in lines:
    parts = [p.strip() for p in line.split('|')]
    if len(parts) >= 5:
        qty = int(parts[1])
        name_raw = parts[2]
        name = name_raw.split(' (')[0]
        num_str = parts[4].split(' (')[0]
        num_raw = num_str.split('/')[0]
        
        # Check if card exists in me01 with this exact number
        card = db.query(Card).filter(Card.set_id == 'me01', Card.number == num_raw).first()
        
        if not card:
            print(f"Force-creating Card: {name} #{num_raw}")
            card_id = f"me01-{num_raw}_en"
            # In case it exists under a different name
            existing = db.query(Card).filter(Card.id == card_id).first()
            if existing:
                card = existing
            else:
                card = Card(
                    id=card_id,
                    name=name,
                    set_id="me01",
                    number=num_raw,
                    supertype="Pokémon", # fallback
                    rarity="Unknown",
                    hp=None,
                    types=[],
                    subtypes=[],
                    image_url=None
                )
                db.add(card)
                db.commit()
                db.refresh(card)
                added_cards += 1
        
        # Add to collection
        item = CollectionItem(
            card_id=card.id,
            user_id=1,
            quantity=qty,
            variant="Normal",
            condition="NM"
        )
        db.add(item)
        added_collection += qty

db.commit()
print(f"Force-created {added_cards} custom cards. Added {added_collection} to collection.")
