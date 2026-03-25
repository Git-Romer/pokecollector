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
}


def _run_migrations(conn):
    """Apply any schema migrations that cannot be handled by create_all."""
    migrations = [
        # Add abbreviation column to sets table (safe — PostgreSQL IF NOT EXISTS)
        "ALTER TABLE sets ADD COLUMN IF NOT EXISTS abbreviation VARCHAR",
        # Add variant column to collection table
        "ALTER TABLE collection ADD COLUMN IF NOT EXISTS variant VARCHAR",
        # Add binder_type column to binders table
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS binder_type VARCHAR DEFAULT 'collection'",
        # Drop old unique constraint on card_id alone (if exists) and add new one
        # These are safe to fail if constraint doesn't exist / already dropped
        "ALTER TABLE collection DROP CONSTRAINT IF EXISTS uq_collection_card_id",
        # Add new unique constraint on (card_id, variant) — may fail if already exists
        """DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_collection_card_variant'
            ) THEN
                ALTER TABLE collection ADD CONSTRAINT uq_collection_card_variant UNIQUE (card_id, variant);
            END IF;
        END$$""",
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
        # v31: Drop old (card_id, variant) constraint and replace with (card_id, variant, lang)
        # This allows the same card to be collected in both DE and EN with the same variant
        "ALTER TABLE collection DROP CONSTRAINT IF EXISTS uq_collection_card_variant",
        """DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'uq_collection_card_variant_lang'
            ) THEN
                ALTER TABLE collection ADD CONSTRAINT uq_collection_card_variant_lang UNIQUE (card_id, variant, lang);
            END IF;
        END$$""",
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
        "ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE product_purchases ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)",
    ]
    for stmt in migrations:
        try:
            conn.execute(text(stmt))
            conn.commit()
        except Exception:
            conn.rollback()


def migrate_collection_variants():
    """Move rarity-like values out of collection.variant without creating key collisions."""
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

        existing_targets = {
            (row.card_id, row.lang, row.variant)
            for row in db.execute(text(f"""
                SELECT card_id, lang, variant
                FROM collection
                WHERE variant IS NOT NULL
                  AND variant NOT IN ({placeholders})
            """), params).fetchall()
        }

        migrated = 0
        skipped = 0
        reserved_targets = set()

        for row in rows:
            target_variant = None
            if row.variants_normal:
                target_variant = "Normal"
            elif row.variants_holo and not row.variants_normal:
                target_variant = "Holo"

            if target_variant is not None:
                target_key = (row.card_id, row.lang, target_variant)
                if target_key in existing_targets or target_key in reserved_targets:
                    skipped += 1
                    continue
                reserved_targets.add(target_key)

            db.execute(
                text("UPDATE collection SET variant = :variant WHERE id = :id"),
                {"id": row.id, "variant": target_variant},
            )
            migrated += 1

        db.commit()
        logger.info(
            "migrate_collection_variants: migrated %s row(s), skipped %s duplicate-conflicting row(s)",
            migrated,
            skipped,
        )
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
