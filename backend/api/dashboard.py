from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func, desc
from api.auth import get_current_user
from database import get_db
from models import CollectionItem, Card, Set, PortfolioSnapshot, SyncLog, ProductPurchase, User
import datetime

router = APIRouter()

# Valid price fields that can be requested
VALID_PRICE_FIELDS = {"price_market", "price_trend", "price_avg1", "price_avg7", "price_avg30"}

# Variants that use the Cardmarket holo price family
HOLO_VARIANTS = {"Holo", "Holo Rare", "Holo V", "Holo VMAX", "Holo VSTAR", "Holo ex", "Reverse Holo"}

# Maps each standard price field to its holo equivalent
HOLO_FIELD_MAP = {
    "price_market": "price_market_holo",
    "price_trend": "price_trend_holo",
    "price_avg1": "price_avg1_holo",
    "price_avg7": "price_avg7_holo",
    "price_avg30": "price_avg30_holo",
}


@router.get("/")
def get_dashboard(
    db: Session = Depends(get_db),
    price_field: str = Query(default="price_market", description="Price field to use for value calculation"),
    current_user: User = Depends(get_current_user),
):
    """Get dashboard statistics."""
    # Validate price_field
    if price_field not in VALID_PRICE_FIELDS:
        price_field = "price_market"

    # Collection stats
    items = db.query(CollectionItem).options(
        joinedload(CollectionItem.card)
    ).filter(
        CollectionItem.user_id == current_user.id
    ).all()

    total_cards = sum(item.quantity for item in items)
    unique_cards = len(items)

    def get_card_price(card, field, variant=None):
        """Get price by field, apply holo override for holo variants, fall back to price_market if None."""
        if variant in HOLO_VARIANTS:
            holo_field = HOLO_FIELD_MAP.get(field, field)
            val = getattr(card, holo_field, None)
            if val is not None:
                return val
        val = getattr(card, field, None)
        if val is None:
            val = card.price_market
        return val or 0

    # Always use price_market for current portfolio value on home/collection
    total_value = sum(
        get_card_price(item.card, price_field, variant=item.variant) * item.quantity
        for item in items if item.card
    )

    # G&V = current portfolio value - ALL active expenses + realized product P&L
    # Individual card purchase prices
    cards_cost = sum(
        (item.purchase_price or 0) * item.quantity for item in items
    )
    # Product purchases (booster packs, displays, ETB, etc.)
    # Only count UNSOLD products — sold ones are no longer actively invested
    all_products = db.query(ProductPurchase).filter(
        ProductPurchase.user_id == current_user.id
    ).all()
    # A product is "sold" when sold_price is set AND > 0
    unsold_products = [p for p in all_products if not (p.sold_price is not None and p.sold_price > 0)]
    sold_products = [p for p in all_products if p.sold_price is not None and p.sold_price > 0]

    products_cost = sum(
        p.purchase_price for p in unsold_products
        if p.purchase_price is not None
    )
    products_sold_cost = sum(
        p.purchase_price for p in sold_products
        if p.purchase_price is not None
    )
    products_sold_revenue = sum(
        p.sold_price for p in sold_products
        if p.sold_price is not None
    )
    products_realized_pnl = products_sold_revenue - products_sold_cost

    total_cost = cards_cost + products_cost
    # P&L = (current card value - card costs) + (sold product revenue - sold product costs) - unsold product costs
    pnl = total_value - total_cost + products_realized_pnl

    # Sets stats
    total_sets = db.query(Set).count()

    # Count sets with at least one card
    owned_set_ids = set()
    for item in items:
        if item.card and item.card.set_id:
            owned_set_ids.add(item.card.set_id)

    # Top 10 most valuable cards (using selected price field)
    def card_value(item):
        if not item.card:
            return 0
        return get_card_price(item.card, price_field, variant=item.variant) * item.quantity

    top_cards = sorted(
        [item for item in items if item.card],
        key=card_value,
        reverse=True
    )[:10]

    top_cards_data = []
    for item in top_cards:
        card = item.card
        display_price = get_card_price(card, price_field, variant=item.variant)
        top_cards_data.append({
            "id": card.id,
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
            "total_value": round(display_price * item.quantity, 2),
            "rarity": card.rarity,
        })

    # Portfolio value history (last 90 days)
    snapshots = db.query(PortfolioSnapshot).filter(
        PortfolioSnapshot.user_id == current_user.id
    ).order_by(
        PortfolioSnapshot.date.asc()
    ).limit(90).all()

    value_history = [
        {
            "date": s.date.isoformat(),
            "value": round(s.total_value, 2),
            "cost": round(s.total_cost, 2),
        }
        for s in snapshots
    ]

    # Recent additions (last 12)
    recent = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(
        CollectionItem.user_id == current_user.id
    ).order_by(CollectionItem.added_at.desc()).limit(12).all()

    recent_data = []
    for item in recent:
        if item.card:
            recent_data.append({
                "id": item.id,
                "card_id": item.card_id,
                "name": item.card.name,
                "images_small": item.card.images_small,
                "quantity": item.quantity,
                "added_at": item.added_at.isoformat() if item.added_at else None,
                "price_market": item.card.price_market,
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
    new_sets_count = db.query(Set).filter(Set.is_new == True).count()

    return {
        "total_cards": total_cards,
        "unique_cards": unique_cards,
        "total_value": round(total_value, 2),
        "total_cost": round(total_cost, 2),
        "cards_cost": round(cards_cost, 2),
        "products_cost": round(products_cost, 2),
        "products_sold_cost": round(products_sold_cost, 2),
        "products_sold_revenue": round(products_sold_revenue, 2),
        "products_realized_pnl": round(products_realized_pnl, 2),
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
