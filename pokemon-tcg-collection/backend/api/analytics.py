from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from database import get_db
from models import CollectionItem, Card, PriceHistory, PortfolioSnapshot, Set, ProductPurchase
from typing import Optional
import datetime

router = APIRouter()

# Variants that use the Cardmarket holo price family
HOLO_VARIANTS = {"Holo", "Holo Rare", "Holo V", "Holo VMAX", "Holo VSTAR", "Holo ex"}


def _get_item_price(item):
    """Return the correct market price for a collection item, respecting holo variant."""
    card = item.card
    if not card:
        return 0
    # Reverse Holo: uses standard non-holo CM price (reverse premium is TCGPlayer/USD only)
    if item.variant in HOLO_VARIANTS and card.price_market_holo is not None:
        return card.price_market_holo
    return card.price_market or 0


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


def _take_portfolio_snapshot(db: Session):
    """Insert a new portfolio snapshot (called on every price sync)."""
    now = datetime.datetime.utcnow()

    collection_items = db.query(CollectionItem).join(Card).all()
    total_value = sum(
        _get_item_price(item) * item.quantity
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

    snapshot = PortfolioSnapshot(
        date=now,
        total_value=total_value,
        total_cards=total_cards,
        total_cost=total_cost,
    )
    db.add(snapshot)
    db.commit()


def _bucket_by_week(snapshots):
    """Keep the last snapshot per ISO week."""
    buckets = {}
    for s in snapshots:
        bucket = s.date.strftime('%Y-W%W')
        buckets[bucket] = s
    return list(buckets.values())


def _downsample(snapshots, period: str):
    """Downsample snapshot list based on period."""
    if not snapshots:
        return snapshots

    if period == '1d':
        # raw — every 30 min, ≤ 48 pts — no downsampling needed
        return snapshots

    if period == '1w':
        # 2 per day — keep last value per 12-hour half-day bucket
        buckets = {}
        for s in snapshots:
            half = 'am' if s.date.hour < 12 else 'pm'
            bucket = s.date.strftime('%Y-%m-%d_') + half
            buckets[bucket] = s
        return list(buckets.values())

    if period in ('1m', '3m'):
        # 1 per day — daily last value
        buckets = {}
        for s in snapshots:
            bucket = s.date.strftime('%Y-%m-%d')
            buckets[bucket] = s
        return list(buckets.values())

    if period in ('6m', '1y'):
        return _bucket_by_week(snapshots)

    # max — 1 per week, or 1 per month if > 2 years of data
    if snapshots[-1].date - snapshots[0].date > datetime.timedelta(days=730):
        # 1 per month
        buckets = {}
        for s in snapshots:
            bucket = s.date.strftime('%Y-%m')
            buckets[bucket] = s
        return list(buckets.values())
    return _bucket_by_week(snapshots)


@router.get("/investment-tracker")
def get_investment_tracker(period: str = Query('max'), db: Session = Depends(get_db)):
    """Get portfolio value over time with optional period filtering and downsampling."""
    # Always insert a fresh snapshot so the current state is represented
    _take_portfolio_snapshot(db)

    period = period.lower()

    # Determine cutoff date based on period
    now = datetime.datetime.utcnow()
    cutoff = None
    if period == '1d':
        cutoff = now - datetime.timedelta(days=1)
    elif period == '1w':
        cutoff = now - datetime.timedelta(weeks=1)
    elif period == '1m':
        cutoff = now - datetime.timedelta(days=30)
    elif period == '3m':
        cutoff = now - datetime.timedelta(days=90)
    elif period == '6m':
        cutoff = now - datetime.timedelta(days=180)
    elif period == '1y':
        cutoff = now - datetime.timedelta(days=365)
    # 'max' → no cutoff

    query = db.query(PortfolioSnapshot).order_by(PortfolioSnapshot.date.asc())
    if cutoff:
        query = query.filter(PortfolioSnapshot.date >= cutoff)
    snapshots = query.all()

    snapshots = _downsample(snapshots, period)

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
