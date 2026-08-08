import datetime
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from api.collection import ensure_card_exists
from database import get_db
from models import Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, Trade, TradeItem, User
from schemas import TradeCreate, TradeResponse, TradeUpdate, TradeValuationRequest
from services import pokemon_api
from services.card_values import effective_market_price, normalize_price_field
from services.binder_allocations import (
    collection_binder_allocation_counts,
    collection_item_allocated_quantity,
)
from services.collection_csv import normalize_collection_variant
from services.product_ledger import finite_non_negative, positive_quantity
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language

router = APIRouter()
logger = logging.getLogger(__name__)

TRADE_QUANTITY_MAX = 999
ALLOWED_CONDITIONS = {"Mint", "NM", "LP", "MP", "HP"}


def _validate_money(value, field_name: str) -> None:
    if value is None:
        return
    if not finite_non_negative(value):
        raise HTTPException(status_code=422, detail=f"{field_name} must be a finite, non-negative number")


def _normalize_lang(lang: str | None) -> str:
    normalized = normalize_tcgdex_language(lang or "en")
    if not is_supported_tcgdex_language(normalized):
        raise HTTPException(status_code=422, detail="lang is not supported")
    return normalized


def _card_snapshot(card: Card | None) -> dict:
    return {
        "card_name": card.name if card else None,
        "set_id": card.set_id if card else None,
        "card_number": card.number if card else None,
    }


def _snapshot_price(card: Card | None, variant: str | None, override, price_field: str) -> float:
    _validate_money(override, "value_per_card")
    if override is not None:
        return round(float(override), 2)
    return round(float(effective_market_price(card, variant, price_field) or 0), 2)


def _cash_amount(value) -> float:
    _validate_money(value, "cash")
    return round(float(value or 0), 2)


def _trade_response(trade: Trade) -> TradeResponse:
    items = sorted(trade.items or [], key=lambda item: item.id or 0)
    trade.items = items
    return TradeResponse.model_validate(trade)


def _resolve_incoming_card(db: Session, card_id: str, lang: str) -> Card:
    if not card_id or not str(card_id).strip():
        raise HTTPException(status_code=422, detail="card_id is required")

    card_id = str(card_id).strip()
    if card_id.startswith("custom-"):
        card = db.query(Card).filter(Card.id == card_id).first()
        if not card:
            raise HTTPException(status_code=404, detail="Incoming custom card not found")
        return card

    tcg_card_id, detected_lang = pokemon_api.strip_lang_suffix(card_id)
    effective_lang = _normalize_lang(detected_lang or lang)
    effective_card_id = f"{tcg_card_id}_{effective_lang}"
    return ensure_card_exists(db, effective_card_id, lang=effective_lang)


def _prepare_incoming_card(db: Session, incoming, price_field: str) -> dict:
    if not positive_quantity(incoming.quantity, TRADE_QUANTITY_MAX):
        raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")
    condition = incoming.condition or "NM"
    if condition not in ALLOWED_CONDITIONS:
        raise HTTPException(status_code=422, detail="condition is not supported")
    variant = normalize_collection_variant(incoming.variant)
    lang = _normalize_lang(incoming.lang)
    purchase_price_override = getattr(incoming, "purchase_price", None)
    if purchase_price_override is not None:
        _validate_money(purchase_price_override, "purchase_price")
    card = _resolve_incoming_card(db, incoming.card_id, lang)
    item_lang = card.lang or lang
    value_override = getattr(incoming, "value_per_card", None)
    value_per_card = _snapshot_price(card, variant, value_override, price_field)
    purchase_price = purchase_price_override
    if not hasattr(incoming, "purchase_price"):
        purchase_price = value_per_card
    return {
        "card": card,
        "condition": condition,
        "variant": variant,
        "lang": item_lang,
        "value_per_card": value_per_card,
        "purchase_price": purchase_price,
    }


def _merge_or_create_collection_item(
    db: Session,
    current_user: User,
    card: Card,
    quantity: int,
    condition: str,
    variant: str,
    lang: str,
    purchase_price,
) -> CollectionItem:
    existing = db.query(CollectionItem).filter(
        CollectionItem.card_id == card.id,
        CollectionItem.variant == variant,
        CollectionItem.lang == lang,
        CollectionItem.condition == condition,
        CollectionItem.purchase_price == purchase_price,
        CollectionItem.user_id == current_user.id,
    ).first()

    if existing:
        existing.quantity += quantity
        return existing

    item = CollectionItem(
        card_id=card.id,
        user_id=current_user.id,
        quantity=quantity,
        condition=condition,
        variant=variant,
        purchase_price=purchase_price,
        lang=lang,
        added_at=datetime.datetime.utcnow(),
    )
    db.add(item)
    db.flush()
    return item


def _record_linked_trade_out(
    db: Session,
    current_user: User,
    collection_item: CollectionItem,
    quantity: int,
    value_per_card: float,
    trade_date: datetime.date,
    trade_item: TradeItem,
) -> None:
    remaining = quantity
    rows = db.query(ProductCard, ProductPurchase).join(
        ProductPurchase,
        ProductPurchase.id == ProductCard.product_id,
    ).filter(
        ProductCard.user_id == current_user.id,
        ProductPurchase.user_id == current_user.id,
        ProductCard.collection_item_id == collection_item.id,
        ProductCard.active_quantity > 0,
    ).order_by(ProductCard.linked_at.asc(), ProductCard.id.asc()).with_for_update(of=ProductCard).all()

    for product_card, product in rows:
        if remaining <= 0:
            break
        allocated = min(remaining, int(product_card.active_quantity or 0))
        if allocated <= 0:
            continue

        product_card.active_quantity -= allocated
        product_card.sold_quantity += allocated
        if trade_item.product_card_id is None:
            trade_item.product_card_id = product_card.id

        db.add(ProductLedgerEntry(
            product_card_id=product_card.id,
            product_id=product.id,
            user_id=current_user.id,
            entry_type="trade_out",
            card_id=collection_item.card_id,
            original_collection_item_id=collection_item.id,
            trade_item_id=trade_item.id,
            quantity=allocated,
            amount=round(value_per_card * allocated, 2),
            event_date=trade_date,
            product_name=product.product_name,
            card_name=collection_item.card.name if collection_item.card else None,
            set_id=collection_item.card.set_id if collection_item.card else None,
            card_number=collection_item.card.number if collection_item.card else None,
            variant=collection_item.variant,
            condition=collection_item.condition,
            lang=collection_item.lang,
            notes=trade_item.notes,
            created_at=datetime.datetime.utcnow(),
        ))
        remaining -= allocated


def _is_cash_item(item: TradeItem) -> bool:
    if item.card_id is not None:
        return False
    if (item.card_name or "").lower() != "cash":
        return False
    strict_marker = (
        (item.set_id or "").lower() == "cash"
        and (item.card_number or "").lower() == "cash"
    )
    legacy_note = (item.notes or "").lower() in {
        "cash added to trade",
        "cash received in trade",
    }
    return strict_marker or legacy_note


def _same_purchase_price(left, right) -> bool:
    if left is None or right is None:
        return left is None and right is None
    return float(left) == float(right)


def _same_inventory_identity(
    collection_item: CollectionItem,
    *,
    card_id: str | None,
    variant: str | None,
    condition: str | None,
    lang: str | None,
    purchase_price,
) -> bool:
    return (
        collection_item.card_id == card_id
        and collection_item.variant == (variant or "Normal")
        and collection_item.condition == (condition or "NM")
        and collection_item.lang == (lang or "en")
        and _same_purchase_price(collection_item.purchase_price, purchase_price)
    )


def _legacy_snapshot_purchase_price(
    trade_item: TradeItem,
    collection_items: list[CollectionItem],
) -> float | None:
    """Recover a legacy cost basis only from the exact historical row.

    A missing return value is ambiguous because ``None`` is also a valid cost
    basis, so callers must use ``snapshot_version`` to decide whether a
    destructive legacy edit is safe.
    """
    historical_id = (
        trade_item.original_collection_item_id
        if trade_item.direction == "outgoing"
        else trade_item.created_collection_item_id
    )
    for item in collection_items:
        if item.id != historical_id:
            continue
        if (
            item.card_id == trade_item.card_id
            and item.variant == (trade_item.variant or "Normal")
            and item.condition == (trade_item.condition or "NM")
            and item.lang == (trade_item.lang or "en")
        ):
            return item.purchase_price
    raise HTTPException(
        status_code=409,
        detail=f"{trade_item.card_name or trade_item.card_id or 'This card'} is from an older trade without enough inventory history to change safely. Other trade details can still be edited.",
    )


def _trade_item_purchase_price(
    trade_item: TradeItem,
    collection_items: list[CollectionItem],
):
    if int(trade_item.snapshot_version or 0) >= 1:
        return trade_item.purchase_price
    return _legacy_snapshot_purchase_price(trade_item, collection_items)


def _matching_collection_items(
    collection_items: list[CollectionItem],
    *,
    card_id: str | None,
    variant: str | None,
    condition: str | None,
    lang: str | None,
    purchase_price,
) -> list[CollectionItem]:
    return [
        item for item in collection_items
        if _same_inventory_identity(
            item,
            card_id=card_id,
            variant=variant,
            condition=condition,
            lang=lang,
            purchase_price=purchase_price,
        )
    ]


def _merge_locked_collection_item(
    db: Session,
    current_user: User,
    collection_items: list[CollectionItem],
    *,
    card: Card,
    quantity: int,
    condition: str,
    variant: str,
    lang: str,
    purchase_price,
) -> CollectionItem:
    matches = _matching_collection_items(
        collection_items,
        card_id=card.id,
        variant=variant,
        condition=condition,
        lang=lang,
        purchase_price=purchase_price,
    )
    if matches:
        matches[0].quantity = int(matches[0].quantity or 0) + quantity
        return matches[0]

    item = CollectionItem(
        card_id=card.id,
        user_id=current_user.id,
        quantity=quantity,
        condition=condition,
        variant=variant,
        purchase_price=purchase_price,
        lang=lang,
        added_at=datetime.datetime.utcnow(),
    )
    item.card = card
    db.add(item)
    db.flush()
    collection_items.append(item)
    return item


def _product_active_quantities(product_cards: list[ProductCard]) -> dict[int, int]:
    result: dict[int, int] = {}
    for product_card in product_cards:
        if product_card.collection_item_id is None:
            continue
        result[product_card.collection_item_id] = (
            result.get(product_card.collection_item_id, 0)
            + int(product_card.active_quantity or 0)
        )
    return result


def _remove_matching_collection_quantity(
    db: Session,
    current_user: User,
    collection_items: list[CollectionItem],
    product_cards: list[ProductCard],
    *,
    card_id: str | None,
    variant: str | None,
    condition: str | None,
    lang: str | None,
    purchase_price,
    quantity: int,
    protect_product_links: bool,
    preferred_item_id: int | None = None,
) -> list[tuple[CollectionItem, int]]:
    matches = _matching_collection_items(
        collection_items,
        card_id=card_id,
        variant=variant,
        condition=condition,
        lang=lang,
        purchase_price=purchase_price,
    )
    matches.sort(key=lambda item: (item.id != preferred_item_id, item.id or 0))
    product_active = _product_active_quantities(product_cards)
    binder_quantities = collection_binder_allocation_counts(
        db,
        current_user.id,
        [item.id for item in matches],
    )
    capacities: list[tuple[CollectionItem, int]] = []
    for item in matches:
        binder_quantity = binder_quantities.get(item.id, 0)
        protected = binder_quantity
        if protect_product_links:
            protected = max(protected, product_active.get(item.id, 0))
        capacities.append((item, max(int(item.quantity or 0) - protected, 0)))

    available = sum(capacity for _, capacity in capacities)
    if available < quantity:
        name = next((item.card.name for item, _ in capacities if item.card), card_id or "card")
        raise HTTPException(
            status_code=409,
            detail=f"Only {available} unallocated copies of {name} are available; {quantity} are required for this edit.",
        )

    remaining = quantity
    consumed: list[tuple[CollectionItem, int]] = []
    for item, capacity in capacities:
        if remaining <= 0:
            break
        amount = min(remaining, capacity)
        if amount <= 0:
            continue
        item.quantity = int(item.quantity or 0) - amount
        consumed.append((item, amount))
        remaining -= amount
    return consumed


def _reverse_product_trade_out(
    db: Session,
    trade_item: TradeItem,
    product_cards: list[ProductCard],
    reduction: int,
) -> list[ProductCard]:
    linked_entries = db.query(ProductLedgerEntry).filter(
        ProductLedgerEntry.trade_item_id == trade_item.id,
        ProductLedgerEntry.entry_type == "trade_out",
    ).order_by(ProductLedgerEntry.id.desc()).with_for_update(of=ProductLedgerEntry).all()
    linked_quantity = sum(int(entry.quantity or 0) for entry in linked_entries)

    if int(trade_item.snapshot_version or 0) < 1 and trade_item.product_card_id is not None:
        raise HTTPException(
            status_code=409,
            detail=f"{trade_item.card_name or trade_item.card_id or 'This card'} has legacy product history that cannot be reversed safely.",
        )
    if int(trade_item.snapshot_version or 0) >= 1 and trade_item.product_card_id is not None and not linked_entries:
        raise HTTPException(
            status_code=409,
            detail=f"The product history for {trade_item.card_name or trade_item.card_id or 'this card'} is no longer available, so this quantity cannot be reduced safely.",
        )

    unlinked_quantity = max(int(trade_item.quantity or 0) - linked_quantity, 0)
    linked_to_reverse = max(reduction - unlinked_quantity, 0)
    if linked_to_reverse <= 0:
        return []
    if linked_quantity < linked_to_reverse:
        raise HTTPException(status_code=409, detail="Product trade history is incomplete for this card")

    product_by_id = {row.id: row for row in product_cards}
    remaining = linked_to_reverse
    restored_product_cards: list[ProductCard] = []
    for entry in linked_entries:
        if remaining <= 0:
            break
        product_card = product_by_id.get(entry.product_card_id)
        if not product_card:
            raise HTTPException(status_code=409, detail="A linked product card no longer exists for this trade")
        entry_quantity = int(entry.quantity or 0)
        amount = min(remaining, entry_quantity)
        if int(product_card.sold_quantity or 0) < amount:
            raise HTTPException(status_code=409, detail="Product quantities changed and cannot be reconciled safely")
        if int(product_card.active_quantity or 0) + amount > int(product_card.initial_quantity or 0):
            raise HTTPException(status_code=409, detail="Product quantities changed and cannot be reconciled safely")

        original_amount = float(entry.amount or 0)
        product_card.sold_quantity -= amount
        product_card.active_quantity += amount
        if product_card not in restored_product_cards:
            restored_product_cards.append(product_card)
        remaining -= amount
        if amount == entry_quantity:
            db.delete(entry)
        else:
            remaining_quantity = entry_quantity - amount
            entry.quantity = remaining_quantity
            entry.amount = round(original_amount * remaining_quantity / entry_quantity, 2)

    db.flush()
    remaining_entry = db.query(ProductLedgerEntry).filter(
        ProductLedgerEntry.trade_item_id == trade_item.id,
        ProductLedgerEntry.entry_type == "trade_out",
    ).order_by(ProductLedgerEntry.id.asc()).first()
    trade_item.product_card_id = remaining_entry.product_card_id if remaining_entry else None
    return restored_product_cards


def _update_linked_ledger_snapshots(db: Session, trade: Trade, trade_item: TradeItem) -> None:
    db.query(ProductLedgerEntry).filter(
        ProductLedgerEntry.trade_item_id == trade_item.id,
        ProductLedgerEntry.entry_type == "trade_out",
    ).update({
        ProductLedgerEntry.event_date: trade.trade_date,
        ProductLedgerEntry.card_name: trade_item.card_name,
        ProductLedgerEntry.set_id: trade_item.set_id,
        ProductLedgerEntry.card_number: trade_item.card_number,
        ProductLedgerEntry.variant: trade_item.variant,
        ProductLedgerEntry.condition: trade_item.condition,
        ProductLedgerEntry.lang: trade_item.lang,
        ProductLedgerEntry.notes: trade_item.notes,
    }, synchronize_session=False)


def _recalculate_trade_totals(db: Session, trade: Trade) -> None:
    db.flush()
    items = db.query(TradeItem).filter(TradeItem.trade_id == trade.id).all()
    outgoing_total = sum(float(item.value_total or 0) for item in items if item.direction == "outgoing")
    incoming_total = sum(float(item.value_total or 0) for item in items if item.direction == "incoming")
    trade.outgoing_value = round(outgoing_total, 2)
    trade.incoming_value = round(incoming_total, 2)
    trade.value_delta = round(incoming_total - outgoing_total, 2)


def _set_cash_item(
    db: Session,
    trade: Trade,
    current_user: User,
    existing_items: list[TradeItem],
    direction: str,
    amount: float,
) -> None:
    cash_items = [item for item in existing_items if item.direction == direction and _is_cash_item(item)]
    if amount <= 0:
        for item in cash_items:
            db.delete(item)
        return

    item = cash_items.pop(0) if cash_items else TradeItem(
        trade_id=trade.id,
        user_id=current_user.id,
        direction=direction,
        card_id=None,
        quantity=1,
        card_name="Cash",
        set_id="cash",
        card_number="cash",
        created_at=datetime.datetime.utcnow(),
        snapshot_version=1,
    )
    item.value_per_card = amount
    item.value_total = amount
    item.notes = "Cash added to trade" if direction == "outgoing" else "Cash received in trade"
    db.add(item)
    for duplicate in cash_items:
        db.delete(duplicate)


@router.get("/", response_model=List[TradeResponse])
def get_trades(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    trades = db.query(Trade).options(
        joinedload(Trade.items).joinedload(TradeItem.card).joinedload(Card.set_ref),
    ).filter(
        Trade.user_id == current_user.id,
    ).order_by(
        Trade.trade_date.desc(),
        Trade.id.desc(),
    ).all()
    return [_trade_response(trade) for trade in trades]


@router.get("/{trade_id}", response_model=TradeResponse)
def get_trade(
    trade_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    trade = db.query(Trade).options(
        joinedload(Trade.items).joinedload(TradeItem.card).joinedload(Card.set_ref),
    ).filter(
        Trade.id == trade_id,
        Trade.user_id == current_user.id,
    ).first()
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")
    return _trade_response(trade)


@router.post("/value")
def value_trade(
    request: TradeValuationRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend"),
):
    price_field = normalize_price_field(price_field)

    def value_items(items):
        total = 0.0
        valued = []
        for item in items:
            quantity = int(item.quantity or 1)
            card = db.query(Card).filter(Card.id == item.card_id).first()
            value_per_card = _snapshot_price(card, item.variant, None, price_field)
            value_total = round(value_per_card * quantity, 2)
            total += value_total
            valued.append({
                "card_id": item.card_id,
                "quantity": quantity,
                "variant": item.variant,
                "value_per_card": value_per_card,
                "value_total": value_total,
                "missing_price": value_per_card <= 0,
            })
        return round(total, 2), valued

    outgoing_value, outgoing = value_items(request.outgoing)
    incoming_value, incoming = value_items(request.incoming)
    return {
        "outgoing_value": outgoing_value,
        "incoming_value": incoming_value,
        "value_delta": round(incoming_value - outgoing_value, 2),
        "outgoing": outgoing,
        "incoming": incoming,
    }


@router.post("/", response_model=TradeResponse)
def create_trade(
    trade: TradeCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend"),
):
    price_field = normalize_price_field(price_field)
    outgoing_cash = _cash_amount(trade.outgoing_cash)
    incoming_cash = _cash_amount(trade.incoming_cash)
    if not trade.outgoing and not trade.incoming and outgoing_cash <= 0 and incoming_cash <= 0:
        raise HTTPException(status_code=422, detail="Trade must include at least one item")

    # Cache/resolve remote cards before inventory locks are acquired because
    # ensure_card_exists may commit its standalone card-cache write.
    prepared_incoming = [
        _prepare_incoming_card(db, incoming, price_field)
        for incoming in trade.incoming
    ]
    db.query(User).filter(User.id == current_user.id).with_for_update(of=User).one()

    db_trade = Trade(
        user_id=current_user.id,
        partner_name=(trade.partner_name or "").strip() or None,
        trade_date=trade.trade_date,
        notes=trade.notes,
        outgoing_value=0,
        incoming_value=0,
        value_delta=0,
        created_at=datetime.datetime.utcnow(),
    )
    db.add(db_trade)
    db.flush()

    outgoing_total = 0.0
    incoming_total = 0.0

    try:
        if outgoing_cash > 0:
            outgoing_total += outgoing_cash
            db.add(TradeItem(
                trade_id=db_trade.id,
                user_id=current_user.id,
                direction="outgoing",
                card_id=None,
                quantity=1,
                value_per_card=outgoing_cash,
                value_total=outgoing_cash,
                card_name="Cash",
                set_id="cash",
                card_number="cash",
                notes="Cash added to trade",
                created_at=datetime.datetime.utcnow(),
                snapshot_version=1,
            ))

        for outgoing in trade.outgoing:
            if not positive_quantity(outgoing.quantity, TRADE_QUANTITY_MAX):
                raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")

            collection_item = db.query(CollectionItem).options(
                joinedload(CollectionItem.card),
            ).filter(
                CollectionItem.id == outgoing.collection_item_id,
                CollectionItem.user_id == current_user.id,
            ).with_for_update(of=CollectionItem).first()
            if not collection_item:
                raise HTTPException(status_code=404, detail="Outgoing collection item not found")
            if int(collection_item.quantity or 0) < outgoing.quantity:
                raise HTTPException(status_code=409, detail="Cannot trade more copies than are in your collection")
            remaining_quantity = int(collection_item.quantity or 0) - outgoing.quantity
            allocated_quantity = collection_item_allocated_quantity(db, current_user.id, collection_item.id)
            if remaining_quantity < allocated_quantity:
                raise HTTPException(
                    status_code=409,
                    detail=f"This trade would leave fewer copies than the {allocated_quantity} assigned to binders. Reduce binder quantities first.",
                )

            value_per_card = _snapshot_price(collection_item.card, collection_item.variant, outgoing.value_per_card, price_field)
            value_total = round(value_per_card * outgoing.quantity, 2)
            outgoing_total += value_total

            trade_item = TradeItem(
                trade_id=db_trade.id,
                user_id=current_user.id,
                direction="outgoing",
                card_id=collection_item.card_id,
                original_collection_item_id=collection_item.id,
                quantity=outgoing.quantity,
                value_per_card=value_per_card,
                value_total=value_total,
                variant=collection_item.variant,
                condition=collection_item.condition,
                lang=collection_item.lang,
                notes=outgoing.notes,
                created_at=datetime.datetime.utcnow(),
                purchase_price=collection_item.purchase_price,
                snapshot_version=1,
                **_card_snapshot(collection_item.card),
            )
            db.add(trade_item)
            db.flush()

            _record_linked_trade_out(
                db,
                current_user,
                collection_item,
                outgoing.quantity,
                value_per_card,
                trade.trade_date,
                trade_item,
            )

            if remaining_quantity > 0:
                collection_item.quantity = remaining_quantity
            else:
                db.delete(collection_item)

        if incoming_cash > 0:
            incoming_total += incoming_cash
            db.add(TradeItem(
                trade_id=db_trade.id,
                user_id=current_user.id,
                direction="incoming",
                card_id=None,
                quantity=1,
                value_per_card=incoming_cash,
                value_total=incoming_cash,
                card_name="Cash",
                set_id="cash",
                card_number="cash",
                notes="Cash received in trade",
                created_at=datetime.datetime.utcnow(),
                snapshot_version=1,
            ))

        for incoming, prepared in zip(trade.incoming, prepared_incoming):
            card = prepared["card"]
            condition = prepared["condition"]
            variant = prepared["variant"]
            item_lang = prepared["lang"]
            value_per_card = prepared["value_per_card"]
            purchase_price = prepared["purchase_price"]
            value_total = round(value_per_card * incoming.quantity, 2)
            incoming_total += value_total
            collection_item = _merge_or_create_collection_item(
                db,
                current_user,
                card,
                incoming.quantity,
                condition,
                variant,
                item_lang,
                purchase_price,
            )

            db.add(TradeItem(
                trade_id=db_trade.id,
                user_id=current_user.id,
                direction="incoming",
                card_id=card.id,
                created_collection_item_id=collection_item.id,
                quantity=incoming.quantity,
                value_per_card=value_per_card,
                value_total=value_total,
                variant=variant,
                condition=condition,
                lang=item_lang,
                notes=incoming.notes,
                created_at=datetime.datetime.utcnow(),
                purchase_price=purchase_price,
                snapshot_version=1,
                **_card_snapshot(card),
            ))

        db_trade.outgoing_value = round(outgoing_total, 2)
        db_trade.incoming_value = round(incoming_total, 2)
        db_trade.value_delta = round(incoming_total - outgoing_total, 2)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        logger.exception("Failed to create trade")
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to create trade") from exc

    db.refresh(db_trade)
    db_trade = db.query(Trade).options(
        joinedload(Trade.items).joinedload(TradeItem.card).joinedload(Card.set_ref),
    ).filter(Trade.id == db_trade.id).one()
    return _trade_response(db_trade)


@router.put("/{trade_id}", response_model=TradeResponse)
def update_trade(
    trade_id: int,
    update: TradeUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend"),
):
    """Atomically reconcile an edited trade with inventory and product history."""
    price_field = normalize_price_field(price_field)
    outgoing_cash = _cash_amount(update.outgoing_cash)
    incoming_cash = _cash_amount(update.incoming_cash)
    if not update.outgoing and not update.incoming and outgoing_cash <= 0 and incoming_cash <= 0:
        raise HTTPException(status_code=422, detail="Trade must include at least one item")
    if not db.query(Trade.id).filter(
        Trade.id == trade_id,
        Trade.user_id == current_user.id,
    ).first():
        raise HTTPException(status_code=404, detail="Trade not found")

    outgoing_existing_ids: set[int] = set()
    outgoing_collection_ids: set[int] = set()
    for item in update.outgoing:
        if (item.trade_item_id is None) == (item.collection_item_id is None):
            raise HTTPException(status_code=422, detail="Each outgoing card must reference either a trade item or a collection item")
        target = outgoing_existing_ids if item.trade_item_id is not None else outgoing_collection_ids
        identifier = item.trade_item_id if item.trade_item_id is not None else item.collection_item_id
        if identifier in target:
            raise HTTPException(status_code=422, detail="The same outgoing card row cannot be included twice")
        target.add(identifier)

    incoming_existing_ids: set[int] = set()
    prepared_new_incoming: dict[int, dict] = {}
    for index, item in enumerate(update.incoming):
        if (item.trade_item_id is None) == (item.card_id is None):
            raise HTTPException(status_code=422, detail="Each incoming card must reference either a trade item or a card")
        if item.trade_item_id is not None:
            if item.trade_item_id in incoming_existing_ids:
                raise HTTPException(status_code=422, detail="The same incoming trade item cannot be included twice")
            incoming_existing_ids.add(item.trade_item_id)
        else:
            prepared_new_incoming[index] = _prepare_incoming_card(db, item, price_field)

    try:
        # All inventory writers introduced here use this order:
        # User -> Trade -> CollectionItem -> ProductCard -> ledger rows.
        db.query(User).filter(User.id == current_user.id).with_for_update(of=User).one()
        db_trade = db.query(Trade).filter(
            Trade.id == trade_id,
            Trade.user_id == current_user.id,
        ).with_for_update(of=Trade).first()
        if not db_trade:
            raise HTTPException(status_code=404, detail="Trade not found")

        existing_items = db.query(TradeItem).options(joinedload(TradeItem.card)).filter(
            TradeItem.trade_id == db_trade.id,
            TradeItem.user_id == current_user.id,
        ).order_by(TradeItem.id.asc()).all()
        existing_non_cash = {item.id: item for item in existing_items if not _is_cash_item(item)}

        if update.trade_date != db_trade.trade_date and any(
            item.direction == "outgoing"
            and int(item.snapshot_version or 0) < 1
            and item.product_card_id is not None
            for item in existing_non_cash.values()
        ):
            raise HTTPException(
                status_code=409,
                detail="This older trade has product history that cannot be safely moved to another date. Other trade details can still be edited.",
            )

        requested_existing_ids = outgoing_existing_ids | incoming_existing_ids
        unknown_ids = requested_existing_ids - set(existing_non_cash)
        if unknown_ids:
            raise HTTPException(status_code=422, detail="One or more edited trade items do not belong to this trade")
        for item_id in outgoing_existing_ids:
            if existing_non_cash[item_id].direction != "outgoing":
                raise HTTPException(status_code=422, detail="An incoming card cannot be submitted as outgoing")
        for item_id in incoming_existing_ids:
            if existing_non_cash[item_id].direction != "incoming":
                raise HTTPException(status_code=422, detail="An outgoing card cannot be submitted as incoming")

        referenced_rows = []
        if outgoing_collection_ids:
            referenced_rows = db.query(CollectionItem).filter(
                CollectionItem.id.in_(outgoing_collection_ids),
                CollectionItem.user_id == current_user.id,
            ).all()
            if {row.id for row in referenced_rows} != outgoing_collection_ids:
                raise HTTPException(status_code=404, detail="One or more outgoing collection items were not found")

        affected_card_ids = {item.card_id for item in existing_non_cash.values() if item.card_id}
        affected_card_ids.update(row.card_id for row in referenced_rows if row.card_id)
        affected_card_ids.update(
            prepared["card"].id for prepared in prepared_new_incoming.values()
        )
        collection_items = []
        if affected_card_ids:
            collection_items = db.query(CollectionItem).options(joinedload(CollectionItem.card)).filter(
                CollectionItem.user_id == current_user.id,
                CollectionItem.card_id.in_(affected_card_ids),
            ).order_by(CollectionItem.id.asc()).with_for_update(of=CollectionItem).all()
        collection_by_id = {item.id: item for item in collection_items}
        for collection_id in outgoing_collection_ids:
            if collection_id not in collection_by_id:
                raise HTTPException(status_code=409, detail="An outgoing collection item changed; refresh and try again")

        collection_ids = [item.id for item in collection_items]
        historical_product_ids = {
            item.product_card_id for item in existing_non_cash.values() if item.product_card_id is not None
        }
        linked_ledger_rows = db.query(
            ProductLedgerEntry.product_card_id,
            ProductLedgerEntry.trade_item_id,
        ).filter(
            ProductLedgerEntry.trade_item_id.in_(list(existing_non_cash)),
            ProductLedgerEntry.product_card_id.isnot(None),
        ).all()
        historical_product_ids.update(product_card_id for product_card_id, _ in linked_ledger_rows)
        product_linked_trade_item_ids = {
            trade_item_id for _, trade_item_id in linked_ledger_rows if trade_item_id is not None
        }
        product_cards = []
        if collection_ids or historical_product_ids:
            product_filters = []
            if collection_ids:
                product_filters.append(ProductCard.collection_item_id.in_(collection_ids))
            if historical_product_ids:
                product_filters.append(ProductCard.id.in_(historical_product_ids))
            product_cards = db.query(ProductCard).filter(
                ProductCard.user_id == current_user.id,
                or_(*product_filters),
            ).order_by(ProductCard.id.asc()).with_for_update(of=ProductCard).all()

        db_trade.partner_name = (update.partner_name or "").strip() or None
        db_trade.trade_date = update.trade_date
        db_trade.notes = update.notes

        requested_outgoing = {
            item.trade_item_id: item for item in update.outgoing if item.trade_item_id is not None
        }
        existing_outgoing = [
            item for item in existing_non_cash.values() if item.direction == "outgoing"
        ]
        for trade_item in existing_outgoing:
            requested = requested_outgoing.get(trade_item.id)
            new_quantity = int(requested.quantity) if requested else 0
            old_quantity = int(trade_item.quantity or 0)
            old_condition = trade_item.condition or "NM"
            new_condition = (requested.condition or old_condition) if requested else old_condition
            if requested and new_condition not in ALLOWED_CONDITIONS:
                raise HTTPException(status_code=422, detail="condition is not supported")
            if (
                new_condition != old_condition
                and (
                    trade_item.product_card_id is not None
                    or trade_item.id in product_linked_trade_item_ids
                )
            ):
                raise HTTPException(
                    status_code=409,
                    detail="The condition of a product-linked outgoing card cannot be changed safely. Other trade details can still be edited.",
                )
            if new_quantity != old_quantity:
                purchase_price = _trade_item_purchase_price(trade_item, collection_items)
                if int(trade_item.snapshot_version or 0) < 1 and trade_item.product_card_id is None:
                    trade_item.purchase_price = purchase_price
                    trade_item.snapshot_version = 1
                if not trade_item.card:
                    raise HTTPException(status_code=409, detail="This outgoing card no longer exists and cannot be restored safely")
                if new_quantity < old_quantity:
                    reduction = old_quantity - new_quantity
                    restored_product_cards = _reverse_product_trade_out(db, trade_item, product_cards, reduction)
                    restored_item = _merge_locked_collection_item(
                        db,
                        current_user,
                        collection_items,
                        card=trade_item.card,
                        quantity=reduction,
                        condition=new_condition,
                        variant=trade_item.variant or "Normal",
                        lang=trade_item.lang or trade_item.card.lang or "en",
                        purchase_price=purchase_price,
                    )
                    for product_card in restored_product_cards:
                        product_card.collection_item_id = restored_item.id
                else:
                    increase = new_quantity - old_quantity
                    consumed = _remove_matching_collection_quantity(
                        db,
                        current_user,
                        collection_items,
                        product_cards,
                        card_id=trade_item.card_id,
                        variant=trade_item.variant,
                        condition=new_condition,
                        lang=trade_item.lang,
                        purchase_price=purchase_price,
                        quantity=increase,
                        protect_product_links=False,
                        preferred_item_id=trade_item.original_collection_item_id,
                    )
                    for collection_item, amount in consumed:
                        _record_linked_trade_out(
                            db, current_user, collection_item, amount,
                            float(trade_item.value_per_card or 0), db_trade.trade_date, trade_item,
                        )

            if requested is None:
                db.delete(trade_item)
                continue
            trade_item.quantity = new_quantity
            trade_item.value_total = round(float(trade_item.value_per_card or 0) * new_quantity, 2)
            trade_item.condition = new_condition
            trade_item.notes = requested.notes
            _update_linked_ledger_snapshots(db, db_trade, trade_item)

        for requested in sorted(
            (item for item in update.outgoing if item.collection_item_id is not None),
            key=lambda item: item.collection_item_id,
        ):
            collection_item = collection_by_id[requested.collection_item_id]
            available = int(collection_item.quantity or 0) - collection_item_allocated_quantity(
                db, current_user.id, collection_item.id,
            )
            if available < requested.quantity:
                raise HTTPException(
                    status_code=409,
                    detail=f"Only {max(available, 0)} unallocated copies of {collection_item.card.name if collection_item.card else collection_item.card_id} are available.",
                )
            value_per_card = _snapshot_price(collection_item.card, collection_item.variant, None, price_field)
            trade_item = TradeItem(
                trade_id=db_trade.id,
                user_id=current_user.id,
                direction="outgoing",
                card_id=collection_item.card_id,
                original_collection_item_id=collection_item.id,
                quantity=requested.quantity,
                value_per_card=value_per_card,
                value_total=round(value_per_card * requested.quantity, 2),
                variant=collection_item.variant,
                condition=collection_item.condition,
                lang=collection_item.lang,
                notes=requested.notes,
                purchase_price=collection_item.purchase_price,
                snapshot_version=1,
                created_at=datetime.datetime.utcnow(),
                **_card_snapshot(collection_item.card),
            )
            db.add(trade_item)
            db.flush()
            _record_linked_trade_out(
                db, current_user, collection_item, requested.quantity,
                value_per_card, db_trade.trade_date, trade_item,
            )
            collection_item.quantity = int(collection_item.quantity or 0) - requested.quantity

        requested_incoming = {
            item.trade_item_id: item for item in update.incoming if item.trade_item_id is not None
        }
        existing_incoming = [
            item for item in existing_non_cash.values() if item.direction == "incoming"
        ]
        for trade_item in existing_incoming:
            requested = requested_incoming.get(trade_item.id)
            new_quantity = int(requested.quantity) if requested else 0
            old_quantity = int(trade_item.quantity or 0)
            old_condition = trade_item.condition or "NM"
            old_variant = trade_item.variant or "Normal"
            old_lang = trade_item.lang or "en"
            new_condition = (requested.condition or "NM") if requested else old_condition
            new_variant = normalize_collection_variant(requested.variant) if requested else old_variant
            new_lang = _normalize_lang(requested.lang) if requested else old_lang
            if requested and new_condition not in ALLOWED_CONDITIONS:
                raise HTTPException(status_code=422, detail="condition is not supported")
            if requested and new_lang != old_lang:
                raise HTTPException(status_code=422, detail="The language of an existing trade card cannot be changed; remove it and add the correct print instead")

            identity_changed = (
                new_condition != old_condition
                or new_variant != old_variant
                or new_lang != old_lang
            )
            if new_quantity != old_quantity or identity_changed:
                purchase_price = _trade_item_purchase_price(trade_item, collection_items)
                if int(trade_item.snapshot_version or 0) < 1:
                    trade_item.purchase_price = purchase_price
                    trade_item.snapshot_version = 1
                if identity_changed:
                    _remove_matching_collection_quantity(
                        db,
                        current_user,
                        collection_items,
                        product_cards,
                        card_id=trade_item.card_id,
                        variant=trade_item.variant,
                        condition=trade_item.condition,
                        lang=trade_item.lang,
                        purchase_price=purchase_price,
                        quantity=old_quantity,
                        protect_product_links=True,
                        preferred_item_id=trade_item.created_collection_item_id,
                    )
                    if new_quantity > 0:
                        if not trade_item.card:
                            raise HTTPException(status_code=409, detail="This incoming card no longer exists and cannot be changed safely")
                        merged = _merge_locked_collection_item(
                            db,
                            current_user,
                            collection_items,
                            card=trade_item.card,
                            quantity=new_quantity,
                            condition=new_condition or "NM",
                            variant=new_variant or "Normal",
                            lang=new_lang or "en",
                            purchase_price=purchase_price,
                        )
                        trade_item.created_collection_item_id = merged.id
                elif new_quantity < old_quantity:
                    _remove_matching_collection_quantity(
                        db,
                        current_user,
                        collection_items,
                        product_cards,
                        card_id=trade_item.card_id,
                        variant=trade_item.variant,
                        condition=trade_item.condition,
                        lang=trade_item.lang,
                        purchase_price=purchase_price,
                        quantity=old_quantity - new_quantity,
                        protect_product_links=True,
                        preferred_item_id=trade_item.created_collection_item_id,
                    )
                else:
                    if not trade_item.card:
                        raise HTTPException(status_code=409, detail="This incoming card no longer exists and cannot be changed safely")
                    merged = _merge_locked_collection_item(
                        db,
                        current_user,
                        collection_items,
                        card=trade_item.card,
                        quantity=new_quantity - old_quantity,
                        condition=trade_item.condition or "NM",
                        variant=trade_item.variant or "Normal",
                        lang=trade_item.lang or "en",
                        purchase_price=purchase_price,
                    )
                    trade_item.created_collection_item_id = merged.id

            if requested is None:
                db.delete(trade_item)
                continue
            trade_item.quantity = new_quantity
            trade_item.value_total = round(float(trade_item.value_per_card or 0) * new_quantity, 2)
            trade_item.condition = new_condition
            trade_item.variant = new_variant
            trade_item.lang = new_lang
            trade_item.notes = requested.notes

        for index, requested in enumerate(update.incoming):
            if requested.trade_item_id is not None:
                continue
            prepared = prepared_new_incoming[index]
            card = prepared["card"]
            collection_item = _merge_locked_collection_item(
                db,
                current_user,
                collection_items,
                card=card,
                quantity=requested.quantity,
                condition=prepared["condition"],
                variant=prepared["variant"],
                lang=prepared["lang"],
                purchase_price=prepared["purchase_price"],
            )
            value_per_card = prepared["value_per_card"]
            db.add(TradeItem(
                trade_id=db_trade.id,
                user_id=current_user.id,
                direction="incoming",
                card_id=card.id,
                created_collection_item_id=collection_item.id,
                quantity=requested.quantity,
                value_per_card=value_per_card,
                value_total=round(value_per_card * requested.quantity, 2),
                variant=prepared["variant"],
                condition=prepared["condition"],
                lang=prepared["lang"],
                notes=requested.notes,
                purchase_price=prepared["purchase_price"],
                snapshot_version=1,
                created_at=datetime.datetime.utcnow(),
                **_card_snapshot(card),
            ))

        for collection_item in collection_items:
            if int(collection_item.quantity or 0) == 0:
                db.delete(collection_item)

        _set_cash_item(db, db_trade, current_user, existing_items, "outgoing", outgoing_cash)
        _set_cash_item(db, db_trade, current_user, existing_items, "incoming", incoming_cash)
        _recalculate_trade_totals(db, db_trade)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        logger.exception("Failed to update trade %s", trade_id)
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to update trade") from exc

    db_trade = db.query(Trade).options(
        joinedload(Trade.items).joinedload(TradeItem.card).joinedload(Card.set_ref),
    ).filter(Trade.id == trade_id, Trade.user_id == current_user.id).one()
    return _trade_response(db_trade)
