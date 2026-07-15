import sys
import re
from sqlalchemy.orm import Session
from database import SessionLocal
from models import Card, CollectionItem

data = """
1	Meowth ex	Perfect Order	POR / ME03	062/088	Double Rare
1	Koraidon	Temporal Forces	TEF / SV05	119/162	Holo Rare
1	Ledian	Stellar Crown	SCR / SV07	144/142	Illustration Rare
1	Simipour	Black Bolt	BLK / SV10.5	102/086	Illustration Rare
2	Rhyperior	Stellar Crown	SCR / SV07	076/142	Holo Rare
1	Clobbopus	Surging Sparks	SSP / SV08	207/191	Illustration Rare
1	Klefki	Scarlet & Violet Base Set	SVI / SV01	096/198	Reverse Holo
1	Skeledirge	Scarlet & Violet Base Set	SVI / SV01	038/198	Reverse Holo
1	Sparkling Crystal	Stellar Crown	SCR / SV07	142/142	ACE SPEC
1	Grimmsnarl	Stellar Crown	SCR / SV07	096/142	Reverse Holo
2	Iron Boulder	Stellar Crown	SCR / SV07	071/142	Reverse Holo
1	Iron Jugulis	Paradox Rift	PAR / SV04	158/182	Reverse Holo
1	Mega Starmie ex	Perfect Order	POR / ME03	021/088	Double Rare
1	Bouffalant	Stellar Crown	SCR / SV07	119/142	Reverse Holo
1	Mabosstiff ex	Scarlet & Violet Black Star Promos	SVP	086	Promo
1	Alcremie	Stellar Crown	SCR / SV07	065/142	Reverse Holo
1	Baxcalibur	Paldea Evolved	PAL / SV02	060/193	Holo Rare
1	Regidrago	Evolving Skies	EVS / SWSH07	124/203	Holo Rare
1	Koraidon	Scarlet & Violet Base Set	SVI / SV01	124/198	Holo Rare
1	Melmetal	Stellar Crown	SCR / SV07	104/142	Holo Rare
1	Lugia	Celebrations	CEL	022/025	Holo Rare
1	Professor's Research - Professor Turo	Scarlet & Violet Base Set	SVI / SV01	190/198	Uncommon
1	Zeraora	Silver Tempest	SIT / SWSH12	056/195	Rare
1	Slaking	Paldea Evolved	PAL / SV02	162/193	Holo Rare
1	Ditto	Pokemon 151	MEW / SV3.5	132/165	Holo Rare
1	Klinklang	Stellar Crown	SCR / SV07	101/142	Reverse Holo
1	Dragonite ex	Obsidian Flames	OBF / SV03	159/197	Double Rare
1	Ledian	Stellar Crown	SCR / SV07	003/142	Reverse Holo
1	Glaceon V	Evolving Skies	EVS / SWSH07	040/203	Ultra Rare
1	Glimmora	Paldea Evolved	PAL / SV02	126/193	Holo Rare
1	Chien-Pao	Paradox Rift	PAR / SV04	057/182	Holo Rare
1	Professor's Research - Professor Sada	Scarlet & Violet Base Set	SVI / SV01	189/198	Uncommon
1	Zacian	Crown Zenith	CRZ / SWSH12.5	094/159	Holo Rare
1	Iron Jugulis	Paradox Rift	PAR / SV04	216/182	Illustration Rare
1	Turtonator	Stellar Crown	SCR / SV07	146/142	Illustration Rare
"""

db = SessionLocal()

lines = [line.strip() for line in data.strip().split('\n') if line.strip()]

added_count = 0
for line in lines:
    parts = line.split('\t')
    if len(parts) >= 5:
        qty = int(parts[0])
        name = parts[1]
        set_code_full = parts[3]
        number_full = parts[4]
        
        # e.g., "POR / ME03" -> "ME03" or "POR". TCGdex usually uses lowercase like "sv1", "swsh12", "me03".
        # E.g., "SCR / SV07" -> "sv07" or "scr". Usually TCGdex uses things like "sv7" or "sv07" or "scr". 
        # Actually TCGdex uses "sv7" for Stellar Crown? Or "scr"? 
        # Let's search by name and number to be safe, or just name and number.
        
        number = number_full.split('/')[0].lstrip('0') # "062" -> "62"
        # Some numbers have leading zeros in DB, some don't. TCGdex usually doesn't strip leading zeros if it's part of the printed number, but we can do a flexible search.
        number_raw = number_full.split('/')[0]

        # Let's try to find it
        cards = db.query(Card).filter(Card.name.ilike(f"%{name}%")).all()
        
        best_match = None
        for c in cards:
            if c.number == number_raw or c.number == number or (c.number and number_raw in c.number):
                best_match = c
                break
        
        if not best_match:
            print(f"Could not find card: {name} #{number_raw}")
            continue
            
        print(f"Found {name} -> {best_match.id}")
        
        variant = parts[5] if len(parts) > 5 else "Normal"
        if "Reverse" in variant:
            v = "Reverse Holo"
        elif "Holo" in variant:
            v = "Holo"
        else:
            v = "Normal"
            
        item = CollectionItem(
            card_id=best_match.id,
            user_id=1,
            quantity=qty,
            variant=v,
            condition="NM"
        )
        db.add(item)
        added_count += qty

db.commit()
print(f"Successfully added {added_count} cards.")
