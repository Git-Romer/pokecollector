from datetime import datetime
from typing import Any, Literal, Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from api.decks import _deck_fingerprints, _deck_response, _standard_legal_fingerprints
from database import get_db
from schemas import DeckProbabilityResponse
from services.deck_probability import analyze_deck_probability
from services import public_profile as pp
from services.public_profile_feature import public_profiles_enabled

router = APIRouter()

# Rate limiting: these public GET endpoints are already covered by the global
# SlowAPI default_limits=["60/minute"] configured on the app-wide `limiter` in
# main.py (see Limiter(... default_limits=["60/minute"]) + SlowAPIMiddleware).
# No per-route @limiter.limit(...) is added here on purpose: main.py imports
# api.public (via the router), so importing `limiter` back from main.py would
# create an import cycle. The global default already applies to every route,
# including these, so a per-route decorator would just be redundant.


class PublicCard(BaseModel):
    id: str
    name: str
    image: Optional[str] = None
    set_id: Optional[str] = None
    set_name: Optional[str] = None
    number: Optional[str] = None
    rarity: Optional[str] = None
    is_custom: bool = False
    lang: Optional[str] = None
    variant: Optional[str] = None
    printing_details: List[str] = Field(default_factory=list)
    data_source_lang: Optional[str] = None
    price_source_lang: Optional[str] = None
    image_source_lang: Optional[str] = None
    has_custom_image_fallback: bool = False
    quantity: int
    market_value: Optional[float] = None
    date_added: Optional[datetime] = None


class PublicBinderSummary(BaseModel):
    id: int
    name: str
    color: Optional[str] = None
    icon_pokemon_id: Optional[int] = None
    card_count: int
    unique_card_count: int
    total_value: Optional[float] = None


class PublicDeckSummary(BaseModel):
    id: int
    name: str
    binder_type: Literal["deck", "physical_deck"]
    format: Literal["Standard", "Expanded", "Unlimited", "Casual"]
    target_size: Literal[20, 40, 60]
    description: Optional[str] = None
    color: Optional[str] = None
    icon_pokemon_id: Optional[int] = None
    card_count: int
    unique_card_count: int


class PublicProfile(BaseModel):
    handle: str
    trainer_name: str
    avatar_id: Optional[int] = None
    show_values: bool
    wishlist_is_public: bool
    wishlist_count: int
    binders: List[PublicBinderSummary]
    decks: List[PublicDeckSummary]


class PublicProfileSummary(BaseModel):
    handle: str
    trainer_name: str
    avatar_id: Optional[int] = None
    binder_count: int
    deck_count: int
    wishlist_is_public: bool


class PublicBinderDetail(PublicBinderSummary):
    cards: List[PublicCard]


class PublicWishlist(BaseModel):
    handle: str
    trainer_name: str
    show_values: bool
    total: int
    page: int
    page_size: int
    cards: List[PublicCard]
    sets: List[dict[str, str]]
    rarities: List[str]


class PublicDeckEntry(BaseModel):
    card_id: str
    required_quantity: int
    card: PublicCard


class PublicDeckDetail(PublicDeckSummary):
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    status: Literal["under", "complete", "over"]
    remaining_to_target: int
    over_target_by: int
    composition_counts: dict[str, int]
    entries: List[PublicDeckEntry]
    validation: dict[str, Any]
    analysis: dict[str, Any]


# Public sharing can be disabled globally or per owner. Require revalidation so a
# previously opened profile cannot remain visible from a browser cache after either
# control is switched off. Reverse proxies may still validate their stored response.
_PUBLIC_CACHE_CONTROL = "public, max-age=0, must-revalidate"
_PUBLIC_NOT_FOUND_HEADERS = {"Cache-Control": "no-store"}


def _set_public_cache(response: Response | None) -> None:
    if response is not None:
        response.headers["Cache-Control"] = _PUBLIC_CACHE_CONTROL


def _require_public_profiles_enabled(db: Session) -> None:
    if not public_profiles_enabled(db):
        raise HTTPException(
            status_code=404,
            detail="Profile not found",
            headers=_PUBLIC_NOT_FOUND_HEADERS,
        )


def _not_found(detail: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail=detail,
        headers=_PUBLIC_NOT_FOUND_HEADERS,
    )


def _without_private_validation_fields(value):
    if isinstance(value, dict):
        return {
            key: _without_private_validation_fields(item)
            for key, item in value.items()
            if key != "entry_id"
        }
    if isinstance(value, list):
        return [_without_private_validation_fields(item) for item in value]
    return value


def _public_deck_payload(db: Session, deck, show_values: bool) -> dict:
    if any(entry.card and entry.card.is_custom for entry in deck.entries):
        raise _not_found("Deck not found")
    required = {entry.card_id: int(entry.required_quantity or 0) for entry in deck.entries}
    full = _deck_response(
        deck,
        required,
        _standard_legal_fingerprints(db, _deck_fingerprints(deck)),
        include_entries=False,
    )
    validation = full.validation.model_dump() if hasattr(full.validation, "model_dump") else full.validation.dict()
    checks = [
        _without_private_validation_fields(check)
        for check in validation["checks"]
        if check["code"] != "ownership"
    ]
    validation = {
        "valid": not any(check["severity"] == "error" and check["status"] == "fail" for check in checks),
        "errors": [check for check in checks if check["severity"] == "error" and check["status"] == "fail"],
        "warnings": [check for check in checks if check["severity"] == "warning" and check["status"] == "fail"],
        "checks": checks,
    }
    summary = pp.serialize_deck_summary(deck)
    return {
        **summary,
        "created_at": deck.created_at,
        "updated_at": deck.updated_at,
        "status": full.status,
        "remaining_to_target": full.remaining_to_target,
        "over_target_by": full.over_target_by,
        "composition_counts": full.composition_counts,
        "entries": [
            {
                "card_id": entry.card_id,
                "required_quantity": int(entry.required_quantity or 0),
                "card": pp._serialize_catalogue_card(
                    entry.card,
                    int(entry.required_quantity or 0),
                    show_values,
                ),
            }
            for entry in deck.entries
            if entry.card
        ],
        "validation": validation,
        "analysis": full.analysis,
    }


@router.get("/profiles", response_model=List[PublicProfileSummary])
def list_public_profiles(db: Session = Depends(get_db), response: Response = None):
    _require_public_profiles_enabled(db)
    _set_public_cache(response)
    return pp.public_profile_directory(db)


@router.get("/profiles/{handle}", response_model=PublicProfile)
def get_public_profile(handle: str, db: Session = Depends(get_db), response: Response = None):
    _require_public_profiles_enabled(db)
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise _not_found("Profile not found")
    _set_public_cache(response)
    return pp.serialize_profile(db, user)


@router.get("/profiles/{handle}/binders/{binder_id}", response_model=PublicBinderDetail)
def get_public_binder(handle: str, binder_id: int, db: Session = Depends(get_db), response: Response = None):
    _require_public_profiles_enabled(db)
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise _not_found("Profile not found")
    binder = pp.get_public_collection_binder(db, user.id, binder_id)
    if not binder:
        raise _not_found("Binder not found")
    _set_public_cache(response)
    return pp.serialize_binder_detail(db, binder, show_values=bool(user.public_show_values))


@router.get("/profiles/{handle}/wishlist", response_model=PublicWishlist)
def get_public_wishlist(
    handle: str,
    search: str | None = Query(None, max_length=255),
    set_id: str | None = Query(None, max_length=255),
    rarity: str | None = Query(None, max_length=255),
    sort: Literal["date_added", "name", "set", "rarity", "price"] = "date_added",
    order: Literal["asc", "desc"] = "desc",
    page: int = Query(1, ge=1),
    page_size: int = Query(48, ge=1, le=100),
    db: Session = Depends(get_db),
    response: Response = None,
):
    _require_public_profiles_enabled(db)
    user = pp.get_live_profile(db, handle.lower())
    if not user or (user.wishlist_visibility or "private") != "public":
        raise _not_found("Wishlist not found")
    if sort == "price" and not user.public_show_values:
        raise HTTPException(status_code=422, detail="Price sorting is unavailable because public values are hidden")
    items, total = pp.public_wishlist_items(
        db,
        user,
        search=search,
        set_filter=set_id,
        rarity=rarity,
        sort=sort,
        order=order,
        page=page,
        page_size=page_size,
    )
    facets = pp.public_wishlist_facets(db, user)
    _set_public_cache(response)
    return {
        "handle": user.public_handle,
        "trainer_name": pp.trainer_name_for(db, user),
        "show_values": bool(user.public_show_values),
        "total": total,
        "page": page,
        "page_size": page_size,
        "cards": [
            pp.serialize_wishlist_item(item, bool(user.public_show_values))
            for item in items
        ],
        **facets,
    }


@router.get("/profiles/{handle}/decks/{deck_id}", response_model=PublicDeckDetail)
def get_public_deck(handle: str, deck_id: int, db: Session = Depends(get_db), response: Response = None):
    _require_public_profiles_enabled(db)
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise _not_found("Profile not found")
    deck = pp.get_public_deck(db, user.id, deck_id)
    if not deck:
        raise _not_found("Deck not found")
    _set_public_cache(response)
    return _public_deck_payload(db, deck, bool(user.public_show_values))


@router.get(
    "/profiles/{handle}/decks/{deck_id}/probability",
    response_model=DeckProbabilityResponse,
)
def get_public_deck_probability(
    handle: str,
    deck_id: int,
    hand: int = Query(7, ge=0, le=250),
    draws: int = Query(0, ge=0, le=250),
    card_name: str | None = Query(None, max_length=255),
    prize_count: int = Query(6, ge=0, le=250),
    db: Session = Depends(get_db),
    response: Response = None,
):
    _require_public_profiles_enabled(db)
    user = pp.get_live_profile(db, handle.lower())
    if not user:
        raise _not_found("Profile not found")
    deck = pp.get_public_deck(db, user.id, deck_id)
    if not deck or any(entry.card and entry.card.is_custom for entry in deck.entries):
        raise _not_found("Deck not found")
    _set_public_cache(response)
    return analyze_deck_probability(deck, hand, draws, card_name, prize_count)
