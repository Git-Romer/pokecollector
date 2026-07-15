from sqlalchemy.orm import Session

from models import UserSetting
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language

DEFAULT_DISPLAY_LANGUAGE = "en"


def get_display_language(db: Session, user_id: int | None = None) -> str:
    """Resolve the catalogue display language for a user.

    The user's own choice wins. If the user never picked one, match the settings
    API fallback instead of the legacy global settings row.
    """
    if user_id is not None:
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user_id, UserSetting.key == "language")
            .first()
        )
        if row and row.value:
            return row.value

    return DEFAULT_DISPLAY_LANGUAGE


def get_tcgdex_display_language(db: Session, user_id: int | None = None) -> str:
    """Resolve the user's display language to a TCGdex catalogue language."""
    language = normalize_tcgdex_language(get_display_language(db, user_id))
    return language if is_supported_tcgdex_language(language) else DEFAULT_DISPLAY_LANGUAGE
