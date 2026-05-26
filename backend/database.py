import logging
import os

from sqlalchemy import create_engine, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://pokemon:changeme@localhost:5432/pokemon_tcg"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=10, max_overflow=20)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()
logger = logging.getLogger(__name__)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


DEFAULT_SETTINGS = {
    "language": "de",
    "price_display": '["trend", "avg1", "avg7", "avg30", "low"]',
    "price_primary": "trend",
    "multi_user_mode": "false",
    "tcgdex_sync_languages": "en,de",
    "cross_language_price_fallback": "true",
    "cross_language_image_fallback": "true",
    "debug_mode": "false",
}


def _normalize_tcgdex_sync_languages(value: str | None) -> str:
    """Normalize configured TCGdex sync languages to a stable CSV string."""
    allowed = ("en", "de")
    raw_parts = []
    if value:
        raw_parts = [part.strip().lower() for part in str(value).split(",")]

    selected = []
    for lang in allowed:
        if lang in raw_parts and lang not in selected:
            selected.append(lang)

    if not selected:
        selected = list(allowed)

    return ",".join(selected)


def _run_migrations(conn):
    """Apply any schema migrations that cannot be handled by create_all."""
    migrations = [
        # Add abbreviation column to sets table (safe — PostgreSQL IF NOT EXISTS)
        "ALTER TABLE sets ADD COLUMN IF NOT EXISTS abbreviation VARCHAR",
        # Add variant column to collection table
        "ALTER TABLE collection ADD COLUMN IF NOT EXISTS variant VARCHAR",
        # Add binder_type column to binders table
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS binder_type VARCHAR DEFAULT 'collection'",
        # Drop old collection uniqueness constraints that did not include user,
        # condition, or purchase price and treated NULL variants specially.
        "ALTER TABLE collection DROP CONSTRAINT IF EXISTS uq_collection_card_id",
        "ALTER TABLE collection DROP CONSTRAINT IF EXISTS uq_collection_card_variant",
        # Add is_custom column to cards table
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS is_custom BOOLEAN DEFAULT FALSE",
        # Create custom_card_matches table if it doesn't exist (handled by create_all, belt+suspenders)
        """CREATE TABLE IF NOT EXISTS custom_card_matches (
            id SERIAL PRIMARY KEY,
            custom_card_id VARCHAR NOT NULL REFERENCES cards(id),
            api_card_id VARCHAR NOT NULL,
            matched_at TIMESTAMP DEFAULT NOW(),
            status VARCHAR DEFAULT 'pending'
        )""",
        """CREATE TABLE IF NOT EXISTS image_cache (
            id SERIAL PRIMARY KEY,
            image_key VARCHAR UNIQUE NOT NULL,
            data BYTEA NOT NULL,
            content_type VARCHAR DEFAULT 'image/webp',
            cached_at TIMESTAMP DEFAULT NOW()
        )""",
        "CREATE INDEX IF NOT EXISTS idx_image_cache_key ON image_cache(image_key)",
        # v31: Add lang column to collection table (fixed card language per item)
        "ALTER TABLE collection ADD COLUMN IF NOT EXISTS lang VARCHAR DEFAULT 'en'",
        # v31: Add lang column to sets table (tracks which language APIs have this set)
        "ALTER TABLE sets ADD COLUMN IF NOT EXISTS lang VARCHAR DEFAULT 'en'",
        # v31/v48: Drop old broad (card_id, variant, lang) uniqueness. Collection
        # grouping now also depends on user, condition, and purchase price, so a
        # broad DB constraint would block valid separate collection rows.
        "ALTER TABLE collection DROP CONSTRAINT IF EXISTS uq_collection_card_variant",
        "ALTER TABLE collection DROP CONSTRAINT IF EXISTS uq_collection_card_variant_lang",
        # v48: Normalize missing/base prints and trim existing variant labels.
        "UPDATE collection SET variant = COALESCE(NULLIF(btrim(variant), ''), 'Normal')",
        "ALTER TABLE collection ALTER COLUMN variant SET DEFAULT 'Normal'",
        "ALTER TABLE collection ALTER COLUMN variant SET NOT NULL",
        # v32: Add grade column to collection table (PSA/BGS/CGC grade)
        "ALTER TABLE collection ADD COLUMN IF NOT EXISTS grade VARCHAR DEFAULT 'raw'",
        # v32: Add ebay_app_id to settings table
        "ALTER TABLE settings ADD COLUMN IF NOT EXISTS ebay_app_id VARCHAR",
        # v41: Add Pokemon avatar selection to users
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id INTEGER",
        # v36: Add tcg_set_id column to sets (original TCGdex ID, separate from composite DB key)
        "ALTER TABLE sets ADD COLUMN IF NOT EXISTS tcg_set_id VARCHAR",
        # v36: Populate tcg_set_id for old-format rows (id has no lang suffix)
        """UPDATE sets SET tcg_set_id = id
           WHERE tcg_set_id IS NULL
             AND id NOT LIKE '%_de'
             AND id NOT LIKE '%_en'""",
        # v36: Drop FK constraint on cards.set_id so sets can use composite key format
        "ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_set_id_fkey",
        # v36: Delete old merged sets (lang='both') and old single-lang sets without
        #      composite-key format so they get re-fetched in the new format.
        #      Only delete if no composite-key sets exist yet (first migration run).
        """DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM sets
                WHERE id LIKE '%_de' OR id LIKE '%_en'
                LIMIT 1
            ) THEN
                DELETE FROM sets;
            ELSE
                -- Remove old non-composite sets (lang='both' or plain ID format)
                DELETE FROM sets
                WHERE lang = 'both'
                   OR (id NOT LIKE '%_de' AND id NOT LIKE '%_en');
            END IF;
        END$$""",
        # v38: Add release_date column to sets table
        "ALTER TABLE sets ADD COLUMN IF NOT EXISTS release_date VARCHAR",
        # v39: Add tcg_card_id column to cards table (original TCGdex ID, separate from composite DB key)
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS tcg_card_id VARCHAR",
        # v40: Add Cardmarket holo price columns
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_market_holo FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_low_holo FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_trend_holo FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_avg1_holo FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_avg7_holo FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_avg30_holo FLOAT",
        # v40: Add TCGPlayer price columns
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_normal_low FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_normal_mid FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_normal_high FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_normal_market FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_reverse_low FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_reverse_mid FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_reverse_market FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_holo_low FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_holo_mid FLOAT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_tcg_holo_market FLOAT",
        # v40: Add variant boolean columns
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS variants_normal BOOLEAN",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS variants_reverse BOOLEAN",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS variants_holo BOOLEAN",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS variants_first_edition BOOLEAN",
        # v41: Change portfolio_snapshots.date from Date to Timestamp (store full UTC datetime)
        # and drop the unique constraint so multiple snapshots per day are allowed
        "ALTER TABLE portfolio_snapshots ALTER COLUMN date TYPE TIMESTAMP USING date::TIMESTAMP",
        "ALTER TABLE portfolio_snapshots DROP CONSTRAINT IF EXISTS portfolio_snapshots_date_key",
        # v42: Add multi-user authentication tables and scoped ownership columns
        """CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR UNIQUE NOT NULL,
            hashed_password VARCHAR NOT NULL,
            role VARCHAR DEFAULT 'trainer',
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW()
        )""",
        "ALTER TABLE collection ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "CREATE INDEX IF NOT EXISTS idx_collection_grouping ON collection (user_id, card_id, variant, lang, condition, purchase_price)",
        "ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE wishlist DROP CONSTRAINT IF EXISTS wishlist_card_id_key",
        "ALTER TABLE wishlist DROP CONSTRAINT IF EXISTS uq_wishlist_card_id",
        """DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_wishlist_user_card'
            ) THEN
                ALTER TABLE wishlist ADD CONSTRAINT uq_wishlist_user_card UNIQUE (user_id, card_id);
            END IF;
        END$$""",
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE product_purchases ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false",
        # v43: Track when card prices/images/data are copied from another language.
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS price_source_lang VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS image_source_lang VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS data_source_lang VARCHAR",
        # v44: Track price sync attempts independently from general card updates.
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_price_sync_attempt_at TIMESTAMP",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_price_sync_success_at TIMESTAMP",
        # v45: Manual temporary card image fallback while TCGdex has no image.
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS custom_image_url VARCHAR",
        # v46: Binder icons and exact collection-item binder entries.
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS icon_pokemon_id INTEGER",
        "ALTER TABLE binder_cards ADD COLUMN IF NOT EXISTS collection_item_id INTEGER REFERENCES collection(id)",
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS format VARCHAR",
        "ALTER TABLE binder_cards ADD COLUMN IF NOT EXISTS required_quantity INTEGER DEFAULT 1",
        # v47: Store gameplay data for playable-equivalent print matching.
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS stage VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS evolve_from VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS suffix VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS trainer_type VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS energy_type VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS card_effect VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS regulation_mark VARCHAR",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS attacks JSON",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS abilities JSON",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS weaknesses JSON",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS resistances JSON",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS retreat INTEGER",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS playable_fingerprint VARCHAR",
        "CREATE INDEX IF NOT EXISTS idx_cards_playable_fingerprint ON cards(playable_fingerprint)",
        "UPDATE binder_cards SET required_quantity = 1 WHERE required_quantity IS NULL",
        """UPDATE binder_cards
           SET required_quantity = 1
           FROM binders
           WHERE binder_cards.binder_id = binders.id
             AND binder_cards.collection_item_id IS NOT NULL
             AND (binders.binder_type = 'collection' OR binders.binder_type IS NULL)""",
        "ALTER TABLE binder_cards DROP CONSTRAINT IF EXISTS uq_binder_card",
        """DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_binder_collection_item'
            ) THEN
                ALTER TABLE binder_cards ADD CONSTRAINT uq_binder_collection_item UNIQUE (binder_id, collection_item_id);
            END IF;
        END$$""",
    ]
    for stmt in migrations:
        try:
            conn.execute(text(stmt))
            conn.commit()
        except Exception:
            conn.rollback()


def migrate_collection_variants():
    """Move rarity-like values out of collection.variant into explicit physical variants."""
    rarity_values = (
        "Double Rare", "Full Art", "Alt Art", "Gold", "Rainbow",
        "Illustration Rare", "Special Illustration Rare", "Crown Rare",
        "Promo", "Art Rare", "Ultra Rare", "Secret Rare", "Shiny",
    )
    placeholders = ",".join([f":v{i}" for i in range(len(rarity_values))])
    params = {f"v{i}": value for i, value in enumerate(rarity_values)}

    db = SessionLocal()
    try:
        rows = db.execute(text(f"""
            SELECT
                c.id,
                c.card_id,
                c.lang,
                c.variant,
                cards.variants_holo,
                cards.variants_normal,
                cards.variants_reverse
            FROM collection c
            LEFT JOIN cards ON cards.id = c.card_id
            WHERE c.variant IN ({placeholders})
            ORDER BY c.id
        """), params).fetchall()

        if not rows:
            return

        migrated = 0

        for row in rows:
            target_variant = "Normal"
            if row.variants_holo and not row.variants_normal:
                target_variant = "Holo"

            db.execute(
                text("UPDATE collection SET variant = :variant WHERE id = :id"),
                {"id": row.id, "variant": target_variant},
            )
            migrated += 1

        db.commit()
        logger.info("migrate_collection_variants: migrated %s row(s)", migrated)
    except Exception as e:
        db.rollback()
        logger.warning("migrate_collection_variants: migration aborted: %s", e)
    finally:
        db.close()


def migrate_card_ids():
    """Migrate card IDs from plain TCGdex format (e.g. 'sv1-1') to composite format (e.g. 'sv1-1_de').

    This migration is idempotent — safe to run multiple times.
    Custom cards (is_custom=True) are skipped.
    """
    import logging
    from sqlalchemy import text as sql_text
    logger = logging.getLogger(__name__)

    db = SessionLocal()
    try:
        # Step 1: Find non-custom cards with old-format IDs (not ending in _en or _de)
        rows = db.execute(sql_text(
            "SELECT id, lang FROM cards "
            "WHERE (is_custom IS NULL OR is_custom = FALSE) "
            "AND id NOT LIKE '%\\_en' AND id NOT LIKE '%\\_de'"
        )).fetchall()

        if rows:
            logger.info(f"migrate_card_ids: migrating {len(rows)} card(s) to composite IDs...")

        for row in rows:
            old_id = row[0]
            lang = row[1] or "en"
            new_id = f"{old_id}_{lang}"
            try:
                # Update all FK references atomically, then the card itself
                db.execute(sql_text(
                    "UPDATE collection SET card_id = :new_id WHERE card_id = :old_id"
                ), {"new_id": new_id, "old_id": old_id})
                db.execute(sql_text(
                    "UPDATE wishlist SET card_id = :new_id WHERE card_id = :old_id"
                ), {"new_id": new_id, "old_id": old_id})
                db.execute(sql_text(
                    "UPDATE price_history SET card_id = :new_id WHERE card_id = :old_id"
                ), {"new_id": new_id, "old_id": old_id})
                db.execute(sql_text(
                    "UPDATE binder_cards SET card_id = :new_id WHERE card_id = :old_id"
                ), {"new_id": new_id, "old_id": old_id})
                db.execute(sql_text(
                    "UPDATE custom_card_matches SET custom_card_id = :new_id WHERE custom_card_id = :old_id"
                ), {"new_id": new_id, "old_id": old_id})
                db.execute(sql_text(
                    "UPDATE cards SET id = :new_id, tcg_card_id = :old_id WHERE id = :old_id"
                ), {"new_id": new_id, "old_id": old_id})
                db.commit()
            except Exception as e:
                db.rollback()
                logger.warning(f"migrate_card_ids: failed to migrate card '{old_id}': {e}")

        # Step 2: Backfill tcg_card_id for already-composite cards that have NULL tcg_card_id
        composite_rows = db.execute(sql_text(
            "SELECT id FROM cards "
            "WHERE tcg_card_id IS NULL "
            "AND (is_custom IS NULL OR is_custom = FALSE) "
            "AND (id LIKE '%\\_en' OR id LIKE '%\\_de')"
        )).fetchall()

        for row in composite_rows:
            composite_id = row[0]
            # Strip _en or _de suffix
            for suffix in ("_en", "_de"):
                if composite_id.endswith(suffix):
                    tcg_card_id = composite_id[:-len(suffix)]
                    break
            else:
                continue
            try:
                db.execute(sql_text(
                    "UPDATE cards SET tcg_card_id = :tcg_id WHERE id = :id"
                ), {"tcg_id": tcg_card_id, "id": composite_id})
                db.commit()
            except Exception as e:
                db.rollback()
                logger.warning(f"migrate_card_ids: failed to backfill tcg_card_id for '{composite_id}': {e}")

        if rows or composite_rows:
            logger.info("migrate_card_ids: migration complete")

    except Exception as e:
        db.rollback()
        import logging as _logging
        _logging.getLogger(__name__).warning(f"migrate_card_ids: migration aborted: {e}")
    finally:
        db.close()


def init_db():
    """Initialize the database: create tables, run migrations, seed settings."""
    from models import Base as ModelBase, Setting, User
    ModelBase.metadata.create_all(bind=engine)

    # Run lightweight schema migrations (idempotent, PostgreSQL only)
    try:
        with engine.connect() as conn:
            _run_migrations(conn)
    except Exception:
        pass  # Non-blocking — may not be needed on fresh installs

    # Migrate card IDs to composite format (idempotent)
    try:
        migrate_card_ids()
    except Exception:
        pass  # Non-blocking

    # Migrate old rarity-like variant values to physical variants (idempotent)
    try:
        migrate_collection_variants()
    except Exception:
        pass  # Non-blocking

    # Initialize default settings (INSERT IF NOT EXISTS)
    db = SessionLocal()
    try:
        for key, value in DEFAULT_SETTINGS.items():
            existing = db.query(Setting).filter(Setting.key == key).first()
            if not existing:
                if key == "tcgdex_sync_languages":
                    value = _normalize_tcgdex_sync_languages(
                        os.environ.get("TCGDEX_SYNC_LANGUAGES", value)
                    )
                db.add(Setting(key=key, value=str(value)))
        db.commit()
    except Exception:
        db.rollback()
    # v42: Migrate per-user settings from global to admin user
    try:
        from models import UserSetting
        admin = db.query(User).filter(User.role == "admin").first()
        if admin:
            per_user_keys = {
                "language", "currency", "price_primary", "price_display",
                "telegram_bot_token", "telegram_chat_id", "telegram_enabled",
                "price_alerts_enabled", "price_alert_threshold",
                "gemini_api_key", "trainer_name",
            }
            for key in per_user_keys:
                existing_user_setting = db.query(UserSetting).filter(
                    UserSetting.user_id == admin.id, UserSetting.key == key
                ).first()
                if existing_user_setting:
                    continue
                global_row = db.query(Setting).filter(Setting.key == key).first()
                if global_row:
                    db.add(UserSetting(user_id=admin.id, key=key, value=global_row.value))
                elif key == "telegram_bot_token":
                    val = os.environ.get("TELEGRAM_BOT_TOKEN", "")
                    if val:
                        db.add(UserSetting(user_id=admin.id, key=key, value=val))
                elif key == "telegram_chat_id":
                    val = os.environ.get("TELEGRAM_CHAT_ID", "")
                    if val:
                        db.add(UserSetting(user_id=admin.id, key=key, value=val))
                elif key == "gemini_api_key":
                    val = os.environ.get("GEMINI_API_KEY", "")
                    if val:
                        db.add(UserSetting(user_id=admin.id, key=key, value=val))
            db.commit()
    except Exception as e:
        db.rollback()
        logger.warning("User settings migration: %s", e)
    finally:
        db.close()


def get_setting(key: str, default=None):
    """Get a single setting value from the database."""
    db = SessionLocal()
    try:
        from models import Setting
        row = db.query(Setting).filter(Setting.key == key).first()
        return row.value if row else default
    finally:
        db.close()


def save_setting(key: str, value):
    """Create or update a single setting value in the database."""
    db = SessionLocal()
    try:
        from models import Setting
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = str(value)
        else:
            db.add(Setting(key=key, value=str(value)))
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
