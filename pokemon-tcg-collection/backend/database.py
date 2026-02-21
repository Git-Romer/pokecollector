from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://pokemon:SecurePasswordPostgres_P0K3mOn@localhost:5432/pokemon_tcg"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=10, max_overflow=20)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


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
}


def _run_migrations(conn):
    """Apply any schema migrations that cannot be handled by create_all."""
    from sqlalchemy import text
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
    ]
    for stmt in migrations:
        try:
            conn.execute(text(stmt))
            conn.commit()
        except Exception:
            conn.rollback()


def init_db():
    from models import Base as ModelBase, Setting
    ModelBase.metadata.create_all(bind=engine)

    # Run lightweight schema migrations (idempotent, PostgreSQL only)
    try:
        with engine.connect() as conn:
            _run_migrations(conn)
    except Exception:
        pass  # Non-blocking — may not be needed on fresh installs

    # Initialize default settings (INSERT IF NOT EXISTS)
    db = SessionLocal()
    try:
        for key, value in DEFAULT_SETTINGS.items():
            existing = db.query(Setting).filter(Setting.key == key).first()
            if not existing:
                db.add(Setting(key=key, value=value))
        db.commit()
    except Exception:
        db.rollback()
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
