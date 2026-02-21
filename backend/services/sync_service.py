import logging
import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func
from models import Card, Set, CollectionItem, WishlistItem, PriceHistory, SyncLog, PortfolioSnapshot, CustomCardMatch, Setting
from services import pokemon_api, telegram

logger = logging.getLogger(__name__)

MAX_CARDS_PER_SYNC = 500  # TCGdex has no published rate limit; be reasonable


def _get_language(db: Session) -> str:
    """Get display language from settings."""
    row = db.query(Setting).filter(Setting.key == "language").first()
    return row.value if row else "de"


def upsert_set(db: Session, set_data: dict):
    """Insert or update a set in the database."""
    existing = db.query(Set).filter(Set.id == set_data["id"]).first()
    if existing:
        for key, value in set_data.items():
            if key != "id" and value is not None:
                setattr(existing, key, value)
    else:
        existing = Set(**set_data, is_new=True)
        db.add(existing)
    return existing


def upsert_card(db: Session, card_data: dict):
    """Insert or update a card in the database."""
    existing = db.query(Card).filter(Card.id == card_data["id"]).first()
    card_data["updated_at"] = datetime.datetime.utcnow()
    if existing:
        for key, value in card_data.items():
            if key != "id":
                setattr(existing, key, value)
    else:
        existing = Card(**card_data)
        db.add(existing)
    return existing


def record_price_history(db: Session, card: Card):
    """Record today's price for a card."""
    today = datetime.date.today()
    existing = db.query(PriceHistory).filter(
        PriceHistory.card_id == card.id,
        PriceHistory.date == today
    ).first()

    if not existing:
        history = PriceHistory(
            card_id=card.id,
            date=today,
            price_low=card.price_low,
            price_mid=card.price_mid,
            price_high=card.price_high,
            price_market=card.price_market,
            price_trend=card.price_trend,
        )
        db.add(history)


def check_wishlist_alerts(db: Session, updated_card_ids: list):
    """Check wishlist items for price alerts and send Telegram notifications."""
    if not updated_card_ids:
        return

    wishlist_items = db.query(WishlistItem).join(Card).filter(
        WishlistItem.card_id.in_(updated_card_ids)
    ).all()

    now = datetime.datetime.utcnow()
    yesterday = now - datetime.timedelta(hours=23)

    for item in wishlist_items:
        card = item.card
        if not card or card.price_market is None:
            continue

        # Don't spam - max once per 23 hours
        if item.notified_at and item.notified_at > yesterday:
            continue

        triggered = False
        alert_type = None

        if item.price_alert_above and card.price_market >= item.price_alert_above:
            triggered = True
            alert_type = "above"
        elif item.price_alert_below and card.price_market <= item.price_alert_below:
            triggered = True
            alert_type = "below"

        if triggered:
            threshold = item.price_alert_above if alert_type == "above" else item.price_alert_below
            telegram.send_price_alert(card.name, card.price_market, threshold, alert_type, db=db)
            item.notified_at = now

    db.commit()


def take_portfolio_snapshot(db: Session):
    """Take a daily portfolio value snapshot."""
    today = datetime.date.today()
    existing = db.query(PortfolioSnapshot).filter(PortfolioSnapshot.date == today).first()
    if existing:
        return  # Already done today

    # Calculate current portfolio value
    collection_items = db.query(CollectionItem).join(Card).all()
    total_value = sum(
        (item.card.price_market or 0) * item.quantity
        for item in collection_items
        if item.card
    )
    total_cards = sum(item.quantity for item in collection_items)
    total_cost = sum(
        (item.purchase_price or 0) * item.quantity
        for item in collection_items
    )

    snapshot = PortfolioSnapshot(
        date=today,
        total_value=total_value,
        total_cards=total_cards,
        total_cost=total_cost,
    )
    db.add(snapshot)
    db.commit()


def check_custom_card_matches(db: Session):
    """Check if any custom cards now have an equivalent card available via the TCGdex API.

    For each custom card that has both set_id and number:
    - Tries GET /cards/{set_id}-{number} on TCGdex.
    - If found and not already matched (pending/migrated), creates a CustomCardMatch
      and sends a Telegram notification.
    """
    custom_cards = db.query(Card).filter(Card.is_custom == True).all()
    if not custom_cards:
        return

    logger.info(f"Checking {len(custom_cards)} custom cards for API matches...")

    for card in custom_cards:
        if not card.set_id or not card.number:
            continue

        # Skip if already has a pending or migrated match
        existing_match = db.query(CustomCardMatch).filter(
            CustomCardMatch.custom_card_id == card.id,
            CustomCardMatch.status.in_(["pending", "migrated"]),
        ).first()
        if existing_match:
            continue

        api_card_id = f"{card.set_id}-{card.number}"
        try:
            api_card = pokemon_api.get_card(api_card_id, lang=_get_language(db))
            if api_card:
                match = CustomCardMatch(
                    custom_card_id=card.id,
                    api_card_id=api_card_id,
                    matched_at=datetime.datetime.utcnow(),
                    status="pending",
                )
                db.add(match)
                db.commit()

                set_name = card.set_id
                telegram.send_message(
                    f"🔄 Karte '<b>{card.name}</b>' ({set_name} #{card.number}) ist jetzt in der API verfügbar! "
                    f"Öffne die App um die Daten zu migrieren.",
                    db=db
                )
                logger.info(f"API match found for custom card '{card.id}' → '{api_card_id}'")
        except Exception as e:
            logger.warning(f"Failed to check API match for custom card {card.id}: {e}")


def perform_sync(db: Session) -> dict:
    """Perform a full sync cycle."""
    log = SyncLog(started_at=datetime.datetime.utcnow(), status="running")
    db.add(log)
    db.commit()

    cards_updated = 0
    sets_updated = 0
    updated_card_ids = []

    try:
        # 1. Sync all sets first
        lang = _get_language(db)
        logger.info("Syncing sets...")
        sets_data = pokemon_api.get_all_sets(display_lang=lang)
        known_set_ids = {s.id for s in db.query(Set.id).all()}

        for set_data in sets_data:
            parsed = pokemon_api.parse_set_for_db(set_data)
            # Inject lang from the _lang field (required for composite key format)
            parsed["lang"] = set_data.get("_lang", "en")
            is_new = parsed["id"] not in known_set_ids
            upsert_set(db, parsed)
            if is_new:
                # Mark as new
                s = db.query(Set).filter(Set.id == parsed["id"]).first()
                if s:
                    s.is_new = True
            sets_updated += 1

        db.commit()
        logger.info(f"Synced {sets_updated} sets")

        # 1b. Enrich sets that are missing release_date, logo or abbreviation
        #     Uses individual /sets/{id} calls (one-time cost ~140 calls on first sync)
        sets_needing_detail = db.query(Set).filter(Set.release_date == None).all()
        if sets_needing_detail:
            logger.info(f"Fetching detail for {len(sets_needing_detail)} sets missing release_date...")
            for s in sets_needing_detail:
                try:
                    # Use tcg_set_id for the TCGdex API call (not the composite DB key)
                    tcg_id = s.tcg_set_id or s.id
                    set_lang = s.lang or lang
                    detail = pokemon_api.get_set_detail(tcg_id, lang=set_lang)
                    if detail:
                        parsed = pokemon_api.parse_set_for_db(detail)
                        for key, value in parsed.items():
                            if key not in ("id", "tcg_set_id") and value is not None:
                                setattr(s, key, value)
                except Exception as e:
                    logger.warning(f"Failed to fetch detail for set {s.id}: {e}")
            db.commit()
            logger.info("Set detail enrichment complete")

        # 2. Sync collection cards (priority)
        collection_card_ids = [
            item.card_id for item in db.query(CollectionItem.card_id).all()
        ]
        wishlist_card_ids = [
            item.card_id for item in db.query(WishlistItem.card_id).all()
        ]

        priority_ids = list(set(collection_card_ids + wishlist_card_ids))
        logger.info(f"Syncing {len(priority_ids)} priority cards...")

        for card_id in priority_ids[:MAX_CARDS_PER_SYNC]:
            try:
                card_data = pokemon_api.get_card(card_id, lang=lang)
                if card_data:
                    parsed = pokemon_api.parse_card_for_db(card_data)
                    # Ensure set exists (check by tcg_set_id since set IDs are now composite)
                    if parsed.get("set_id"):
                        set_exists = db.query(Set).filter(
                            (Set.tcg_set_id == parsed["set_id"]) | (Set.id == parsed["set_id"])
                        ).first()
                        if not set_exists:
                            parsed["set_id"] = None
                    card = upsert_card(db, parsed)
                    record_price_history(db, card)
                    updated_card_ids.append(card_id)
                    cards_updated += 1
            except Exception as e:
                logger.warning(f"Failed to sync card {card_id}: {e}")

        db.commit()

        # 3. Check wishlist alerts
        check_wishlist_alerts(db, updated_card_ids)

        # 4. Take portfolio snapshot
        take_portfolio_snapshot(db)

        # 5. Check if any custom cards now have API equivalents
        try:
            check_custom_card_matches(db)
        except Exception as e:
            logger.warning(f"Custom card match check failed (non-fatal): {e}")

        # Update sync log
        log.finished_at = datetime.datetime.utcnow()
        log.cards_updated = cards_updated
        log.sets_updated = sets_updated
        log.status = "success"
        db.commit()

        logger.info(f"Sync complete: {cards_updated} cards, {sets_updated} sets updated")
        return {"cards_updated": cards_updated, "sets_updated": sets_updated, "status": "success"}

    except Exception as e:
        logger.error(f"Sync failed: {e}")
        log.finished_at = datetime.datetime.utcnow()
        log.status = "error"
        log.error_message = str(e)
        db.commit()
        raise
