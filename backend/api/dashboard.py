from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload
from api.auth import get_current_user
from api.collection import _annotate_scan_photos
from database import get_db
from models import CollectionItem, Card, Set, PortfolioSnapshot, SyncLog, User
from services.card_values import effective_market_price, normalize_price_field
from services.card_visibility import visible_card_filter, visible_set_filter
from services.portfolio_valuation import (
    PORTFOLIO_CALCULATION_VERSION,
    calculate_portfolio_valuation,
    portfolio_snapshot_payload,
)
import datetime

router = APIRouter()


@router.get("/")
def get_dashboard(
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_trend", description="Price field to use for value calculation"),
    current_user: User = Depends(get_current_user),
):
    """Get dashboard statistics."""
    price_field = normalize_price_field(price_field)

    # Collection stats
    items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
        joinedload(CollectionItem.card)
    ).filter(
        CollectionItem.user_id == current_user.id,
        visible_card_filter(db, current_user.id, "all"),
    ).all()
    _annotate_scan_photos(db, current_user, items)

    total_cards = sum(item.quantity for item in items)
    unique_cards = len(items)

    valuation = calculate_portfolio_valuation(
        db,
        current_user.id,
        price_field,
        collection_items=items,
    )
    total_value = valuation.total_value
    total_cost = valuation.active_cost_basis
    pnl = valuation.total_pnl

    # Sets stats
    total_sets = db.query(Set).filter(visible_set_filter(db, current_user.id, "all")).count()

    # Count sets with at least one card
    owned_set_ids = set()
    for item in items:
        if item.card and item.card.set_id:
            owned_set_ids.add(item.card.set_id)

    # Top 10 most valuable cards (using selected price field)
    def card_value(item):
        if not item.card:
            return 0
        return effective_market_price(item.card, item.variant, price_field) * item.quantity

    top_cards = sorted(
        [item for item in items if item.card],
        key=card_value,
        reverse=True
    )[:10]

    top_cards_data = []
    for item in top_cards:
        card = item.card
        display_price = effective_market_price(card, item.variant, price_field)
        top_cards_data.append({
            "id": card.id,
            "collection_item_id": item.id,
            "card_id": card.id,
            "name": card.name,
            "set_id": card.set_id,
            "images_small": card.images_small,
            "images_large": card.images_large,
            "price_market": card.price_market,
            "price_trend": card.price_trend,
            "price_avg1": card.price_avg1,
            "price_avg7": card.price_avg7,
            "price_avg30": card.price_avg30,
            "display_price": display_price,
            "quantity": item.quantity,
            "variant": item.variant,
            "condition": item.condition,
            "lang": item.lang,
            "total_value": round(display_price * item.quantity, 2),
            "rarity": card.rarity,
            "custom_image_url": card.custom_image_url,
            "data_source_lang": card.data_source_lang,
            "price_source_lang": card.price_source_lang,
            "image_source_lang": card.image_source_lang,
            "has_scan_photo": item.has_scan_photo,
        })

    # Portfolio value history (last 90 days)
    snapshots = db.query(PortfolioSnapshot).filter(
        PortfolioSnapshot.user_id == current_user.id
    ).order_by(
        PortfolioSnapshot.date.desc()
    ).limit(90).all()
    snapshots.reverse()

    value_history = [portfolio_snapshot_payload(snapshot) for snapshot in snapshots]

    # Recent additions (last 12)
    recent = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(
        CollectionItem.user_id == current_user.id,
        visible_card_filter(db, current_user.id, "all"),
    ).order_by(CollectionItem.added_at.desc()).limit(12).all()
    _annotate_scan_photos(db, current_user, recent)

    recent_data = []
    for item in recent:
        if item.card:
            recent_data.append({
                "id": item.id,
                "collection_item_id": item.id,
                "card_id": item.card_id,
                "name": item.card.name,
                "images_small": item.card.images_small,
                "quantity": item.quantity,
                "variant": item.variant,
                "condition": item.condition,
                "lang": item.lang,
                "added_at": item.added_at.isoformat() if item.added_at else None,
                "price_market": effective_market_price(item.card, item.variant, price_field),
                "custom_image_url": item.card.custom_image_url,
                "data_source_lang": item.card.data_source_lang,
                "price_source_lang": item.card.price_source_lang,
                "image_source_lang": item.card.image_source_lang,
                "has_scan_photo": item.has_scan_photo,
            })

    # Last sync
    last_sync = db.query(SyncLog).order_by(SyncLog.started_at.desc()).first()
    last_sync_data = None
    if last_sync:
        def ensure_utc_z(dt):
            if dt is None:
                return None
            if dt.tzinfo is None:
                return dt.strftime('%Y-%m-%dT%H:%M:%SZ')
            return dt.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        last_sync_data = {
            "status": last_sync.status,
            "started_at": ensure_utc_z(last_sync.started_at),
            "finished_at": ensure_utc_z(last_sync.finished_at),
            "cards_updated": last_sync.cards_updated,
        }

    # New sets count
    new_sets_count = db.query(Set).filter(
        Set.is_new == True,
        visible_set_filter(db, current_user.id, "all"),
    ).count()

    return {
        "total_cards": total_cards,
        "unique_cards": unique_cards,
        "total_value": round(total_value, 2),
        "total_cost": round(total_cost, 2),
        "card_value": valuation.card_value,
        "product_value": valuation.product_value,
        "cards_cost": valuation.card_cost_basis,
        "products_cost": valuation.product_cost_basis,
        "performance_cost_basis": valuation.performance_cost_basis,
        "realized_value": valuation.realized_value,
        "unrealized_pnl": valuation.unrealized_pnl,
        "realized_pnl": valuation.realized_pnl,
        "product_value_fallback_count": valuation.product_value_fallback_count,
        "products_needing_review_count": valuation.products_needing_review_count,
        "calculation_version": PORTFOLIO_CALCULATION_VERSION,
        "products_sold_cost": valuation.products_sold_cost,
        "products_sold_revenue": valuation.products_sold_revenue,
        "products_realized_pnl": valuation.products_realized_pnl,
        "pnl": round(pnl, 2),
        "total_sets": total_sets,
        "owned_sets": len(owned_set_ids),
        "top_cards": top_cards_data,
        "value_history": value_history,
        "recent_additions": recent_data,
        "last_sync": last_sync_data,
        "new_sets_count": new_sets_count,
        "price_field": price_field,
    }
