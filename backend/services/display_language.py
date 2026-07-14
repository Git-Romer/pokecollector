from sqlalchemy.orm import Session

from models import Setting, UserSetting

DEFAULT_DISPLAY_LANGUAGE = "en"


def get_display_language(db: Session, user_id: int | None = None) -> str:
    """Resolve the catalogue display language for a user.

    The user's own choice wins. The global `settings` row is the fallback for users
    who never picked one, and only a fresh install with neither reaches the default.
    """
    if user_id is not None:
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user_id, UserSetting.key == "language")
            .first()
        )
        if row and row.value:
            return row.value

    row = db.query(Setting).filter(Setting.key == "language").first()
    if row and row.value:
        return row.value

    return DEFAULT_DISPLAY_LANGUAGE
