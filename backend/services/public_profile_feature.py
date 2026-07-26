from models import Setting


PUBLIC_PROFILES_SETTING_KEY = "public_profiles_enabled"


def public_profiles_enabled(db) -> bool:
    """Return the global public-sharing state. Missing means safely disabled."""
    row = db.query(Setting.value).filter(
        Setting.key == PUBLIC_PROFILES_SETTING_KEY
    ).first()
    return bool(row and str(row[0]).lower() == "true")
