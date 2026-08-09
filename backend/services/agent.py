"""Local-only John John collection note generation.

This module intentionally does not call external AI services and does not read
Obsidian or other external knowledge stores. John John's PC keeps collection
insights derived from the local tracker database unless the user explicitly
opts into a future integration.
"""

import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import Card, CollectionItem, JohnJohnNote, Set


def build_context_packet(db: Session) -> dict:
    """Compile a small local collection state packet for deterministic notes."""
    total_cards = db.query(func.coalesce(func.sum(CollectionItem.quantity), 0)).scalar() or 0
    unique_cards = db.query(CollectionItem.card_id).filter(
        CollectionItem.status == "owned",
        CollectionItem.inventory_kind == "owned",
    ).distinct().count()

    yesterday = datetime.datetime.utcnow() - datetime.timedelta(days=1)
    recent_items = db.query(CollectionItem).filter(
        CollectionItem.status == "owned",
        CollectionItem.inventory_kind == "owned",
        CollectionItem.added_at > yesterday,
    ).order_by(CollectionItem.added_at.desc()).limit(10).all()

    recent_additions = []
    for item in recent_items:
        card = db.query(Card).filter(Card.id == item.card_id).first()
        if card:
            recent_additions.append({
                "name": card.name,
                "set_id": card.set_id,
                "quantity": item.quantity,
            })

    near_complete = []
    sets = db.query(Set).limit(200).all()
    for set_record in sets:
        total = getattr(set_record, "total", None) or getattr(set_record, "total_cards", None) or 0
        if not total:
            continue
        owned = db.query(func.coalesce(func.sum(CollectionItem.quantity), 0)).join(
            Card, Card.id == CollectionItem.card_id
        ).filter(
            CollectionItem.status == "owned",
            CollectionItem.inventory_kind == "owned",
            Card.set_id == set_record.id,
        ).scalar() or 0
        remaining = max(total - owned, 0)
        if 0 < remaining <= 5:
            near_complete.append({
                "name": set_record.name,
                "remaining": int(remaining),
                "owned": int(owned),
                "total": int(total),
            })

    return {
        "total_cards": int(total_cards),
        "unique_cards": unique_cards,
        "recent_additions": recent_additions,
        "near_complete_sets": sorted(near_complete, key=lambda item: item["remaining"])[:5],
    }


def _note_exists(db: Session, title: str, body: str) -> bool:
    return db.query(JohnJohnNote).filter(
        JohnJohnNote.title == title,
        JohnJohnNote.body == body,
        JohnJohnNote.dismissed == False,  # noqa: E712
    ).first() is not None


def run_night_shift(db: Session) -> list[JohnJohnNote]:
    """Create quiet, deterministic notes from local collection signals only."""
    context = build_context_packet(db)
    candidates = []

    if context["recent_additions"]:
        card = context["recent_additions"][0]
        candidates.append({
            "kind": "recent",
            "title": "Filed overnight",
            "body": f"I filed {card['name']}. Thought you'd want it near the front.",
            "href": "/collection",
        })

    if context["near_complete_sets"]:
        set_record = context["near_complete_sets"][0]
        plural = "card" if set_record["remaining"] == 1 else "cards"
        candidates.append({
            "kind": "milestone",
            "title": "Close one",
            "body": f"{set_record['name']} is down to {set_record['remaining']} {plural}.",
            "href": "/all-cards",
        })

    if context["total_cards"]:
        candidates.append({
            "kind": "curation",
            "title": "Archive count",
            "body": f"{context['total_cards']} cards filed. {context['unique_cards']} unique records in the room.",
            "href": "/collection",
        })

    created = []
    user_id = 1
    for candidate in candidates[:3]:
        if _note_exists(db, candidate["title"], candidate["body"]):
            continue
        note = JohnJohnNote(user_id=user_id, **candidate)
        db.add(note)
        created.append(note)
    db.commit()
    return created
