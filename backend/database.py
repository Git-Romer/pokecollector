import logging
import os

from sqlalchemy import create_engine, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from services.tcgdex_languages import (
    SUPPORTED_TCGDEX_LANGUAGES,
    has_lang_suffix,
    normalize_tcgdex_sync_languages,
    strip_lang_suffix,
)

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
    "language": "en",
    "price_display": '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
    "price_primary": "trend",
    "portfolio_display_mode": "portfolio_value",
    "multi_user_mode": "false",
    "tcgdex_sync_languages": "en,de",
    "tcgdex_digital_sets_enabled": "true",
    "cross_language_price_fallback": "true",
    "cross_language_image_fallback": "true",
    "debug_mode": "false",
}


def _normalize_tcgdex_sync_languages(value: str | None) -> str:
    """Normalize configured TCGdex sync languages to a stable CSV string."""
    return normalize_tcgdex_sync_languages(value)


def _lang_suffix_regex(column: str = "id") -> str:
    pattern = "_(" + "|".join(lang.replace("-", "\\-") for lang in SUPPORTED_TCGDEX_LANGUAGES) + ")$"
    return f"{column} ~ '{pattern}'"


def _run_migrations(conn):
    """Apply any schema migrations that cannot be handled by create_all."""
    migrations = [
        # Enable accent-insensitive text search on PostgreSQL when permissions allow it.
        # If this fails (for example on restricted hosted DBs), search falls back to
        # portable application-defined normalization in services/text_search.py.
        "CREATE EXTENSION IF NOT EXISTS unaccent",
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
        "ALTER TABLE sets ADD COLUMN IF NOT EXISTS is_digital BOOLEAN DEFAULT FALSE",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS is_digital BOOLEAN DEFAULT FALSE",
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
        f"""UPDATE sets SET tcg_set_id = id
           WHERE tcg_set_id IS NULL
             AND NOT ({_lang_suffix_regex('id')})""",
        # v36: Drop FK constraint on cards.set_id so sets can use composite key format
        "ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_set_id_fkey",
        # v36: Delete old merged sets (lang='both') and old single-lang sets without
        #      composite-key format so they get re-fetched in the new format.
        #      Only delete if no composite-key sets exist yet (first migration run).
        f"""DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM sets
                WHERE {_lang_suffix_regex('id')}
                LIMIT 1
            ) THEN
                DELETE FROM sets;
            ELSE
                -- Remove old non-composite sets (lang='both' or plain ID format)
                DELETE FROM sets
                WHERE lang = 'both'
                   OR NOT ({_lang_suffix_regex('id')});
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
        "ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1",
        "UPDATE wishlist SET quantity = 1 WHERE quantity IS NULL OR quantity < 1",
        "UPDATE wishlist SET quantity = 99 WHERE quantity > 99",
        "ALTER TABLE wishlist ALTER COLUMN quantity SET DEFAULT 1",
        "ALTER TABLE wishlist ALTER COLUMN quantity SET NOT NULL",
        "ALTER TABLE wishlist DROP CONSTRAINT IF EXISTS ck_wishlist_quantity_range",
        "ALTER TABLE wishlist ADD CONSTRAINT ck_wishlist_quantity_range CHECK (quantity >= 1 AND quantity <= 99)",
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
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS auto_owned_set_id VARCHAR",
        """CREATE UNIQUE INDEX IF NOT EXISTS uq_binders_user_auto_owned_set
           ON binders(user_id, auto_owned_set_id)
           WHERE auto_owned_set_id IS NOT NULL""",
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
        # v52: National Pokédex mappings and exact Cardmarket products.
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS dex_ids JSONB",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS cardmarket_products JSONB",
        "ALTER TABLE cards ALTER COLUMN dex_ids TYPE JSONB USING dex_ids::jsonb",
        "ALTER TABLE cards ALTER COLUMN cardmarket_products TYPE JSONB USING cardmarket_products::jsonb",
        "UPDATE cards SET dex_ids = NULL WHERE dex_ids = 'null'::jsonb",
        "UPDATE cards SET cardmarket_products = NULL WHERE cardmarket_products = 'null'::jsonb",
        "CREATE INDEX IF NOT EXISTS idx_cards_dex_ids ON cards USING GIN (dex_ids)",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS retreat INTEGER",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS playable_fingerprint VARCHAR",
        "CREATE INDEX IF NOT EXISTS idx_cards_playable_fingerprint ON cards(playable_fingerprint)",
        "UPDATE binder_cards SET required_quantity = 1 WHERE required_quantity IS NULL",
        "UPDATE binder_cards SET required_quantity = 1 WHERE required_quantity < 1",
        "UPDATE binder_cards SET required_quantity = 99 WHERE required_quantity > 99",
        "ALTER TABLE binder_cards ALTER COLUMN required_quantity SET DEFAULT 1",
        "ALTER TABLE binder_cards ALTER COLUMN required_quantity SET NOT NULL",
        """DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ck_binder_card_quantity_range'
            ) THEN
                ALTER TABLE binder_cards ADD CONSTRAINT ck_binder_card_quantity_range
                    CHECK (required_quantity >= 1 AND required_quantity <= 99);
            END IF;
        END$$""",
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
        # v50: Product card ledger for dynamic product valuation and durable sold-card history.
        """CREATE TABLE IF NOT EXISTS product_cards (
            id SERIAL PRIMARY KEY,
            product_id INTEGER NOT NULL REFERENCES product_purchases(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id),
            card_id VARCHAR REFERENCES cards(id) ON DELETE SET NULL,
            collection_item_id INTEGER,
            initial_quantity INTEGER NOT NULL DEFAULT 1,
            active_quantity INTEGER NOT NULL DEFAULT 1,
            sold_quantity INTEGER NOT NULL DEFAULT 0,
            condition VARCHAR DEFAULT 'NM',
            variant VARCHAR NOT NULL DEFAULT 'Normal',
            lang VARCHAR DEFAULT 'en',
            purchase_price FLOAT,
            linked_at TIMESTAMP DEFAULT NOW(),
            CHECK (initial_quantity >= 1),
            CHECK (active_quantity >= 0),
            CHECK (sold_quantity >= 0),
            CHECK (active_quantity + sold_quantity <= initial_quantity)
        )""",
        """CREATE TABLE IF NOT EXISTS product_ledger_entries (
            id SERIAL PRIMARY KEY,
            product_card_id INTEGER REFERENCES product_cards(id) ON DELETE SET NULL,
            product_id INTEGER NOT NULL REFERENCES product_purchases(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id),
            entry_type VARCHAR NOT NULL DEFAULT 'card_sale',
            card_id VARCHAR REFERENCES cards(id) ON DELETE SET NULL,
            original_collection_item_id INTEGER,
            quantity INTEGER NOT NULL DEFAULT 1,
            amount FLOAT NOT NULL,
            event_date DATE NOT NULL,
            product_name VARCHAR,
            card_name VARCHAR,
            set_id VARCHAR,
            card_number VARCHAR,
            variant VARCHAR,
            condition VARCHAR,
            lang VARCHAR,
            notes TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            CHECK (quantity >= 1),
            CHECK (amount >= 0),
            CHECK (entry_type IN ('card_sale', 'flat_gain', 'adjustment', 'trade_out'))
        )""",
        "CREATE INDEX IF NOT EXISTS idx_product_cards_product_user ON product_cards(product_id, user_id)",
        "CREATE INDEX IF NOT EXISTS idx_product_cards_collection_item ON product_cards(collection_item_id)",
        "CREATE INDEX IF NOT EXISTS idx_product_ledger_product_user ON product_ledger_entries(product_id, user_id)",
        "ALTER TABLE product_cards DROP CONSTRAINT IF EXISTS product_cards_card_id_fkey",
        "ALTER TABLE product_cards ALTER COLUMN card_id DROP NOT NULL",
        "ALTER TABLE product_cards ADD CONSTRAINT product_cards_card_id_fkey FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE SET NULL",
        "ALTER TABLE product_ledger_entries DROP CONSTRAINT IF EXISTS product_ledger_entries_card_id_fkey",
        "ALTER TABLE product_ledger_entries ADD CONSTRAINT product_ledger_entries_card_id_fkey FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE SET NULL",
        "ALTER TABLE product_ledger_entries ADD COLUMN IF NOT EXISTS product_name VARCHAR",
        "ALTER TABLE product_ledger_entries ADD COLUMN IF NOT EXISTS card_name VARCHAR",
        "ALTER TABLE product_ledger_entries ADD COLUMN IF NOT EXISTS set_id VARCHAR",
        "ALTER TABLE product_ledger_entries ADD COLUMN IF NOT EXISTS card_number VARCHAR",
        "ALTER TABLE product_ledger_entries DROP CONSTRAINT IF EXISTS ck_product_ledger_entry_type",
        "ALTER TABLE product_ledger_entries DROP CONSTRAINT IF EXISTS product_ledger_entries_entry_type_check",
        "ALTER TABLE product_ledger_entries ADD CONSTRAINT ck_product_ledger_entry_type CHECK (entry_type IN ('card_sale', 'flat_gain', 'adjustment', 'trade_out'))",
        # v51: Trade logger with durable value snapshots.
        """CREATE TABLE IF NOT EXISTS trades (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            partner_name VARCHAR,
            trade_date DATE NOT NULL,
            notes TEXT,
            outgoing_value FLOAT NOT NULL DEFAULT 0,
            incoming_value FLOAT NOT NULL DEFAULT 0,
            value_delta FLOAT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            CHECK (outgoing_value >= 0),
            CHECK (incoming_value >= 0)
        )""",
        """CREATE TABLE IF NOT EXISTS trade_items (
            id SERIAL PRIMARY KEY,
            trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id),
            direction VARCHAR NOT NULL,
            card_id VARCHAR REFERENCES cards(id) ON DELETE SET NULL,
            original_collection_item_id INTEGER,
            created_collection_item_id INTEGER,
            product_card_id INTEGER,
            quantity INTEGER NOT NULL DEFAULT 1,
            value_per_card FLOAT NOT NULL DEFAULT 0,
            value_total FLOAT NOT NULL DEFAULT 0,
            card_name VARCHAR,
            set_id VARCHAR,
            card_number VARCHAR,
            variant VARCHAR,
            condition VARCHAR,
            lang VARCHAR,
            notes TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            CHECK (direction IN ('outgoing', 'incoming')),
            CHECK (quantity >= 1),
            CHECK (value_per_card >= 0),
            CHECK (value_total >= 0)
        )""",
        "CREATE INDEX IF NOT EXISTS idx_trades_user_date ON trades(user_id, trade_date DESC, id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_trade_items_trade ON trade_items(trade_id)",
        "CREATE INDEX IF NOT EXISTS idx_trade_items_user_card ON trade_items(user_id, card_id)",
        "ALTER TABLE trade_items DROP CONSTRAINT IF EXISTS trade_items_card_id_fkey",
        "ALTER TABLE trade_items ALTER COLUMN card_id DROP NOT NULL",
        "ALTER TABLE trade_items ADD CONSTRAINT trade_items_card_id_fkey FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE SET NULL",
        # v52: Exact inventory and product-ledger provenance for atomic trade edits.
        "ALTER TABLE trade_items ADD COLUMN IF NOT EXISTS purchase_price FLOAT",
        "ALTER TABLE trade_items ADD COLUMN IF NOT EXISTS snapshot_version INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE trade_items DROP CONSTRAINT IF EXISTS ck_trade_items_purchase_price_non_negative",
        "ALTER TABLE trade_items ADD CONSTRAINT ck_trade_items_purchase_price_non_negative CHECK (purchase_price IS NULL OR purchase_price >= 0)",
        "ALTER TABLE trade_items DROP CONSTRAINT IF EXISTS ck_trade_items_snapshot_version_non_negative",
        "ALTER TABLE trade_items ADD CONSTRAINT ck_trade_items_snapshot_version_non_negative CHECK (snapshot_version >= 0)",
        "ALTER TABLE product_ledger_entries ADD COLUMN IF NOT EXISTS trade_item_id INTEGER",
        "ALTER TABLE product_ledger_entries DROP CONSTRAINT IF EXISTS product_ledger_entries_trade_item_id_fkey",
        "ALTER TABLE product_ledger_entries ADD CONSTRAINT product_ledger_entries_trade_item_id_fkey FOREIGN KEY (trade_item_id) REFERENCES trade_items(id) ON DELETE SET NULL",
        "CREATE INDEX IF NOT EXISTS idx_product_ledger_trade_item ON product_ledger_entries(trade_item_id)",
        # v53: Versioned combined card and sealed-product portfolio snapshots.
        # Existing rows remain calculation_version=1 and retain their historical values.
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS calculation_version INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS cards_value FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS products_value FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS cards_cost FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS products_cost FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS performance_cost_basis FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS realized_value FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS unrealized_pnl FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS realized_pnl FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS total_pnl FLOAT",
        "ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS product_value_fallback_count INTEGER",
        "CREATE INDEX IF NOT EXISTS ix_product_purchases_user_id ON product_purchases(user_id)",
        "CREATE INDEX IF NOT EXISTS ix_portfolio_snapshots_user_date ON portfolio_snapshots(user_id, date)",
        # v54: Explicit product lifecycle. Legacy products without enough
        # provenance are held for review instead of being assumed sealed.
        "ALTER TABLE product_purchases ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR",
        """UPDATE product_purchases
           SET lifecycle_status = CASE
               WHEN EXISTS (
                   SELECT 1 FROM product_cards
                   WHERE product_cards.product_id = product_purchases.id
               ) OR EXISTS (
                   SELECT 1 FROM product_ledger_entries
                   WHERE product_ledger_entries.product_id = product_purchases.id
               ) THEN 'opened'
               WHEN sold_price IS NOT NULL THEN 'sold'
               ELSE 'review'
           END
           WHERE lifecycle_status IS NULL""",
        "ALTER TABLE product_purchases ALTER COLUMN lifecycle_status SET DEFAULT 'sealed'",
        "ALTER TABLE product_purchases ALTER COLUMN lifecycle_status SET NOT NULL",
        "ALTER TABLE product_purchases DROP CONSTRAINT IF EXISTS ck_product_purchases_lifecycle_status",
        "ALTER TABLE product_purchases ADD CONSTRAINT ck_product_purchases_lifecycle_status CHECK (lifecycle_status IN ('sealed', 'opened', 'sold', 'review'))",
        # v55: Batch-created products remain independent while retaining their
        # shared creation group for convenient presentation.
        "ALTER TABLE product_purchases ADD COLUMN IF NOT EXISTS batch_id VARCHAR",
        "CREATE INDEX IF NOT EXISTS ix_product_purchases_user_batch ON product_purchases(user_id, batch_id)",
        # v56: Optional manual imagery and Cardmarket references for sealed products.
        "ALTER TABLE product_purchases ADD COLUMN IF NOT EXISTS image_url VARCHAR",
        "ALTER TABLE product_purchases ADD COLUMN IF NOT EXISTS cardmarket_url VARCHAR",
        """UPDATE sets
           SET is_digital = TRUE
           WHERE COALESCE(is_digital, FALSE) = FALSE
             AND (
               lower(COALESCE(series, '')) LIKE '%pocket%'
               OR COALESCE(images_logo, '') LIKE '%/tcgp/%'
               OR COALESCE(images_symbol, '') LIKE '%/tcgp/%'
             )""",
        """UPDATE cards
           SET is_digital = TRUE
           WHERE COALESCE(is_digital, FALSE) = FALSE
             AND EXISTS (
               SELECT 1 FROM sets
               WHERE sets.is_digital = TRUE
                 AND sets.tcg_set_id = cards.set_id
                 AND sets.lang = cards.lang
             )""",
        # Public binders feature: user profile sharing settings
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS public_handle VARCHAR",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_public_handle ON users (public_handle)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_profile_public BOOLEAN DEFAULT FALSE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS public_show_values BOOLEAN DEFAULT FALSE",
        "ALTER TABLE binders ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE",
        "ALTER TABLE scan_job_items ADD COLUMN IF NOT EXISTS selected_card_id VARCHAR",
        # Enforce NOT NULL on new boolean columns for upgraded installs (ADD COLUMN with DEFAULT backfills existing rows first)
        "ALTER TABLE users ALTER COLUMN is_profile_public SET NOT NULL",
        "ALTER TABLE users ALTER COLUMN public_show_values SET NOT NULL",
        "ALTER TABLE binders ALTER COLUMN is_public SET NOT NULL",
        # v57: Track metadata enrichment attempts independently from general card updates.
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_metadata_enrichment_attempt_at TIMESTAMP",
        "CREATE INDEX IF NOT EXISTS ix_cards_last_metadata_enrichment_attempt_at ON cards(last_metadata_enrichment_attempt_at)",
        # Background scanner queue (handled by create_all, belt+suspenders here).
        """CREATE TABLE IF NOT EXISTS scan_jobs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            status VARCHAR DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW(),
            started_at TIMESTAMP,
            finished_at TIMESTAMP,
            error_message TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS scan_job_items (
            id SERIAL PRIMARY KEY,
            job_id INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            filename VARCHAR,
            content_type VARCHAR DEFAULT 'image/jpeg',
            image_data BYTEA,
            batch_mode BOOLEAN DEFAULT TRUE,
            status VARCHAR DEFAULT 'pending',
            resolved BOOLEAN DEFAULT FALSE,
            attempts INTEGER DEFAULT 0,
            recognized JSON,
            matches JSON,
            error TEXT,
            updated_at TIMESTAMP DEFAULT NOW()
        )""",
        "CREATE INDEX IF NOT EXISTS idx_scan_jobs_user_status ON scan_jobs(user_id, status)",
        "CREATE INDEX IF NOT EXISTS idx_scan_job_items_job ON scan_job_items(job_id, position)",
        "CREATE INDEX IF NOT EXISTS idx_scan_job_items_status ON scan_job_items(status)",
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


def migrate_legacy_collection_binder_entries():
    """Link legacy card-level collection binder rows to an owned exact item."""
    from models import Binder, BinderCard, CollectionItem
    from services.binder_allocations import collection_binder_allocation_counts, stored_binder_quantity

    db = SessionLocal()
    try:
        entries = db.query(BinderCard, Binder.user_id).join(
            Binder, Binder.id == BinderCard.binder_id
        ).filter(
            (Binder.binder_type == "collection") | Binder.binder_type.is_(None),
            BinderCard.collection_item_id.is_(None),
        ).order_by(BinderCard.id.asc()).all()
        if not entries:
            return

        migrated = 0
        for entry, user_id in entries:
            requested = min(stored_binder_quantity(entry.required_quantity), 99)
            candidates = db.query(CollectionItem).filter(
                CollectionItem.user_id == user_id,
                CollectionItem.card_id == entry.card_id,
                CollectionItem.quantity > 0,
            ).order_by(CollectionItem.id.asc()).all()
            usage = collection_binder_allocation_counts(db, user_id, [item.id for item in candidates])
            target = next(
                (
                    item for item in candidates
                    if int(item.quantity or 0) - int(usage.get(item.id, 0) or 0) >= requested
                ),
                None,
            )
            if not target:
                continue
            entry.collection_item_id = target.id
            entry.required_quantity = requested
            migrated += 1

        db.commit()
        if migrated:
            logger.info("migrate_legacy_collection_binder_entries: migrated %s row(s)", migrated)
    except Exception as e:
        db.rollback()
        logger.warning("migrate_legacy_collection_binder_entries: migration aborted: %s", e)
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
        # Step 1: Find non-custom cards with old-format IDs (no supported language suffix)
        rows = [
            row for row in db.execute(sql_text(
                "SELECT id, lang FROM cards "
                "WHERE (is_custom IS NULL OR is_custom = FALSE)"
            )).fetchall()
            if not has_lang_suffix(row[0])
        ]

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
        composite_rows = [
            row for row in db.execute(sql_text(
                "SELECT id FROM cards "
                "WHERE tcg_card_id IS NULL "
                "AND (is_custom IS NULL OR is_custom = FALSE)"
            )).fetchall()
            if has_lang_suffix(row[0])
        ]

        for row in composite_rows:
            composite_id = row[0]
            tcg_card_id, _ = strip_lang_suffix(composite_id)
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

    # Link old card-level collection binder rows to exact owned rows.
    try:
        migrate_legacy_collection_binder_entries()
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

    # Keep upgraded installs' legacy Pocket rows correctly flagged for visibility filters.
    try:
        from services.digital_sets import refresh_digital_catalogue_flags
        result = refresh_digital_catalogue_flags(db)
        db.commit()
        if result["sets_marked"] or result["cards_marked"]:
            logger.info(
                "Digital catalogue startup cleanup marked %s sets and %s cards",
                result["sets_marked"],
                result["cards_marked"],
            )
    except Exception as e:
        db.rollback()
        logger.warning("Digital catalogue flag refresh: %s", e)

    # v42: Migrate per-user settings from global to admin user
    try:
        from models import UserSetting
        admin = db.query(User).filter(User.role == "admin").first()
        if admin:
            per_user_keys = {
                "language", "currency", "price_primary", "price_display",
                "telegram_bot_token", "telegram_chat_id", "telegram_enabled",
                "price_alerts_enabled", "price_alert_threshold",
                "gemini_api_key", "trainer_name", "portfolio_display_mode",
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
