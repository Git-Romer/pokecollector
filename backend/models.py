from sqlalchemy import (
    Column, String, Integer, Float, DateTime, Date, Boolean,
    CheckConstraint, ForeignKey, Text, JSON, UniqueConstraint, LargeBinary, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy.dialects.postgresql import JSONB
from database import Base

POKEDEX_JSON = JSON(none_as_null=True).with_variant(JSONB(none_as_null=True), "postgresql")
PORTFOLIO_CALCULATION_VERSION = 2


class Set(Base):
    __tablename__ = "sets"

    id = Column(String, primary_key=True)    # Composite DB key: "sv1_en" / "sv1_zh-tw"
    tcg_set_id = Column(String)              # Original TCGdex set ID: "sv1"
    name = Column(String, nullable=False)
    series = Column(String)
    release_date = Column(String)
    total = Column(Integer, default=0)
    printed_total = Column(Integer, default=0)
    images_symbol = Column(String)
    images_logo = Column(String)
    abbreviation = Column(String, nullable=True)
    is_new = Column(Boolean, default=False)
    is_digital = Column(Boolean, default=False)
    lang = Column(String, default="en")      # TCGdex language code, NEVER "both"
    updated_at = Column(DateTime, default=func.now())

    # Relationship to cards via tcg_set_id (no DB-level FK, joined in Python)
    # Use explicit primaryjoin so SQLAlchemy can resolve the join
    cards = relationship(
        "Card",
        primaryjoin="Set.tcg_set_id == foreign(Card.set_id)",
        foreign_keys="[Card.set_id]",
        lazy="dynamic",
        viewonly=True,
        overlaps="set_ref",
    )


class Card(Base):
    __tablename__ = "cards"

    id = Column(String, primary_key=True)          # Composite DB key: "sv1-1_en" / "sv1-1_zh-tw"
    tcg_card_id = Column(String, nullable=True)    # Original TCGdex ID "sv1-1"; NULL for custom cards
    name = Column(String, nullable=False)
    set_id = Column(String, nullable=True)   # Original TCGdex set ID (no FK constraint)
    number = Column(String)
    rarity = Column(String)
    types = Column(JSON)
    supertype = Column(String)
    subtypes = Column(JSON)
    hp = Column(String)
    artist = Column(String)
    stage = Column(String)
    evolve_from = Column(String)
    suffix = Column(String)
    trainer_type = Column(String)
    energy_type = Column(String)
    card_effect = Column(String)
    regulation_mark = Column(String)
    attacks = Column(JSON)
    abilities = Column(JSON)
    weaknesses = Column(JSON)
    resistances = Column(JSON)
    dex_ids = Column(POKEDEX_JSON)
    cardmarket_products = Column(POKEDEX_JSON)
    retreat = Column(Integer)
    playable_fingerprint = Column(String)
    images_small = Column(String)
    images_large = Column(String)
    image_source_lang = Column(String, nullable=True)  # Set when images are copied from another TCGdex language
    data_source_lang = Column(String, nullable=True)   # Set when metadata is copied from another TCGdex language
    custom_image_url = Column(String, nullable=True)   # Manual temporary fallback while TCGdex has no image
    is_custom = Column(Boolean, default=False)
    is_digital = Column(Boolean, default=False)
    lang = Column(String, default="en")      # TCGdex language code
    # Cardmarket EUR prices
    price_market = Column(Float)
    price_low = Column(Float)
    price_mid = Column(Float)
    price_high = Column(Float)
    price_trend = Column(Float)
    price_avg1 = Column(Float)
    price_avg7 = Column(Float)
    price_avg30 = Column(Float)
    # Cardmarket EUR holo prices
    price_market_holo = Column(Float)
    price_low_holo = Column(Float)
    price_trend_holo = Column(Float)
    price_avg1_holo = Column(Float)
    price_avg7_holo = Column(Float)
    price_avg30_holo = Column(Float)
    # TCGPlayer USD prices — normal variant
    price_tcg_normal_low = Column(Float)
    price_tcg_normal_mid = Column(Float)
    price_tcg_normal_high = Column(Float)
    price_tcg_normal_market = Column(Float)
    # TCGPlayer USD prices — reverse holofoil variant
    price_tcg_reverse_low = Column(Float)
    price_tcg_reverse_mid = Column(Float)
    price_tcg_reverse_market = Column(Float)
    # TCGPlayer USD prices — holofoil variant
    price_tcg_holo_low = Column(Float)
    price_tcg_holo_mid = Column(Float)
    price_tcg_holo_market = Column(Float)
    price_source_lang = Column(String, nullable=True)  # Set when prices are copied from another TCGdex language
    last_price_sync_attempt_at = Column(DateTime, nullable=True)
    last_price_sync_success_at = Column(DateTime, nullable=True)
    last_metadata_enrichment_attempt_at = Column(DateTime, nullable=True, index=True)
    # Card variants from TCGdex
    variants_normal = Column(Boolean)
    variants_reverse = Column(Boolean)
    variants_holo = Column(Boolean)
    variants_first_edition = Column(Boolean)
    updated_at = Column(DateTime, default=func.now())

    # Relationship to Set via tcg_set_id (viewonly, no DB FK)
    set_ref = relationship(
        "Set",
        primaryjoin="and_(Set.tcg_set_id == foreign(Card.set_id), Set.lang == foreign(Card.lang))",
        foreign_keys="[Card.set_id, Card.lang]",
        uselist=False,
        viewonly=True,
        overlaps="cards",
    )
    collection_items = relationship("CollectionItem", back_populates="card", lazy="dynamic")
    wishlist_items = relationship("WishlistItem", back_populates="card", lazy="dynamic")
    price_history = relationship("PriceHistory", back_populates="card", lazy="dynamic")
    binder_cards = relationship("BinderCard", back_populates="card", lazy="dynamic")


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("ix_users_public_handle", "public_handle", unique=True),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, unique=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, default="trainer")  # "admin" or "trainer"
    is_active = Column(Boolean, default=True)
    avatar_id = Column(Integer, nullable=True)  # Pokemon number (1-151) for avatar sprite
    public_handle = Column(String, nullable=True)
    is_profile_public = Column(Boolean, default=False, nullable=False)
    public_show_values = Column(Boolean, default=False, nullable=False)
    must_change_password = Column(Boolean, default=False)
    created_at = Column(DateTime, default=func.now())


class CollectionItem(Base):
    __tablename__ = "collection"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    quantity = Column(Integer, default=1)
    condition = Column(String, default="NM")  # Mint/NM/LP/MP/HP
    variant = Column(String, nullable=False, default="Normal")  # Normal/Holo/Reverse Holo/First Edition
    purchase_price = Column(Float)
    lang = Column(String, default="en")  # fixed TCGdex card language
    added_at = Column(DateTime, default=func.now())

    card = relationship("Card", back_populates="collection_items")


class WishlistItem(Base):
    __tablename__ = "wishlist"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    quantity = Column(Integer, default=1, nullable=False)
    price_alert_above = Column(Float)
    price_alert_below = Column(Float)
    notified_at = Column(DateTime)
    created_at = Column(DateTime, default=func.now())

    card = relationship("Card", back_populates="wishlist_items")

    __table_args__ = (
        CheckConstraint("quantity >= 1 AND quantity <= 99", name="ck_wishlist_quantity_range"),
        UniqueConstraint("user_id", "card_id", name="uq_wishlist_user_card"),
    )


class PriceHistory(Base):
    __tablename__ = "price_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    date = Column(Date, nullable=False)
    price_low = Column(Float)
    price_mid = Column(Float)
    price_high = Column(Float)
    price_market = Column(Float)
    price_trend = Column(Float)

    card = relationship("Card", back_populates="price_history")

    __table_args__ = (UniqueConstraint("card_id", "date", name="uq_price_history_card_date"),)


class Binder(Base):
    __tablename__ = "binders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    description = Column(Text)
    color = Column(String, default="#EE1515")
    binder_type = Column(String, default="collection")  # "collection" or "wishlist"
    format = Column(String, nullable=True)  # "Standard", "Expanded", "Unlimited", "Casual"
    icon_pokemon_id = Column(Integer, nullable=True)
    is_public = Column(Boolean, default=False, nullable=False)
    auto_owned_set_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=func.now())

    binder_cards = relationship("BinderCard", back_populates="binder", cascade="all, delete-orphan")


class BinderCard(Base):
    __tablename__ = "binder_cards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    binder_id = Column(Integer, ForeignKey("binders.id"), nullable=False)
    card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    collection_item_id = Column(Integer, ForeignKey("collection.id"), nullable=True)
    required_quantity = Column(Integer, default=1, nullable=False)
    added_at = Column(DateTime, default=func.now())

    binder = relationship("Binder", back_populates="binder_cards")
    card = relationship("Card", back_populates="binder_cards")
    collection_item = relationship("CollectionItem")

    __table_args__ = (
        CheckConstraint("required_quantity >= 1 AND required_quantity <= 99", name="ck_binder_card_quantity_range"),
        UniqueConstraint("binder_id", "collection_item_id", name="uq_binder_collection_item"),
    )


class ProductPurchase(Base):
    __tablename__ = "product_purchases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_name = Column(String, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    product_type = Column(String)  # Booster, Display, ETB, Tin, Bundle, etc.
    purchase_price = Column(Float, nullable=False)
    current_value = Column(Float)
    sold_price = Column(Float)
    purchase_date = Column(Date, nullable=False)
    sold_date = Column(Date)
    lifecycle_status = Column(String, nullable=False, default="sealed", server_default="sealed")
    batch_id = Column(String)
    image_url = Column(String)
    cardmarket_url = Column(String)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        Index("ix_product_purchases_user_id", "user_id"),
        Index("ix_product_purchases_user_batch", "user_id", "batch_id"),
        CheckConstraint(
            "lifecycle_status IN ('sealed', 'opened', 'sold', 'review')",
            name="ck_product_purchases_lifecycle_status",
        ),
    )


class ProductCard(Base):
    __tablename__ = "product_cards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_id = Column(Integer, ForeignKey("product_purchases.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    # Historical source row only. Intentionally not a FK so sold-card history
    # survives when the active collection row is reduced/deleted after sale.
    collection_item_id = Column(Integer, nullable=True)
    initial_quantity = Column(Integer, default=1, nullable=False)
    active_quantity = Column(Integer, default=1, nullable=False)
    sold_quantity = Column(Integer, default=0, nullable=False)
    condition = Column(String, default="NM")
    variant = Column(String, nullable=False, default="Normal")
    lang = Column(String, default="en")
    purchase_price = Column(Float)
    linked_at = Column(DateTime, default=func.now())

    product = relationship("ProductPurchase")
    card = relationship("Card")
    ledger_entries = relationship(
        "ProductLedgerEntry",
        back_populates="product_card",
        order_by="ProductLedgerEntry.event_date.asc(), ProductLedgerEntry.id.asc()",
    )

    __table_args__ = (
        CheckConstraint("initial_quantity >= 1", name="ck_product_cards_initial_quantity_positive"),
        CheckConstraint("active_quantity >= 0", name="ck_product_cards_active_quantity_non_negative"),
        CheckConstraint("sold_quantity >= 0", name="ck_product_cards_sold_quantity_non_negative"),
        CheckConstraint("active_quantity + sold_quantity <= initial_quantity", name="ck_product_cards_quantities_within_initial"),
    )


class ProductLedgerEntry(Base):
    __tablename__ = "product_ledger_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_card_id = Column(Integer, ForeignKey("product_cards.id", ondelete="SET NULL"), nullable=True)
    product_id = Column(Integer, ForeignKey("product_purchases.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    entry_type = Column(String, nullable=False, default="card_sale")  # card_sale / flat_gain / adjustment
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    original_collection_item_id = Column(Integer, nullable=True)
    trade_item_id = Column(Integer, ForeignKey("trade_items.id", ondelete="SET NULL"), nullable=True)
    quantity = Column(Integer, default=1, nullable=False)
    amount = Column(Float, nullable=False)  # Flat total for this ledger event
    event_date = Column(Date, nullable=False)
    product_name = Column(String, nullable=True)
    card_name = Column(String, nullable=True)
    set_id = Column(String, nullable=True)
    card_number = Column(String, nullable=True)
    variant = Column(String, nullable=True)
    condition = Column(String, nullable=True)
    lang = Column(String, nullable=True)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.now())

    product_card = relationship("ProductCard", back_populates="ledger_entries")
    product = relationship("ProductPurchase")
    card = relationship("Card")

    __table_args__ = (
        CheckConstraint("quantity >= 1", name="ck_product_ledger_quantity_positive"),
        CheckConstraint("amount >= 0", name="ck_product_ledger_amount_non_negative"),
        CheckConstraint("entry_type IN ('card_sale', 'flat_gain', 'adjustment', 'trade_out')", name="ck_product_ledger_entry_type"),
    )


class Trade(Base):
    __tablename__ = "trades"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    partner_name = Column(String, nullable=True)
    trade_date = Column(Date, nullable=False)
    notes = Column(Text)
    outgoing_value = Column(Float, default=0, nullable=False)
    incoming_value = Column(Float, default=0, nullable=False)
    value_delta = Column(Float, default=0, nullable=False)
    created_at = Column(DateTime, default=func.now())

    items = relationship(
        "TradeItem",
        back_populates="trade",
        cascade="all, delete-orphan",
        order_by="TradeItem.id.asc()",
    )

    __table_args__ = (
        CheckConstraint("outgoing_value >= 0", name="ck_trades_outgoing_value_non_negative"),
        CheckConstraint("incoming_value >= 0", name="ck_trades_incoming_value_non_negative"),
    )


class TradeItem(Base):
    __tablename__ = "trade_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    trade_id = Column(Integer, ForeignKey("trades.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    direction = Column(String, nullable=False)
    card_id = Column(String, ForeignKey("cards.id", ondelete="SET NULL"), nullable=True)
    original_collection_item_id = Column(Integer, nullable=True)
    created_collection_item_id = Column(Integer, nullable=True)
    product_card_id = Column(Integer, nullable=True)
    # Inventory provenance added for editable trades. Legacy rows keep
    # snapshot_version=0 so unsafe reversals can be rejected explicitly.
    purchase_price = Column(Float, nullable=True)
    snapshot_version = Column(Integer, default=1, nullable=False)
    quantity = Column(Integer, default=1, nullable=False)
    value_per_card = Column(Float, default=0, nullable=False)
    value_total = Column(Float, default=0, nullable=False)
    card_name = Column(String, nullable=True)
    set_id = Column(String, nullable=True)
    card_number = Column(String, nullable=True)
    variant = Column(String, nullable=True)
    condition = Column(String, nullable=True)
    lang = Column(String, nullable=True)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.now())

    trade = relationship("Trade", back_populates="items")
    card = relationship("Card")

    __table_args__ = (
        CheckConstraint("direction IN ('outgoing', 'incoming')", name="ck_trade_items_direction"),
        CheckConstraint("quantity >= 1", name="ck_trade_items_quantity_positive"),
        CheckConstraint("value_per_card >= 0", name="ck_trade_items_value_per_card_non_negative"),
        CheckConstraint("value_total >= 0", name="ck_trade_items_value_total_non_negative"),
        CheckConstraint("purchase_price IS NULL OR purchase_price >= 0", name="ck_trade_items_purchase_price_non_negative"),
        CheckConstraint("snapshot_version >= 0", name="ck_trade_items_snapshot_version_non_negative"),
    )


class SyncLog(Base):
    __tablename__ = "sync_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime, default=func.now())
    finished_at = Column(DateTime)
    cards_updated = Column(Integer, default=0)
    sets_updated = Column(Integer, default=0)
    status = Column(String, default="running")  # running/success/error
    error_message = Column(Text)
    sync_type = Column(String, nullable=True, default="full")  # "full" or "price"


class PortfolioSnapshot(Base):
    __tablename__ = "portfolio_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(DateTime, nullable=False)  # full UTC timestamp, no unique constraint
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    total_value = Column(Float, default=0)
    total_cards = Column(Integer, default=0)
    total_cost = Column(Float, default=0)
    calculation_version = Column(Integer, default=PORTFOLIO_CALCULATION_VERSION, nullable=False)
    cards_value = Column(Float, nullable=True)
    products_value = Column(Float, nullable=True)
    cards_cost = Column(Float, nullable=True)
    products_cost = Column(Float, nullable=True)
    performance_cost_basis = Column(Float, nullable=True)
    realized_value = Column(Float, nullable=True)
    unrealized_pnl = Column(Float, nullable=True)
    realized_pnl = Column(Float, nullable=True)
    total_pnl = Column(Float, nullable=True)
    product_value_fallback_count = Column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_portfolio_snapshots_user_date", "user_id", "date"),
    )


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)


class UserSetting(Base):
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    key = Column(String, nullable=False)
    value = Column(Text, nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_setting"),)


class CustomCardMatch(Base):
    """Tracks custom cards that now have an equivalent API card on TCGdex."""
    __tablename__ = "custom_card_matches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    custom_card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    api_card_id = Column(String, nullable=False)
    matched_at = Column(DateTime, default=func.now())
    status = Column(String, default="pending")  # pending / migrated / dismissed

    custom_card = relationship("Card", foreign_keys=[custom_card_id])


class ImageCache(Base):
    __tablename__ = "image_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)
    image_key = Column(String, unique=True, nullable=False, index=True)
    data = Column(LargeBinary, nullable=False)
    content_type = Column(String, default="image/webp")
    cached_at = Column(DateTime, default=func.now())


class ScanHistory(Base):
    __tablename__ = "scan_history"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    source = Column(String, default="recognizer", nullable=False)
    source_reference = Column(String)
    recognized_name = Column(String)
    recognized_number = Column(String)
    recognized_language = Column(String)
    match_count = Column(Integer, default=0, nullable=False)
    top_match_card_id = Column(String)
    top_match_name = Column(String)
    created_at = Column(DateTime, default=func.now(), nullable=False)
    expires_at = Column(DateTime, nullable=False)
