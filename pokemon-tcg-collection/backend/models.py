from sqlalchemy import (
    Column, String, Integer, Float, DateTime, Date, Boolean,
    ForeignKey, Text, JSON, UniqueConstraint
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class Set(Base):
    __tablename__ = "sets"

    id = Column(String, primary_key=True)    # Composite DB key: "sv1_de" / "sv1_en"
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
    lang = Column(String, default="en")      # "en" or "de" — NEVER "both"
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

    id = Column(String, primary_key=True)          # Composite DB key: "sv1-1_de" / "sv1-1_en"
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
    images_small = Column(String)
    images_large = Column(String)
    is_custom = Column(Boolean, default=False)
    # Cardmarket EUR prices
    price_market = Column(Float)
    price_low = Column(Float)
    price_mid = Column(Float)
    price_high = Column(Float)
    price_trend = Column(Float)
    price_avg1 = Column(Float)
    price_avg7 = Column(Float)
    price_avg30 = Column(Float)
    updated_at = Column(DateTime, default=func.now())

    # Relationship to Set via tcg_set_id (viewonly, no DB FK)
    set_ref = relationship(
        "Set",
        primaryjoin="foreign(Card.set_id) == Set.tcg_set_id",
        foreign_keys="[Card.set_id]",
        uselist=False,
        viewonly=True,
        overlaps="cards",
    )
    collection_items = relationship("CollectionItem", back_populates="card", lazy="dynamic")
    wishlist_items = relationship("WishlistItem", back_populates="card", lazy="dynamic")
    price_history = relationship("PriceHistory", back_populates="card", lazy="dynamic")
    binder_cards = relationship("BinderCard", back_populates="card", lazy="dynamic")


class CollectionItem(Base):
    __tablename__ = "collection"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    quantity = Column(Integer, default=1)
    condition = Column(String, default="NM")  # Mint/NM/LP/MP/HP
    variant = Column(String, nullable=True)  # Normal/Holo/Reverse Holo/Full Art/etc.
    purchase_price = Column(Float)
    lang = Column(String, default="en")  # "en" or "de" — fixed card language
    grade = Column(String, default="raw")  # "raw", "PSA 9", "PSA 10", "BGS 9", etc.
    added_at = Column(DateTime, default=func.now())

    card = relationship("Card", back_populates="collection_items")

    __table_args__ = (UniqueConstraint("card_id", "variant", "lang", name="uq_collection_card_variant_lang"),)


class WishlistItem(Base):
    __tablename__ = "wishlist"

    id = Column(Integer, primary_key=True, autoincrement=True)
    card_id = Column(String, ForeignKey("cards.id"), nullable=False, unique=True)
    price_alert_above = Column(Float)
    price_alert_below = Column(Float)
    notified_at = Column(DateTime)
    created_at = Column(DateTime, default=func.now())

    card = relationship("Card", back_populates="wishlist_items")


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
    description = Column(Text)
    color = Column(String, default="#EE1515")
    binder_type = Column(String, default="collection")  # "collection" or "wishlist"
    created_at = Column(DateTime, default=func.now())

    binder_cards = relationship("BinderCard", back_populates="binder", cascade="all, delete-orphan")


class BinderCard(Base):
    __tablename__ = "binder_cards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    binder_id = Column(Integer, ForeignKey("binders.id"), nullable=False)
    card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    added_at = Column(DateTime, default=func.now())

    binder = relationship("Binder", back_populates="binder_cards")
    card = relationship("Card", back_populates="binder_cards")

    __table_args__ = (UniqueConstraint("binder_id", "card_id", name="uq_binder_card"),)


class ProductPurchase(Base):
    __tablename__ = "product_purchases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    product_name = Column(String, nullable=False)
    product_type = Column(String)  # Booster, Display, ETB, Tin, Bundle, etc.
    purchase_price = Column(Float, nullable=False)
    current_value = Column(Float)
    sold_price = Column(Float)
    purchase_date = Column(Date, nullable=False)
    sold_date = Column(Date)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.now())


class SyncLog(Base):
    __tablename__ = "sync_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    started_at = Column(DateTime, default=func.now())
    finished_at = Column(DateTime)
    cards_updated = Column(Integer, default=0)
    sets_updated = Column(Integer, default=0)
    status = Column(String, default="running")  # running/success/error
    error_message = Column(Text)


class PortfolioSnapshot(Base):
    __tablename__ = "portfolio_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Date, nullable=False, unique=True)
    total_value = Column(Float, default=0)
    total_cards = Column(Integer, default=0)
    total_cost = Column(Float, default=0)


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)


class CustomCardMatch(Base):
    """Tracks custom cards that now have an equivalent API card on TCGdex."""
    __tablename__ = "custom_card_matches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    custom_card_id = Column(String, ForeignKey("cards.id"), nullable=False)
    api_card_id = Column(String, nullable=False)
    matched_at = Column(DateTime, default=func.now())
    status = Column(String, default="pending")  # pending / migrated / dismissed

    custom_card = relationship("Card", foreign_keys=[custom_card_id])
