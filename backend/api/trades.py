import datetime
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from api.collection import ensure_card_exists
from database import get_db
from models import BinderCard, Card, CollectionItem, ProductCard, ProductLedgerEntry, ProductPurchase, Trade, TradeItem, User
from schemas import TradeCreate, TradeResponse, TradeValuationRequest
from services import pokemon_api
from services.card_values import effective_market_price, normalize_price_field
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


def _delete_collection_item_references(db: Session, collection_item_id: int) -> None:
    db.query(BinderCard).filter(BinderCard.collection_item_id == collection_item_id).delete(synchronize_session=False)


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

            if collection_item.quantity > outgoing.quantity:
                collection_item.quantity -= outgoing.quantity
            else:
                _delete_collection_item_references(db, collection_item.id)
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
            ))

        for incoming in trade.incoming:
            if not positive_quantity(incoming.quantity, TRADE_QUANTITY_MAX):
                raise HTTPException(status_code=422, detail="quantity must be between 1 and 999")
            condition = incoming.condition or "NM"
            if condition not in ALLOWED_CONDITIONS:
                raise HTTPException(status_code=422, detail="condition is not supported")
            variant = normalize_collection_variant(incoming.variant)
            lang = _normalize_lang(incoming.lang)
            _validate_money(incoming.purchase_price, "purchase_price")
            card = _resolve_incoming_card(db, incoming.card_id, lang)
            item_lang = card.lang or lang
            value_per_card = _snapshot_price(card, variant, incoming.value_per_card, price_field)
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
                incoming.purchase_price,
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
