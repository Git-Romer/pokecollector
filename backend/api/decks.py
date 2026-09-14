import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, Card, CollectionItem, User
from schemas import (
    DeckCreate,
    DeckEntryCreate,
    DeckEntryUpdate,
    DeckResponse,
    DeckUpdate,
)
from services.binder_allocations import (
    collection_binder_allocation_counts,
    lock_user_card_allocations,
)
from services.card_list_names import normalize_card_list_name
from services.deck_allocation import allocation_for_decks, allocations_for_decks
from services.deck_analysis import analyze_deck
from services.deck_comparison import compare_decks
from services.deck_display_variants import representative_display_variants
from services.deck_probability import analyze_deck_probability
from services.deck_validation import validate_deck
from services.standard_legality import is_standard_regulation_mark

router = APIRouter()

COMPOSITION_CATEGORIES = ("Pokemon", "Trainer", "Energy", "Other")
DECK_TYPES = ("deck", "physical_deck")
PHYSICAL_DECK_TYPE = "physical_deck"


def _composition_category(supertype: str | None) -> str:
    normalized = str(supertype or "").strip().casefold()
    if normalized in ("pokemon", "pokémon"):
        return "Pokemon"
    if normalized == "trainer":
        return "Trainer"
    if normalized == "energy":
        return "Energy"
    return "Other"


def _deck_or_404(db: Session, deck_id: int, user_id: int, with_entries: bool = False) -> Binder:
    query = db.query(Binder).filter(
        Binder.id == deck_id,
        Binder.user_id == user_id,
        Binder.binder_type.in_(DECK_TYPES),
    )
    if with_entries:
        query = query.options(
            joinedload(Binder.binder_cards)
            .joinedload(BinderCard.card)
            .joinedload(Card.set_ref),
            joinedload(Binder.binder_cards).joinedload(BinderCard.collection_item),
        )
    deck = query.first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return deck


def _locked_deck_or_404(db: Session, deck_id: int, user_id: int) -> Binder:
    """Serialize every mutation of a Deck's plan and exact allocations."""
    deck = db.query(Binder).filter(
        Binder.id == deck_id,
        Binder.user_id == user_id,
        Binder.binder_type.in_(DECK_TYPES),
    ).populate_existing().with_for_update(of=Binder).first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return deck


def _allocating_lists(db: Session, user_id: int) -> list[Binder]:
    return db.query(Binder).options(joinedload(Binder.binder_cards)).filter(
        Binder.user_id == user_id,
        Binder.binder_type.in_(("collection", PHYSICAL_DECK_TYPE)),
    ).all()


def _owned_quantities(db: Session, user_id: int, card_ids: list[str]) -> dict[str, int]:
    if not card_ids:
        return {}
    return {
        card_id: int(quantity or 0)
        for card_id, quantity in db.query(
            CollectionItem.card_id,
            func.coalesce(func.sum(CollectionItem.quantity), 0),
        ).filter(
            CollectionItem.user_id == user_id,
            CollectionItem.card_id.in_(card_ids),
        ).group_by(CollectionItem.card_id).all()
    }


def _standard_legal_fingerprints(db: Session, relevant: set[str] | None = None) -> set[str]:
    if relevant is not None and not relevant:
        return set()
    query = db.query(
        Card.playable_fingerprint,
        Card.regulation_mark,
    ).filter(
        Card.is_custom.is_(False),
        Card.playable_fingerprint.isnot(None),
        Card.regulation_mark.isnot(None),
    )
    if relevant is not None:
        query = query.filter(Card.playable_fingerprint.in_(relevant))
    return {
        fingerprint
        for fingerprint, regulation_mark in query.all()
        if fingerprint and is_standard_regulation_mark(regulation_mark)
    }


def _deck_fingerprints(*decks: Binder) -> set[str]:
    return {
        entry.card.playable_fingerprint
        for deck in decks
        for entry in deck.entries
        if entry.card and entry.card.playable_fingerprint
    }


def _deck_response(
    deck: Binder,
    owned_quantities: dict[str, int] | None = None,
    standard_legal_fingerprints: set[str] | None = None,
    allocation: dict | None = None,
    display_variants: dict | None = None,
    include_entries: bool = True,
    include_insights: bool = True,
) -> DeckResponse:
    entries = list(deck.entries)
    owned_quantities = owned_quantities or {}
    allocation = allocation or {}
    display_variants = display_variants or {}
    target_size = int(deck.target_size or 60)
    current_card_count = sum(int(entry.required_quantity or 0) for entry in entries)
    composition_counts = {category: 0 for category in COMPOSITION_CATEGORIES}
    for entry in entries:
        category = _composition_category(entry.card.supertype if entry.card else None)
        composition_counts[category] += int(entry.required_quantity or 0)

    available_quantities = {
        entry.card_id: int(allocation.get(entry.card_id, {}).get(
            "available_to_this_deck",
            owned_quantities.get(entry.card_id, 0),
        ))
        for entry in entries
    }
    missing_copy_count = sum(
        max(int(entry.required_quantity or 0) - available_quantities.get(entry.card_id, 0), 0)
        for entry in entries
    )
    status = "under" if current_card_count < target_size else "over" if current_card_count > target_size else "complete"
    validation = validate_deck(deck, available_quantities, standard_legal_fingerprints) if include_insights else None
    copy_limit_check = next(
        (check for check in (validation or {}).get("checks", []) if check["code"] == "copy_limit"),
        None,
    )
    copy_limit_warnings = (copy_limit_check or {}).get("details", {}).get("violations", [])

    return DeckResponse(
        id=deck.id,
        name=deck.name,
        binder_type=deck.binder_type or "deck",
        color=deck.color or "#EE1515",
        icon_pokemon_id=deck.icon_pokemon_id,
        target_size=target_size,
        description=deck.description,
        format=deck.format or "Casual",
        shared_conflict_count=sum(
            1 for entry in entries if allocation.get(entry.card_id, {}).get("conflict", 0)
        ),
        shared_missing_copy_count=missing_copy_count,
        created_at=deck.created_at,
        updated_at=deck.updated_at,
        current_card_count=current_card_count,
        remaining_to_target=max(target_size - current_card_count, 0),
        over_target_by=max(current_card_count - target_size, 0),
        missing_copy_count=missing_copy_count,
        status=status,
        composition_counts=composition_counts,
        entries=[
            {
                "id": entry.id,
                "card_id": entry.card_id,
                "required_quantity": entry.required_quantity,
                "owned_quantity": int(owned_quantities.get(entry.card_id, 0)),
                "shortage": max(
                    int(entry.required_quantity or 0) - available_quantities.get(entry.card_id, 0),
                    0,
                ),
                "reserved_elsewhere": allocation.get(entry.card_id, {}).get("reserved_in_other_decks", 0),
                "reserved_in_this_deck": allocation.get(entry.card_id, {}).get("reserved_in_this_deck", 0),
                "allocated_quantity": allocation.get(entry.card_id, {}).get("reserved_in_this_deck", 0),
                "available_quantity": available_quantities.get(entry.card_id, 0),
                "display_variant": display_variants.get(entry.card_id),
                "card": entry.card,
            }
            for entry in entries
        ] if include_entries else [],
        copy_limit_warnings=copy_limit_warnings,
        validation=validation,
        analysis=analyze_deck(deck) if include_insights else None,
    )


def _loaded_decks(db: Session, user_id: int) -> list[Binder]:
    return db.query(Binder).options(
        joinedload(Binder.binder_cards).joinedload(BinderCard.card),
    ).filter(
        Binder.user_id == user_id,
        Binder.binder_type.in_(DECK_TYPES),
    ).order_by(Binder.updated_at.desc(), Binder.id.desc()).all()


@router.get("/", response_model=list[DeckResponse])
def get_decks(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    decks = _loaded_decks(db, current_user.id)
    if not decks:
        return []
    card_ids = [entry.card_id for deck in decks for entry in deck.entries]
    owned = _owned_quantities(db, current_user.id, card_ids)
    allocating_lists = _allocating_lists(db, current_user.id)
    allocations = allocations_for_decks(
        allocating_lists,
        owned,
        (deck.id for deck in decks),
    )
    return [
        _deck_response(
            deck,
            owned,
            allocation=allocations[deck.id],
            include_entries=False,
            include_insights=False,
        )
        for deck in decks
    ]


@router.post("/", response_model=DeckResponse)
def create_deck(payload: DeckCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    name = normalize_card_list_name(payload.name)
    now = datetime.datetime.utcnow()
    deck = Binder(
        name=name,
        target_size=payload.target_size,
        description=payload.description,
        format=payload.format,
        binder_type=payload.binder_type,
        user_id=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(deck)
    db.commit()
    db.refresh(deck)
    return _deck_response(deck, standard_legal_fingerprints=set())


@router.get("/compare")
def compare_owned_decks(
    left_id: int = Query(..., ge=1),
    right_id: int = Query(..., ge=1),
    hand: int = Query(7, ge=0, le=250),
    draws: int = Query(0, ge=0, le=250),
    card_name: str | None = Query(None, max_length=255),
    prize_count: int = Query(6, ge=0, le=250),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    left = _deck_or_404(db, left_id, current_user.id, with_entries=True)
    right = _deck_or_404(db, right_id, current_user.id, with_entries=True)
    owned = _owned_quantities(db, current_user.id, [entry.card_id for entry in left.entries + right.entries])
    allocating_lists = _allocating_lists(db, current_user.id)
    fingerprints = _standard_legal_fingerprints(db, _deck_fingerprints(left, right))
    allocations = allocations_for_decks(allocating_lists, owned, (left.id, right.id))
    left_response = _deck_response(left, owned, fingerprints, allocations[left.id])
    right_response = _deck_response(right, owned, fingerprints, allocations[right.id])
    left_data = left_response.model_dump() if hasattr(left_response, "model_dump") else left_response.dict()
    right_data = right_response.model_dump() if hasattr(right_response, "model_dump") else right_response.dict()
    return compare_decks(
        left_data,
        right_data,
        analyze_deck_probability(left, hand, draws, card_name, prize_count),
        analyze_deck_probability(right, hand, draws, card_name, prize_count),
    )


@router.post("/{deck_id}/duplicate", response_model=DeckResponse)
def duplicate_deck(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    source = _locked_deck_or_404(db, deck_id, current_user.id)
    now = datetime.datetime.utcnow()
    duplicate = Binder(
        name=f"{source.name} (Copy)",
        target_size=source.target_size,
        description=source.description,
        format=source.format,
        color=source.color,
        icon_pokemon_id=source.icon_pokemon_id,
        # A duplicate is a new plan. Exact physical copies stay assigned to
        # the source Real Deck until the user explicitly converts the copy.
        binder_type="deck",
        user_id=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(duplicate)
    db.flush()
    db.add_all([
        BinderCard(
            binder_id=duplicate.id,
            card_id=entry.card_id,
            required_quantity=entry.required_quantity,
            added_at=now,
        )
        for entry in source.entries
    ])
    db.commit()
    duplicate = _deck_or_404(db, duplicate.id, current_user.id, with_entries=True)
    owned = _owned_quantities(db, current_user.id, [entry.card_id for entry in duplicate.entries])
    return _deck_response(duplicate, owned, _standard_legal_fingerprints(db, _deck_fingerprints(duplicate)))


@router.post("/{deck_id}/convert-to-real", response_model=DeckResponse)
def convert_deck_to_real(
    deck_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Atomically turn a plan into a Real Deck and reserve every owned copy."""
    lock_user_card_allocations(db, current_user.id)
    deck = _locked_deck_or_404(db, deck_id, current_user.id)
    if deck.binder_type == PHYSICAL_DECK_TYPE:
        return get_deck(deck_id, current_user, db)

    # Old previews allowed optional allocations on planned decks. Drop those
    # rows first so conversion always recomputes availability from one source
    # of truth and can safely roll back as a unit.
    db.query(BinderCard).filter(
        BinderCard.binder_id == deck.id,
        BinderCard.collection_item_id.isnot(None),
    ).delete(synchronize_session=False)
    db.flush()

    entries = db.query(BinderCard).filter(
        BinderCard.binder_id == deck.id,
        BinderCard.collection_item_id.is_(None),
    ).order_by(BinderCard.id.asc()).with_for_update(of=BinderCard).all()
    card_ids = sorted({entry.card_id for entry in entries})
    if card_ids:
        # Lock every candidate owned row in one canonical order before
        # allocating individual entries. This keeps the ordering deterministic
        # even if two Decks list the same cards in opposite orders.
        db.query(CollectionItem).filter(
            CollectionItem.user_id == current_user.id,
            CollectionItem.card_id.in_(card_ids),
            CollectionItem.quantity > 0,
        ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all()
    for entry in entries:
        allocated = _set_entry_allocations(db, deck, entry, entry.required_quantity, current_user.id)
        if allocated < int(entry.required_quantity or 0):
            db.rollback()
            raise HTTPException(
                status_code=409,
                detail="Every required card must be owned and unassigned before this can become a real deck",
            )

    deck.binder_type = PHYSICAL_DECK_TYPE
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.post("/{deck_id}/convert-to-planned", response_model=DeckResponse)
def convert_deck_to_planned(
    deck_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Turn a Real Deck back into a plan and release its physical copies."""
    lock_user_card_allocations(db, current_user.id)
    deck = _locked_deck_or_404(db, deck_id, current_user.id)
    if deck.binder_type == "deck":
        return get_deck(deck_id, current_user, db)
    db.query(BinderCard).filter(
        BinderCard.binder_id == deck.id,
        BinderCard.collection_item_id.isnot(None),
    ).delete(synchronize_session=False)
    deck.binder_type = "deck"
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.get("/{deck_id}", response_model=DeckResponse)
def get_deck(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    allocating_lists = _allocating_lists(db, current_user.id)
    card_ids = [entry.card_id for card_list in allocating_lists for entry in card_list.binder_cards]
    card_ids.extend(entry.card_id for entry in deck.entries)
    owned = _owned_quantities(db, current_user.id, card_ids)
    allocation = allocation_for_decks(allocating_lists, owned, deck.id)
    rows = db.query(CollectionItem).filter(
        CollectionItem.user_id == current_user.id,
        CollectionItem.card_id.in_([entry.card_id for entry in deck.entries]),
    ).all() if deck.entries else []
    return _deck_response(
        deck,
        owned,
        _standard_legal_fingerprints(db, _deck_fingerprints(deck)),
        allocation,
        representative_display_variants(rows),
    )


@router.get("/{deck_id}/probability")
def get_deck_probability(
    deck_id: int,
    hand: int = Query(7, ge=0, le=250),
    draws: int = Query(0, ge=0, le=250),
    card_name: str | None = Query(None, max_length=255),
    prize_count: int = Query(6, ge=0, le=250),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    return analyze_deck_probability(deck, hand, draws, card_name, prize_count)


def _set_entry_allocations(
    db: Session,
    deck: Binder,
    entry: BinderCard,
    target: int,
    user_id: int,
) -> int:
    """Set exact owned-copy use for one physical Deck entry."""
    target = min(max(int(target), 0), int(entry.required_quantity or 0))
    owned_items = db.query(CollectionItem).filter(
        CollectionItem.user_id == user_id,
        CollectionItem.card_id == entry.card_id,
        CollectionItem.quantity > 0,
    ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all()
    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == deck.id,
        BinderCard.card_id == entry.card_id,
        BinderCard.collection_item_id.isnot(None),
    ).order_by(BinderCard.id.asc()).with_for_update(of=BinderCard).all()
    current = sum(int(item.required_quantity or 0) for item in existing)

    if target > current:
        remaining = target - current
        usage = collection_binder_allocation_counts(db, user_id, [item.id for item in owned_items])
        existing_by_item = {item.collection_item_id: item for item in existing}
        for item in owned_items:
            available = max(int(item.quantity or 0) - int(usage.get(item.id, 0)), 0)
            assigned = min(remaining, available)
            if assigned <= 0:
                continue
            row = existing_by_item.get(item.id)
            if row:
                row.required_quantity = int(row.required_quantity or 0) + assigned
            else:
                row = BinderCard(
                    binder_id=deck.id,
                    card_id=item.card_id,
                    collection_item_id=item.id,
                    required_quantity=assigned,
                    added_at=datetime.datetime.utcnow(),
                )
                db.add(row)
                existing_by_item[item.id] = row
            remaining -= assigned
            if remaining == 0:
                break
        current = target - remaining
    elif target < current:
        remaining = current - target
        for item in reversed(existing):
            quantity = int(item.required_quantity or 0)
            removed = min(remaining, quantity)
            next_quantity = quantity - removed
            if next_quantity:
                item.required_quantity = next_quantity
            else:
                db.delete(item)
            remaining -= removed
            if remaining == 0:
                break
        current = target
    return current


@router.patch("/{deck_id}", response_model=DeckResponse)
def update_deck(
    deck_id: int,
    payload: DeckUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deck = _locked_deck_or_404(db, deck_id, current_user.id)
    if payload.name is not None:
        deck.name = normalize_card_list_name(payload.name)
    if payload.target_size is not None:
        deck.target_size = payload.target_size
    fields_set = payload.model_fields_set if hasattr(payload, "model_fields_set") else payload.__fields_set__
    if "description" in fields_set:
        deck.description = payload.description
    if "format" in fields_set:
        deck.format = payload.format
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.delete("/{deck_id}")
def delete_deck(
    deck_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lock_user_card_allocations(db, current_user.id)
    deck = _locked_deck_or_404(db, deck_id, current_user.id)
    db.delete(deck)
    db.commit()
    return {"message": "Deck deleted"}


@router.post("/{deck_id}/entries", response_model=DeckResponse)
def add_deck_entry(
    deck_id: int,
    payload: DeckEntryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lock_user_card_allocations(db, current_user.id)
    deck = _locked_deck_or_404(db, deck_id, current_user.id)
    entry = db.query(BinderCard).filter(
        BinderCard.binder_id == deck.id,
        BinderCard.card_id == payload.card_id,
        BinderCard.collection_item_id.is_(None),
    ).first()
    if entry:
        entry.required_quantity = min(int(entry.required_quantity or 0) + payload.required_quantity, 99)
    else:
        card = db.query(Card).filter(Card.id == payload.card_id).first()
        if not card or (card.is_custom and card.custom_owner_id != current_user.id):
            raise HTTPException(status_code=404, detail="Card not found")
        entry = BinderCard(
            binder_id=deck.id,
            card_id=card.id,
            required_quantity=min(payload.required_quantity, 99),
            added_at=datetime.datetime.utcnow(),
        )
        db.add(entry)
        db.flush()
    if deck.binder_type == PHYSICAL_DECK_TYPE:
        allocated = _set_entry_allocations(db, deck, entry, entry.required_quantity, current_user.id)
        if allocated < int(entry.required_quantity or 0):
            db.rollback()
            raise HTTPException(status_code=409, detail="Not enough unassigned owned copies are available for this real deck")
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.patch("/{deck_id}/entries/{entry_id}", response_model=DeckResponse)
def update_deck_entry(
    deck_id: int,
    entry_id: int,
    payload: DeckEntryUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lock_user_card_allocations(db, current_user.id)
    deck = _locked_deck_or_404(db, deck_id, current_user.id)
    entry = db.query(BinderCard).filter(
        BinderCard.id == entry_id,
        BinderCard.binder_id == deck.id,
        BinderCard.collection_item_id.is_(None),
    ).with_for_update(of=BinderCard).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Deck entry not found")
    entry.required_quantity = min(payload.required_quantity, 99)
    if deck.binder_type == PHYSICAL_DECK_TYPE:
        allocated = _set_entry_allocations(db, deck, entry, entry.required_quantity, current_user.id)
        if allocated < int(entry.required_quantity or 0):
            db.rollback()
            raise HTTPException(status_code=409, detail="Not enough unassigned owned copies are available for this real deck")
        deck.updated_at = datetime.datetime.utcnow()
        db.commit()
        return get_deck(deck_id, current_user, db)
    allocations = db.query(BinderCard).filter(
        BinderCard.binder_id == deck.id,
        BinderCard.card_id == entry.card_id,
        BinderCard.collection_item_id.isnot(None),
    ).order_by(BinderCard.id.asc()).with_for_update(of=BinderCard).all()
    allocated = sum(int(item.required_quantity or 0) for item in allocations)
    if allocated > entry.required_quantity:
        remaining = allocated - entry.required_quantity
        for item in reversed(allocations):
            quantity = int(item.required_quantity or 0)
            removed = min(remaining, quantity)
            if quantity == removed:
                db.delete(item)
            else:
                item.required_quantity = quantity - removed
            remaining -= removed
            if remaining == 0:
                break
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.delete("/{deck_id}/entries/{entry_id}", response_model=DeckResponse)
def delete_deck_entry(
    deck_id: int,
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    lock_user_card_allocations(db, current_user.id)
    deck = _locked_deck_or_404(db, deck_id, current_user.id)
    entry = db.query(BinderCard).filter(
        BinderCard.id == entry_id,
        BinderCard.binder_id == deck.id,
        BinderCard.collection_item_id.is_(None),
    ).with_for_update(of=BinderCard).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Deck entry not found")
    allocations = db.query(BinderCard).filter(
        BinderCard.binder_id == deck.id,
        BinderCard.card_id == entry.card_id,
        BinderCard.collection_item_id.isnot(None),
    ).order_by(BinderCard.id.asc()).with_for_update(of=BinderCard).all()
    for allocation in allocations:
        db.delete(allocation)
    db.delete(entry)
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)
