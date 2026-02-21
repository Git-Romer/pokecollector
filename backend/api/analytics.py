from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from database import get_db
from models import CollectionItem, Card, PriceHistory, PortfolioSnapshot, Set, ProductPurchase
from typing import Optional
import datetime

router = APIRouter()


@router.get("/duplicates")
def get_duplicates(db: Session = Depends(get_db)):
    """Get all cards owned more than once, sorted by total value."""
    items = db.query(CollectionItem).options(
        joinedload(CollectionItem.card).joinedload(Card.set_ref)
    ).filter(CollectionItem.quantity > 1).all()

    result = []
    for item in items:
        if item.card:
            result.append({
                "id": item.id,
                "card_id": item.card_id,
                "name": item.card.name,
                "set_name": item.card.set_ref.name if item.card.set_ref else None,
                "images_small": item.card.images_small,
                "quantity": item.quantity,
                "price_market": item.card.price_market,
                "total_value": round((item.card.price_market or 0) * item.quantity, 2),
                "rarity": item.card.rarity,
            })

    result.sort(key=lambda x: x["total_value"], reverse=True)
    return result


@router.get("/top-movers")
def get_top_movers(days: int = Query(7, ge=1, le=30), db: Session = Depends(get_db)):
    """Get cards with most price change in last N days."""
    cutoff_date = datetime.date.today() - datetime.timedelta(days=days)

    # Get collection card IDs
    col_card_ids = [item.card_id for item in db.query(CollectionItem.card_id).all()]
    if not col_card_ids:
        return []

    results = []
    for card_id in col_card_ids:
        card = db.query(Card).filter(Card.id == card_id).first()
        if not card or card.price_market is None:
            continue

        # Get oldest price in period
        old_price_entry = db.query(PriceHistory).filter(
            PriceHistory.card_id == card_id,
            PriceHistory.date >= cutoff_date,
            PriceHistory.price_market.isnot(None),
        ).order_by(PriceHistory.date.asc()).first()

        if not old_price_entry or old_price_entry.price_market is None:
            continue

        old_price = old_price_entry.price_market
        current_price = card.price_market

        change_abs = current_price - old_price
        change_pct = ((current_price - old_price) / old_price * 100) if old_price > 0 else 0

        results.append({
            "card_id": card_id,
            "name": card.name,
            "images_small": card.images_small,
            "rarity": card.rarity,
            "current_price": round(current_price, 2),
            "old_price": round(old_price, 2),
            "change_abs": round(change_abs, 2),
            "change_pct": round(change_pct, 1),
        })

    # Sort by absolute change percentage
    results.sort(key=lambda x: abs(x["change_pct"]), reverse=True)
    return results[:20]


@router.get("/rarity-stats")
def get_rarity_stats(db: Session = Depends(get_db)):
    """Get rarity distribution of collection."""
    items = db.query(CollectionItem).options(joinedload(CollectionItem.card)).all()

    rarity_counts = {}
    rarity_values = {}

    for item in items:
        if item.card:
            rarity = item.card.rarity or "Unknown"
            rarity_counts[rarity] = rarity_counts.get(rarity, 0) + item.quantity
            rarity_values[rarity] = rarity_values.get(rarity, 0) + (
                (item.card.price_market or 0) * item.quantity
            )

    total = sum(rarity_counts.values())
    result = []
    for rarity, count in rarity_counts.items():
        result.append({
            "rarity": rarity,
            "count": count,
            "percentage": round(count / total * 100, 1) if total > 0 else 0,
            "total_value": round(rarity_values.get(rarity, 0), 2),
        })

    result.sort(key=lambda x: x["count"], reverse=True)
    return result


def _calc_products_cost(db: Session):
    """Calculate cost of unsold products only (sold products no longer tied up)."""
    all_products = db.query(ProductPurchase).all()
    return sum(
        p.purchase_price for p in all_products
        if p.purchase_price is not None and p.sold_price is None
    )


def _ensure_portfolio_snapshot(db: Session):
    """Ensure today's portfolio snapshot exists. Creates it if missing."""
    today = datetime.date.today()
    existing = db.query(PortfolioSnapshot).filter(PortfolioSnapshot.date == today).first()
    if existing:
        # Update snapshot with current values (prices may have changed)
        collection_items = db.query(CollectionItem).join(Card).all()
        total_value = sum(
            (item.card.price_market or 0) * item.quantity
            for item in collection_items
            if item.card
        )
        total_cards = sum(item.quantity for item in collection_items)
        # total_cost = card purchase prices + UNSOLD product purchases
        cards_cost = sum(
            (item.purchase_price or 0) * item.quantity
            for item in collection_items
        )
        products_cost = _calc_products_cost(db)
        total_cost = cards_cost + products_cost

        existing.total_value = total_value
        existing.total_cards = total_cards
        existing.total_cost = total_cost
        db.commit()
        return

    # Create new snapshot
    collection_items = db.query(CollectionItem).join(Card).all()
    total_value = sum(
        (item.card.price_market or 0) * item.quantity
        for item in collection_items
        if item.card
    )
    total_cards = sum(item.quantity for item in collection_items)
    cards_cost = sum(
        (item.purchase_price or 0) * item.quantity
        for item in collection_items
    )
    products_cost = _calc_products_cost(db)
    total_cost = cards_cost + products_cost

    snapshot = PortfolioSnapshot(
        date=today,
        total_value=total_value,
        total_cards=total_cards,
        total_cost=total_cost,
    )
    db.add(snapshot)
    db.commit()


@router.get("/investment-tracker")
def get_investment_tracker(db: Session = Depends(get_db)):
    """Get portfolio value over time. Ensures today's snapshot exists."""
    # Always ensure we have a current snapshot
    _ensure_portfolio_snapshot(db)

    snapshots = db.query(PortfolioSnapshot).order_by(
        PortfolioSnapshot.date.asc()
    ).all()

    return [
        {
            "date": s.date.isoformat(),
            "value": round(s.total_value, 2),
            "cost": round(s.total_cost, 2),
            "pnl": round(s.total_value - s.total_cost, 2),
            "cards": s.total_cards,
        }
        for s in snapshots
    ]


@router.get("/new-sets")
def get_new_sets(db: Session = Depends(get_db)):
    """Get newly detected sets."""
    new_sets = db.query(Set).filter(Set.is_new == True).all()
    return [
        {
            "id": s.id,
            "name": s.name,
            "series": s.series,
            "release_date": s.release_date,
            "total": s.total,
            "images_symbol": s.images_symbol,
            "images_logo": s.images_logo,
        }
        for s in new_sets
    ]
