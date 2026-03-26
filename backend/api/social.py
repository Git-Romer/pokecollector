from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import Card, CollectionItem, ProductPurchase, Set, User, WishlistItem

router = APIRouter()

HOLO_VARIANTS = {"Holo", "Holo Rare", "Holo V", "Holo VMAX", "Holo VSTAR", "Holo ex", "Reverse Holo"}


ACHIEVEMENTS = [
    {
        "id": "first_card",
        "name_key": "achievements.firstCard",
        "description_key": "achievements.firstCardDesc",
        "badge_id": 1,
        "metric": "total_cards",
        "target": 1,
    },
    {
        "id": "collector_10",
        "name_key": "achievements.collector10",
        "description_key": "achievements.collector10Desc",
        "badge_id": 2,
        "metric": "total_cards",
        "target": 10,
    },
    {
        "id": "collector_50",
        "name_key": "achievements.collector50",
        "description_key": "achievements.collector50Desc",
        "badge_id": 3,
        "metric": "total_cards",
        "target": 50,
    },
    {
        "id": "collector_100",
        "name_key": "achievements.collector100",
        "description_key": "achievements.collector100Desc",
        "badge_id": 4,
        "metric": "total_cards",
        "target": 100,
    },
    {
        "id": "collector_500",
        "name_key": "achievements.collector500",
        "description_key": "achievements.collector500Desc",
        "badge_id": 5,
        "metric": "total_cards",
        "target": 500,
    },
    {
        "id": "collector_1000",
        "name_key": "achievements.collector1000",
        "description_key": "achievements.collector1000Desc",
        "badge_id": 6,
        "metric": "total_cards",
        "target": 1000,
    },
    {
        "id": "first_set",
        "name_key": "achievements.firstSet",
        "description_key": "achievements.firstSetDesc",
        "badge_id": 7,
        "metric": "sets_completed",
        "target": 1,
    },
    {
        "id": "set_master_5",
        "name_key": "achievements.setMaster5",
        "description_key": "achievements.setMaster5Desc",
        "badge_id": 8,
        "metric": "sets_completed",
        "target": 5,
    },
    {
        "id": "set_master_10",
        "name_key": "achievements.setMaster10",
        "description_key": "achievements.setMaster10Desc",
        "badge_id": 9,
        "metric": "sets_completed",
        "target": 10,
    },
    {
        "id": "big_spender_100",
        "name_key": "achievements.bigSpender100",
        "description_key": "achievements.bigSpender100Desc",
        "badge_id": 10,
        "metric": "total_value",
        "target": 100,
    },
    {
        "id": "big_spender_500",
        "name_key": "achievements.bigSpender500",
        "description_key": "achievements.bigSpender500Desc",
        "badge_id": 11,
        "metric": "total_value",
        "target": 500,
    },
    {
        "id": "big_spender_1000",
        "name_key": "achievements.bigSpender1000",
        "description_key": "achievements.bigSpender1000Desc",
        "badge_id": 12,
        "metric": "total_value",
        "target": 1000,
    },
    {
        "id": "big_spender_5000",
        "name_key": "achievements.bigSpender5000",
        "description_key": "achievements.bigSpender5000Desc",
        "badge_id": 13,
        "metric": "total_value",
        "target": 5000,
    },
    {
        "id": "investor",
        "name_key": "achievements.investor",
        "description_key": "achievements.investorDesc",
        "badge_id": 14,
        "metric": "positive_pnl_flag",
        "target": 1,
    },
    {
        "id": "diversifier",
        "name_key": "achievements.diversifier",
        "description_key": "achievements.diversifierDesc",
        "badge_id": 15,
        "metric": "set_diversity",
        "target": 10,
    },
    {
        "id": "diversifier_25",
        "name_key": "achievements.diversifier25",
        "description_key": "achievements.diversifier25Desc",
        "badge_id": 16,
        "metric": "set_diversity",
        "target": 25,
    },
    {
        "id": "wishlist_hunter",
        "name_key": "achievements.wishlistHunter",
        "description_key": "achievements.wishlistHunterDesc",
        "badge_id": 17,
        "metric": "wishlist_count",
        "target": 5,
    },
    {
        "id": "first_sale",
        "name_key": "achievements.firstSale",
        "description_key": "achievements.firstSaleDesc",
        "badge_id": 18,
        "metric": "sold_products_count",
        "target": 1,
    },
    {
        "id": "trader",
        "name_key": "achievements.trader",
        "description_key": "achievements.traderDesc",
        "badge_id": 19,
        "metric": "sold_products_count",
        "target": 10,
    },
    {
        "id": "rare_finder",
        "name_key": "achievements.rareFinder",
        "description_key": "achievements.rareFinderDesc",
        "badge_id": 20,
        "metric": "illustration_rare_flag",
        "target": 1,
    },
]


def _card_payload(card: Card | None):
    if not card:
        return None
    return {
        "name": card.name,
        "images_small": card.images_small,
        "price_market": round(card.price_market or 0, 2),
        "set_id": card.set_id,
    }


def _load_user_stats(db: Session, user_ids: list[int] | None = None):
    def _get_price(row):
        if hasattr(row, "variant") and row.variant in HOLO_VARIANTS:
            holo = getattr(row, "price_market_holo", None)
            if holo is not None:
                return holo
        return row.price_market or 0

    user_query = db.query(User).filter(User.is_active == True)
    if user_ids is not None:
        user_query = user_query.filter(User.id.in_(user_ids))
    users = user_query.order_by(User.username.asc()).all()
    if not users:
        return {}

    active_user_ids = [user.id for user in users]

    collection_rows = db.query(
        CollectionItem.user_id,
        CollectionItem.card_id,
        CollectionItem.quantity,
        CollectionItem.purchase_price,
        CollectionItem.variant,
        Card.id.label("card_db_id"),
        Card.name,
        Card.images_small,
        Card.price_market,
        Card.price_market_holo,
        Card.set_id,
        Card.lang,
        Card.rarity,
    ).join(
        Card, CollectionItem.card_id == Card.id
    ).filter(
        CollectionItem.user_id.in_(active_user_ids)
    ).all()

    set_sizes = {
        (row.set_id, row.lang): row.card_count
        for row in db.query(
            Card.set_id,
            Card.lang,
            func.count(Card.id).label("card_count"),
        ).filter(
            Card.set_id.isnot(None)
        ).group_by(
            Card.set_id, Card.lang
        ).all()
    }

    wishlist_counts = {
        row.user_id: row.count
        for row in db.query(
            WishlistItem.user_id,
            func.count(WishlistItem.id).label("count"),
        ).filter(
            WishlistItem.user_id.in_(active_user_ids)
        ).group_by(
            WishlistItem.user_id
        ).all()
    }

    sold_product_counts = {
        row.user_id: row.count
        for row in db.query(
            ProductPurchase.user_id,
            func.count(ProductPurchase.id).label("count"),
        ).filter(
            ProductPurchase.user_id.in_(active_user_ids),
            ProductPurchase.sold_price.isnot(None),
            ProductPurchase.sold_price > 0,
        ).group_by(
            ProductPurchase.user_id
        ).all()
    }

    items_by_user = defaultdict(list)
    for row in collection_rows:
        items_by_user[row.user_id].append(row)

    stats = {}
    for user in users:
        rows = items_by_user.get(user.id, [])
        total_cards = sum(row.quantity or 0 for row in rows)
        unique_card_ids = {row.card_id for row in rows}
        total_value = sum(_get_price(row) * (row.quantity or 0) for row in rows)
        total_invested = sum(
            (row.purchase_price or 0) * (row.quantity or 0)
            for row in rows
            if row.purchase_price is not None
        )

        most_valuable = None
        if rows:
            most_valuable_row = max(rows, key=lambda row: _get_price(row))
            most_valuable = {
                "name": most_valuable_row.name,
                "images_small": most_valuable_row.images_small,
                "price_market": round(_get_price(most_valuable_row), 2),
                "set_id": most_valuable_row.set_id,
            }

        owned_by_set = defaultdict(set)
        owned_set_ids = set()
        has_illustration_rare = False
        for row in rows:
            if row.set_id:
                owned_by_set[(row.set_id, row.lang)].add(row.card_id)
                owned_set_ids.add(row.set_id)
            if row.rarity and "illustration rare" in row.rarity.lower():
                has_illustration_rare = True

        sets_completed = 0
        for set_key, owned_cards in owned_by_set.items():
            total_in_set = set_sizes.get(set_key, 0)
            if total_in_set > 0 and len(owned_cards) >= total_in_set:
                sets_completed += 1

        user_products = db.query(ProductPurchase).filter(
            ProductPurchase.user_id == user.id
        ).all()
        unsold_products = [p for p in user_products if not (p.sold_price is not None and p.sold_price > 0)]
        sold_products = [p for p in user_products if p.sold_price is not None and p.sold_price > 0]

        products_cost = sum(p.purchase_price for p in unsold_products if p.purchase_price)
        products_sold_cost = sum(p.purchase_price for p in sold_products if p.purchase_price)
        products_sold_revenue = sum(p.sold_price for p in sold_products if p.sold_price)
        products_realized_pnl = products_sold_revenue - products_sold_cost

        total_cost = total_invested + products_cost
        pnl = total_value - total_cost + products_realized_pnl
        pnl_pct = ((total_value / total_cost) - 1) * 100 if total_cost > 0 else None

        stats[user.id] = {
            "user_id": user.id,
            "username": user.username,
            "avatar_id": user.avatar_id,
            "role": user.role,
            "total_cards": total_cards,
            "unique_cards": len(unique_card_ids),
            "total_value": round(total_value, 2),
            "most_valuable_card": most_valuable,
            "sets_completed": sets_completed,
            "total_invested": round(total_cost, 2),
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 2) if pnl_pct is not None else None,
            "set_diversity": len(owned_set_ids),
            "wishlist_count": wishlist_counts.get(user.id, 0),
            "sold_products_count": sold_product_counts.get(user.id, 0),
            "positive_pnl_flag": 1 if pnl > 0 else 0,
            "illustration_rare_flag": 1 if has_illustration_rare else 0,
        }

    return stats


@router.get("/leaderboard")
def get_leaderboard(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    stats = _load_user_stats(db)
    leaderboard = sorted(
        stats.values(),
        key=lambda entry: (entry["total_value"], entry["total_cards"], entry["unique_cards"]),
        reverse=True,
    )
    return leaderboard


@router.get("/compare/{user_id}")
def compare_users(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot compare user to self")

    other_user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not other_user:
        raise HTTPException(status_code=404, detail="User not found")

    stats = _load_user_stats(db, [current_user.id, user_id])
    if current_user.id not in stats or user_id not in stats:
        raise HTTPException(status_code=404, detail="Comparison users not found")

    user_a_cards = {
        row.card_id: row
        for row in db.query(
            CollectionItem.card_id,
            CollectionItem.quantity,
            Card.name,
            Card.images_small,
        ).join(
            Card, CollectionItem.card_id == Card.id
        ).filter(
            CollectionItem.user_id == current_user.id
        ).all()
    }
    user_b_cards = {
        row.card_id: row
        for row in db.query(
            CollectionItem.card_id,
            CollectionItem.quantity,
            Card.name,
            Card.images_small,
        ).join(
            Card, CollectionItem.card_id == Card.id
        ).filter(
            CollectionItem.user_id == user_id
        ).all()
    }

    user_a_wishlist = {
        row.card_id
        for row in db.query(WishlistItem.card_id).filter(WishlistItem.user_id == current_user.id).all()
    }
    user_b_wishlist = {
        row.card_id
        for row in db.query(WishlistItem.card_id).filter(WishlistItem.user_id == user_id).all()
    }

    overlap = len(set(user_a_cards) & set(user_b_cards))
    only_a = len(set(user_a_cards) - set(user_b_cards))
    only_b = len(set(user_b_cards) - set(user_a_cards))

    trade_suggestions = []
    seen_pairs = set()

    for owner_stats, wants_stats, owner_cards, wanted_cards in [
        (stats[current_user.id], stats[user_id], user_a_cards, user_b_wishlist),
        (stats[user_id], stats[current_user.id], user_b_cards, user_a_wishlist),
    ]:
        for card_id, row in owner_cards.items():
            if row.quantity <= 1 or card_id not in wanted_cards:
                continue
            pair = (card_id, owner_stats["user_id"], wants_stats["user_id"])
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            trade_suggestions.append({
                "card_id": card_id,
                "card_name": row.name,
                "images_small": row.images_small,
                "owner_username": owner_stats["username"],
                "wants_username": wants_stats["username"],
            })
            if len(trade_suggestions) >= 10:
                break
        if len(trade_suggestions) >= 10:
            break

    return {
        "user_a": stats[current_user.id],
        "user_b": stats[user_id],
        "overlap": overlap,
        "only_a": only_a,
        "only_b": only_b,
        "trade_suggestions": trade_suggestions,
    }


@router.get("/achievements/{user_id}")
def get_achievements(user_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    stats = _load_user_stats(db, [user_id]).get(user_id)
    if not stats:
        raise HTTPException(status_code=404, detail="User stats not found")

    achievements = []
    for config in ACHIEVEMENTS:
        progress = stats.get(config["metric"], 0)
        unlocked = progress >= config["target"]
        achievements.append({
            "id": config["id"],
            "name_key": config["name_key"],
            "description_key": config["description_key"],
            "badge_id": config["badge_id"],
            "unlocked": unlocked,
            "progress": min(progress, config["target"]) if config["target"] == 1 else progress,
            "target": config["target"],
        })

    return {
        "user_id": user.id,
        "username": user.username,
        "avatar_id": user.avatar_id,
        "earned": sum(1 for achievement in achievements if achievement["unlocked"]),
        "total": len(achievements),
        "achievements": achievements,
    }
