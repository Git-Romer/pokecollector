from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from database import get_db
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
    set_name: Optional[str] = None
    number: Optional[str] = None
    rarity: Optional[str] = None
    variant: Optional[str] = None
    quantity: int
    market_value: Optional[float] = None


class PublicBinderSummary(BaseModel):
    id: int
    name: str
    color: Optional[str] = None
    icon_pokemon_id: Optional[int] = None
    card_count: int
    unique_card_count: int
    total_value: Optional[float] = None


class PublicProfile(BaseModel):
    handle: str
    trainer_name: str
    avatar_id: Optional[int] = None
    show_values: bool
    binders: List[PublicBinderSummary]


class PublicBinderDetail(PublicBinderSummary):
    cards: List[PublicCard]


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
