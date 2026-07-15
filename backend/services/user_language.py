"""Helpers for resolving per-user display and catalogue languages."""

from __future__ import annotations

from sqlalchemy.orm import Session

from models import UserSetting
from services.settings_defaults import DEFAULT_APP_LANGUAGE
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language

def get_user_language(db: Session, user_id: int | None) -> str:
    """Resolve the user's UI language using the per-user settings path."""
    if user_id is not None:
        row = db.query(UserSetting).filter(
            UserSetting.user_id == user_id,
            UserSetting.key == "language",
        ).first()
        if row and row.value:
            return row.value

    return DEFAULT_APP_LANGUAGE


def get_user_tcgdex_language(db: Session, user_id: int | None) -> str:
    """Resolve the best TCGdex catalogue language for a user."""
    lang = normalize_tcgdex_language(get_user_language(db, user_id))
    return lang if is_supported_tcgdex_language(lang) else DEFAULT_APP_LANGUAGE
