import logging
import datetime
from sqlalchemy.orm import Session
from sqlalchemy import func
from models import Card, Set, CollectionItem, WishlistItem, PriceHistory, SyncLog, PortfolioSnapshot, CustomCardMatch, Setting, ProductPurchase, User
from services import pokemon_api, telegram

logger = logging.getLogger(__name__)

MAX_CARDS_PER_SYNC = 500  # TCGdex has no published rate limit; be reasonable


def _get_tcgdex_sync_languages(db: Session) -> list[str]:
    """Get TCGdex sync languages from settings."""
    row = db.query(Setting).filter(Setting.key == "tcgdex_sync_languages").first()
    raw_parts = [part.strip().lower() for part in (row.value if row else "en,de").split(",")]
    selected = [lang for lang in ("en", "de") if lang in raw_parts]
    return selected or ["en", "de"]


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
            telegram.send_price_alert(
                card.name, card.price_market, threshold, alert_type, db=db, user_id=item.user_id
            )
            item.notified_at = now

    db.commit()


def take_portfolio_snapshot(db: Session, user_id: int | None = None):
    """Insert one or more portfolio snapshots with the current UTC timestamp."""
    now = datetime.datetime.utcnow()

    if user_id is None:
        user_ids = [row.id for row in db.query(User.id).all()]
    else:
        user_ids = [user_id]

    for scoped_user_id in user_ids:
        collection_items = db.query(CollectionItem).join(Card).filter(
            CollectionItem.user_id == scoped_user_id
        ).all()
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
        products_cost = sum(
            product.purchase_price
            for product in db.query(ProductPurchase).filter(
                ProductPurchase.user_id == scoped_user_id,
                ProductPurchase.purchase_price.isnot(None),
                ProductPurchase.sold_price.is_(None),
            ).all()
        )

        snapshot = PortfolioSnapshot(
            date=now,
            user_id=scoped_user_id,
            total_value=total_value,
            total_cards=total_cards,
            total_cost=cards_cost + products_cost,
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

        card_lang = card.lang or "en"
        api_card_id = f"{card.set_id}-{card.number}"
        try:
            api_card = pokemon_api.get_card(api_card_id, lang=card_lang)
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


def perform_full_sync(db: Session) -> dict:
    """Perform a full sync cycle: sets + cards + prices."""
    log = SyncLog(started_at=datetime.datetime.utcnow(), status="running", sync_type="full")
    db.add(log)
    db.commit()

    cards_updated = 0
    sets_updated = 0
    updated_card_ids = []

    try:
        # 1. Sync all sets first
        sync_languages = _get_tcgdex_sync_languages(db)
        logger.info("Syncing sets for languages: %s", ", ".join(sync_languages))
        sets_data = pokemon_api.get_all_sets(languages=sync_languages)
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
                    set_lang = s.lang or "en"
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

        # 2a. Sync all cards for all known sets (full catalogue)
        sets_to_sync = db.query(Set).filter(Set.lang.in_(sync_languages)).all()
        logger.info(f"Syncing full card catalogue for {len(sets_to_sync)} sets...")
        for set_obj in sets_to_sync:
            tcg_id = set_obj.tcg_set_id or set_obj.id
            set_lang = set_obj.lang or "en"
            existing_card_count = db.query(Card).filter(
                Card.set_id == tcg_id, Card.lang == set_lang
            ).count()
            set_total = set_obj.total or 0
            if existing_card_count >= set_total and existing_card_count > 0:
                continue  # Already have all cards for this lang
            try:
                set_detail = pokemon_api.get_set_cards(tcg_id, lang=set_lang)
                cards_data = set_detail.get("cards", [])
                # Update set total if needed
                if cards_data and not set_obj.total:
                    set_obj.total = len(cards_data)
                for card_data in cards_data:
                    parsed = pokemon_api.parse_card_for_db(card_data, default_set_id=tcg_id, lang=set_lang)
                    upsert_card(db, parsed)
                db.commit()
            except Exception as e:
                logger.warning(f"Failed to sync cards for set {set_obj.id}: {e}")
                db.rollback()
        logger.info("Full card catalogue sync complete")

        # 3. Update prices for collection + wishlist cards
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
                tcg_id, card_lang = pokemon_api.strip_lang_suffix(card_id)
                card_data = pokemon_api.get_card(tcg_id, lang=card_lang)
                if card_data:
                    parsed = pokemon_api.parse_card_for_db(card_data, lang=card_lang)
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

        logger.info(f"Full sync complete: {cards_updated} cards, {sets_updated} sets updated")
        return {"cards_updated": cards_updated, "sets_updated": sets_updated, "status": "success"}

    except Exception as e:
        logger.error(f"Full sync failed: {e}")
        log.finished_at = datetime.datetime.utcnow()
        log.status = "error"
        log.error_message = str(e)
        db.commit()
        raise


def perform_price_sync(db: Session) -> dict:
    """Perform a price-only sync: update prices for collection + wishlist cards."""
    log = SyncLog(started_at=datetime.datetime.utcnow(), status="running", sync_type="price")
    db.add(log)
    db.commit()

    cards_updated = 0
    updated_card_ids = []

    try:
        collection_card_ids = [
            item.card_id for item in db.query(CollectionItem.card_id).all()
        ]
        wishlist_card_ids = [
            item.card_id for item in db.query(WishlistItem.card_id).all()
        ]

        priority_ids = list(set(collection_card_ids + wishlist_card_ids))
        logger.info(f"Price sync: updating prices for {len(priority_ids)} cards...")

        for card_id in priority_ids[:MAX_CARDS_PER_SYNC]:
            try:
                tcg_id, card_lang = pokemon_api.strip_lang_suffix(card_id)
                card_data = pokemon_api.get_card(tcg_id, lang=card_lang)
                if card_data:
                    parsed = pokemon_api.parse_card_for_db(card_data, lang=card_lang)
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

        # Check wishlist alerts
        check_wishlist_alerts(db, updated_card_ids)

        # Take portfolio snapshot
        take_portfolio_snapshot(db)

        # Update sync log
        log.finished_at = datetime.datetime.utcnow()
        log.cards_updated = cards_updated
        log.sets_updated = 0
        log.status = "success"
        db.commit()

        logger.info(f"Price sync complete: {cards_updated} cards updated")
        return {"cards_updated": cards_updated, "sets_updated": 0, "status": "success"}

    except Exception as e:
        logger.error(f"Price sync failed: {e}")
        log.finished_at = datetime.datetime.utcnow()
        log.status = "error"
        log.error_message = str(e)
        db.commit()
        raise


def perform_sync(db: Session) -> dict:
    """Alias for perform_full_sync (backward compatibility)."""
    return perform_full_sync(db)
