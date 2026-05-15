import logging
import os
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from api.auth import get_current_user
from sqlalchemy.orm import Session
from database import get_db
from models import Setting, UserSetting, User
from services.debug_logging import configure_debug_logging, get_debug_log_path

router = APIRouter()
logger = logging.getLogger(__name__)

PER_USER_KEYS = {
    "language", "currency", "price_primary", "price_display",
    "telegram_bot_token", "telegram_chat_id", "telegram_enabled",
    "price_alerts_enabled", "price_alert_threshold",
    "gemini_api_key", "trainer_name",
}

ADMIN_ONLY_KEYS = {
    "full_sync_interval_days", "price_sync_interval_minutes", "multi_user_mode",
    "tcgdex_sync_languages", "debug_mode",
    "cross_language_price_fallback", "cross_language_image_fallback",
}

DEFAULT_SETTINGS = {
    "trainer_name": "TRAINER",
    "full_sync_interval_days": "5",
    "price_sync_interval_minutes": "30",
    "telegram_enabled": "false",
    "telegram_chat_id": "",
    "price_alerts_enabled": "false",
    "price_alert_threshold": "10",
    "language": "de",
    "currency": "EUR",
    "price_primary": "trend",
    "price_display": '["trend", "avg1", "avg7", "avg30", "low"]',
    "tcgdex_sync_languages": "en,de",
    "cross_language_price_fallback": "true",
    "cross_language_image_fallback": "true",
    "debug_mode": "false",
}


def _normalize_tcgdex_sync_languages(value) -> str:
    allowed = ("en", "de")
    raw_parts = [part.strip().lower() for part in str(value or "").split(",")]
    selected = [lang for lang in allowed if lang in raw_parts]
    if not selected:
        raise HTTPException(
            status_code=422,
            detail="tcgdex_sync_languages must include at least one of: en, de",
        )
    return ",".join(selected)


def _coerce_setting_value(key: str, value) -> str:
    if key == "tcgdex_sync_languages":
        return _normalize_tcgdex_sync_languages(value)
    if key in {"debug_mode", "cross_language_price_fallback", "cross_language_image_fallback"}:
        return "true" if str(value).lower() in {"true", "1", "yes", "on"} else "false"
    return str(value)


def _apply_setting_side_effect(key: str, value: str) -> None:
    if key == "debug_mode":
        enabled = value == "true"
        configure_debug_logging(enabled)
        logger.info("Debug mode setting changed to %s", enabled)


def _is_admin(db: Session, user_id: int) -> bool:
    user = db.query(User).filter(User.id == user_id).first()
    return user is not None and user.role == "admin"


def _get_user_settings(db: Session, user_id: int) -> dict:
    """Get all settings for a user: per-user from user_settings, global from settings."""
    result = {}

    # Only load admin-only keys from global settings
    for row in db.query(Setting).all():
        if row.key in ADMIN_ONLY_KEYS:
            result[row.key] = row.value

    # Load this user's own settings
    for row in db.query(UserSetting).filter(UserSetting.user_id == user_id).all():
        result[row.key] = row.value

    # Env var fallback ONLY for admin — other users get empty defaults
    if _is_admin(db, user_id):
        if "telegram_bot_token" not in result:
            env_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
            if env_token:
                result["telegram_bot_token"] = env_token
        if "telegram_chat_id" not in result:
            env_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
            if env_chat_id:
                result["telegram_chat_id"] = env_chat_id
        if "gemini_api_key" not in result:
            env_gemini = os.environ.get("GEMINI_API_KEY", "")
            if env_gemini:
                result["gemini_api_key"] = env_gemini

    for key, value in DEFAULT_SETTINGS.items():
        result.setdefault(key, value)

    return result


@router.get("/")
def get_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _get_user_settings(db, current_user.id)


@router.put("/")
def update_settings(data: dict, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    pending_side_effects = []
    for key, value in data.items():
        coerced_value = _coerce_setting_value(key, value)
        if key in ADMIN_ONLY_KEYS:
            if current_user.role != "admin":
                continue
            row = db.query(Setting).filter(Setting.key == key).first()
            if row:
                row.value = coerced_value
            else:
                db.add(Setting(key=key, value=coerced_value))
            pending_side_effects.append((key, coerced_value))
        else:
            row = db.query(UserSetting).filter(
                UserSetting.user_id == current_user.id, UserSetting.key == key
            ).first()
            if row:
                row.value = coerced_value
            else:
                db.add(UserSetting(user_id=current_user.id, key=key, value=coerced_value))
    db.commit()
    for key, value in pending_side_effects:
        _apply_setting_side_effect(key, value)
    return _get_user_settings(db, current_user.id)


@router.get("/debug-log")
def download_debug_log(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    path = get_debug_log_path()
    return FileResponse(
        path,
        filename="pokecollector-debug.log",
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@router.get("/telegram_status")
def get_telegram_status(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    settings = _get_user_settings(db, current_user.id)
    token = settings.get("telegram_bot_token", "")
    chat_id = settings.get("telegram_chat_id", "")
    return {"configured": bool(token and chat_id)}


@router.get("/{key}")
def get_setting(key: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if key == "sync_interval_hours":
        settings = _get_user_settings(db, current_user.id)
        days = int(settings.get("full_sync_interval_days", "5"))
        return {"key": key, "value": str(days * 24)}
    settings = _get_user_settings(db, current_user.id)
    if key in settings:
        return {"key": key, "value": settings[key]}
    raise HTTPException(status_code=404, detail=f"Setting {key} not found")


@router.post("/{key}")
def set_setting(key: str, body: dict, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    value = _coerce_setting_value(key, body.get("value", ""))
    if key in ADMIN_ONLY_KEYS:
        if current_user.role != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value))
        pending_side_effect = (key, value)
    else:
        row = db.query(UserSetting).filter(
            UserSetting.user_id == current_user.id, UserSetting.key == key
        ).first()
        if row:
            row.value = value
        else:
            db.add(UserSetting(user_id=current_user.id, key=key, value=value))
    db.commit()
    if key in ADMIN_ONLY_KEYS:
        _apply_setting_side_effect(*pending_side_effect)
    return {"key": key, "value": value}
