from pydantic import BaseModel, Field
from typing import Optional, List, Any
from datetime import datetime, date


class SetBase(BaseModel):
    id: str                             # Composite DB key: "sv1_de" / "sv1_en"
    tcg_set_id: Optional[str] = None   # Original TCGdex set ID: "sv1"
    name: str
    series: Optional[str] = None
    release_date: Optional[str] = None
    total: int = 0
    printed_total: int = 0
    images_symbol: Optional[str] = None
    images_logo: Optional[str] = None
    abbreviation: Optional[str] = None
    is_new: bool = False
    lang: str = "en"                    # "en" or "de" — never "both"
    owned_count: int = 0

    class Config:
        from_attributes = True


class CardBase(BaseModel):
    id: str
    tcg_card_id: Optional[str] = None
    name: str
    set_id: Optional[str] = None
    number: Optional[str] = None
    rarity: Optional[str] = None
    types: Optional[List[str]] = None
    supertype: Optional[str] = None
    subtypes: Optional[List[str]] = None
    hp: Optional[str] = None
    artist: Optional[str] = None
    images_small: Optional[str] = None
    images_large: Optional[str] = None
    is_custom: bool = False
    price_market: Optional[float] = None
    price_low: Optional[float] = None
    price_mid: Optional[float] = None
    price_high: Optional[float] = None
    price_trend: Optional[float] = None
    price_avg1: Optional[float] = None
    price_avg7: Optional[float] = None
    price_avg30: Optional[float] = None
    # Cardmarket holo
    price_market_holo: Optional[float] = None
    price_low_holo: Optional[float] = None
    price_trend_holo: Optional[float] = None
    price_avg1_holo: Optional[float] = None
    price_avg7_holo: Optional[float] = None
    price_avg30_holo: Optional[float] = None
    # TCGPlayer
    price_tcg_normal_low: Optional[float] = None
    price_tcg_normal_mid: Optional[float] = None
    price_tcg_normal_high: Optional[float] = None
    price_tcg_normal_market: Optional[float] = None
    price_tcg_reverse_low: Optional[float] = None
    price_tcg_reverse_mid: Optional[float] = None
    price_tcg_reverse_market: Optional[float] = None
    price_tcg_holo_low: Optional[float] = None
    price_tcg_holo_mid: Optional[float] = None
    price_tcg_holo_market: Optional[float] = None
    # Variants
    variants_normal: Optional[bool] = None
    variants_reverse: Optional[bool] = None
    variants_holo: Optional[bool] = None
    variants_first_edition: Optional[bool] = None

    class Config:
        from_attributes = True


class CardCustomCreate(BaseModel):
    name: str
    set_id: Optional[str] = None
    number: Optional[str] = None
    rarity: Optional[str] = None
    types: Optional[List[str]] = None
    hp: Optional[str] = None
    artist: Optional[str] = None
    image_url: Optional[str] = None
    lang: Optional[str] = None


class CustomCardUpdate(BaseModel):
    name: Optional[str] = None
    set_id: Optional[str] = None
    number: Optional[str] = None
    rarity: Optional[str] = None
    types: Optional[List] = None
    image_url: Optional[str] = None
    hp: Optional[str] = None


class CardWithSet(CardBase):
    set_ref: Optional[SetBase] = None


class CollectionItemCreate(BaseModel):
    card_id: str
    quantity: int = 1
    condition: str = "NM"
    variant: Optional[str] = None
    purchase_price: Optional[float] = None
    lang: str = "en"  # fixed language of this card item ("en" or "de")
    grade: str = "raw"  # "raw", "PSA 9", "PSA 10", "BGS 9", "BGS 9.5", "CGC 9", "CGC 10"


class CollectionItemUpdate(BaseModel):
    quantity: Optional[int] = None
    condition: Optional[str] = None
    variant: Optional[str] = None
    purchase_price: Optional[float] = None
    grade: Optional[str] = None
    lang: Optional[str] = None


class CollectionItemResponse(BaseModel):
    id: int
    card_id: str
    quantity: int
    condition: str
    variant: Optional[str] = None
    purchase_price: Optional[float] = None
    lang: str = "en"
    grade: str = "raw"
    added_at: Optional[datetime] = None
    card: Optional[CardWithSet] = None

    class Config:
        from_attributes = True


class WishlistItemCreate(BaseModel):
    card_id: str
    price_alert_above: Optional[float] = None
    price_alert_below: Optional[float] = None


class WishlistItemUpdate(BaseModel):
    price_alert_above: Optional[float] = None
    price_alert_below: Optional[float] = None


class WishlistItemResponse(BaseModel):
    id: int
    card_id: str
    price_alert_above: Optional[float] = None
    price_alert_below: Optional[float] = None
    notified_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    card: Optional[CardWithSet] = None

    class Config:
        from_attributes = True


class PriceHistoryResponse(BaseModel):
    id: int
    card_id: str
    date: date
    price_low: Optional[float] = None
    price_mid: Optional[float] = None
    price_high: Optional[float] = None
    price_market: Optional[float] = None
    price_trend: Optional[float] = None

    class Config:
        from_attributes = True


class BinderCreate(BaseModel):
    name: str
    description: Optional[str] = None
    color: str = "#EE1515"
    binder_type: str = "collection"


class BinderUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    binder_type: Optional[str] = None


class BinderResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    color: str
    binder_type: str = "collection"
    created_at: Optional[datetime] = None
    card_count: int = 0

    class Config:
        from_attributes = True


class ProductPurchaseCreate(BaseModel):
    product_name: str
    product_type: Optional[str] = None
    purchase_price: float
    current_value: Optional[float] = None
    sold_price: Optional[float] = None
    purchase_date: date
    sold_date: Optional[date] = None
    notes: Optional[str] = None


class ProductPurchaseUpdate(BaseModel):
    product_name: Optional[str] = None
    product_type: Optional[str] = None
    purchase_price: Optional[float] = None
    current_value: Optional[float] = None
    sold_price: Optional[float] = None
    purchase_date: Optional[date] = None
    sold_date: Optional[date] = None
    notes: Optional[str] = None


class ProductPurchaseResponse(BaseModel):
    id: int
    product_name: str
    product_type: Optional[str] = None
    purchase_price: float
    current_value: Optional[float] = None
    sold_price: Optional[float] = None
    purchase_date: date
    sold_date: Optional[date] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None
    pnl: Optional[float] = None
    pnl_percent: Optional[float] = None

    class Config:
        from_attributes = True


class SyncLogResponse(BaseModel):
    id: int
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    cards_updated: int = 0
    sets_updated: int = 0
    status: str
    error_message: Optional[str] = None

    class Config:
        from_attributes = True
