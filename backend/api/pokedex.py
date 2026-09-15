from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import User
from services.display_language import get_tcgdex_display_language
from services.pokedex import aggregate_pokedex, species_detail
from services.pokedex_forms import FORM_FAMILY_PATTERN, get_entry
from services.pokedex_images import cache_path, fetch_image
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language

router = APIRouter()


def _language(db: Session, user_id: int, requested: str | None) -> str:
    value = normalize_tcgdex_language(requested or get_tcgdex_display_language(db, user_id))
    return value if is_supported_tcgdex_language(value) else "en"


@router.get("")
def get_pokedex(
    generation: int | None = Query(None, ge=1, le=9),
    region: str | None = None,
    status: str = Query("all", pattern="^(all|owned|missing)$"),
    search: str | None = None,
    mode: str = Query("grouped", pattern="^(grouped|forms)$"),
    form_family: str = Query("all", pattern=FORM_FAMILY_PATTERN),
    lang: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return aggregate_pokedex(
        db,
        current_user.id,
        language=_language(db, current_user.id, lang),
        generation=generation,
        region=region,
        status=status,
        search=search,
        mode=mode,
        form_family=form_family,
    )


@router.get("/images/{kind}/{entry_id}.png", include_in_schema=False)
def get_species_image(kind: str, entry_id: str):
    """Serve a persistent local image, populating a missing cache entry lazily."""
    entry = get_entry(entry_id)
    if kind not in {"sprites", "artwork"} or not entry:
        raise HTTPException(status_code=404, detail="Image not found")
    image_id = int(entry.get("image_id") or entry["dex_id"])
    try:
        path = cache_path(kind, image_id)
        if not path.is_file():
            path = fetch_image(kind, image_id)
    except Exception:
        path = None
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=604800"},
    )


@router.get("/{entry_id}")
def get_species(
    entry_id: str,
    lang: str | None = None,
    mode: str | None = Query(None, pattern="^(grouped|forms)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = species_detail(
        db, current_user.id, entry_id,
        language=_language(db, current_user.id, lang), mode=mode,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Pokémon not found")
    return result
