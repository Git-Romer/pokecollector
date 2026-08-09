import sys
import re
from sqlalchemy.orm import Session
from database import SessionLocal
from models import Card, CollectionItem

data = """
1    Volcanion EX (Secret)    Steam Siege    STS    115/114    Secret Rare    Holofoil    PSA 9 - MINT tcgplayer.com
1    Iono's Kilowattrel    Journey Together    JTG    163/159    Illustration Rare    Holofoil    PSA 10 - GEM MT Pokémon
1    Yanmega ex    Destined Rivals    DRI    228/182    Special Illustration Rare    Holofoil    PSA 10 - GEM MT Pokémon
1    Tinkaton ex    Paldea Evolved    PAL    262/193    Special Illustration Rare    Holofoil    PSA 8 - NM-MT tcgplayer.com
1    Misty's Psyduck    Destined Rivals    DRI    193/182    Illustration Rare    Holofoil    PSA 8 - NM-MT tcgplayer.com
1    Mega Manectric ex    Mega Evolution    MEG    158/132    Ultra Rare    Holofoil    PSA 10 - GEM MT tcgplayer.com
"""

db = SessionLocal()

lines = [line.strip() for line in data.strip().split('\n') if line.strip()]

for line in lines:
    parts = re.split(r'    ', line)
    if len(parts) >= 8:
        qty = int(parts[0])
        name = parts[1]
        set_name = parts[2]
        number_str = parts[4]
        variant_str = parts[6]
        grade_str = parts[7]
        
        # parse grade
        # "PSA 9 - MINT tcgplayer.com" -> grader="PSA", grade="9 - MINT"
        grader = "PSA"
        if "PSA 10" in grade_str: grade = "10"
        elif "PSA 9" in grade_str: grade = "9"
        elif "PSA 8" in grade_str: grade = "8"
        else: grade = "Unknown"
        
        num = number_str.split('/')[0].lstrip('0')
        num_raw = number_str.split('/')[0]

        # Use precise matching if possible, otherwise fuzzy
        if "Tinkaton" in name:
            c = db.query(Card).filter(Card.set_id == "sv02", Card.number.in_([num, num_raw])).first()
        elif "Volcanion" in name:
            c = db.query(Card).filter(Card.set_id == "xy11", Card.number.in_([num, num_raw])).first()
        else:
            # try fuzzy name search + exact number
            name_clean = name.split(' (')[0].replace("Iono's ", "")
            cards = db.query(Card).filter(Card.name.ilike(f"%{name_clean}%")).all()
            c = None
            for card in cards:
                if card.number == num or card.number == num_raw:
                    c = card
                    break

        if not c:
            print(f"Could not find {name} #{num}")
            continue

        print(f"Adding SLAB: {name} ({c.id}) - {grader} {grade}")

        item = CollectionItem(
            card_id=c.id,
            user_id=1,
            quantity=qty,
            variant="Holo" if "Holo" in variant_str else "Normal",
            condition="NM",
            grader=grader,
            grade=grade,
            storage_type="Slab"
        )
        db.add(item)

db.commit()
print("Slabs added successfully.")
