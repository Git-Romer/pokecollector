import os
from fastapi import APIRouter, Depends, HTTPException
from api.auth import get_current_user
from sqlalchemy.orm import Session
from database import get_db
from models import Setting, UserSetting, User

router = APIRouter()

PER_USER_KEYS = {
    "language", "currency", "price_primary", "price_display",
    "telegram_bot_token", "telegram_chat_id", "telegram_enabled",
    "price_alerts_enabled", "price_alert_threshold",
    "gemini_api_key", "trainer_name",
}

ADMIN_ONLY_KEYS = {
    "full_sync_interval_days", "price_sync_interval_minutes", "multi_user_mode",
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
}


def _get_user_settings(db: Session, user_id: int) -> dict:
    """Get all settings for a user: per-user from user_settings, global from settings."""
    result = {}

    for row in db.query(Setting).all():
        if row.key in ADMIN_ONLY_KEYS or row.key in PER_USER_KEYS:
            result[row.key] = row.value

    for row in db.query(UserSetting).filter(UserSetting.user_id == user_id).all():
        result[row.key] = row.value

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
    for key, value in data.items():
        if key in ADMIN_ONLY_KEYS:
            if current_user.role != "admin":
                continue
            row = db.query(Setting).filter(Setting.key == key).first()
            if row:
                row.value = str(value)
            else:
                db.add(Setting(key=key, value=str(value)))
        else:
            row = db.query(UserSetting).filter(
                UserSetting.user_id == current_user.id, UserSetting.key == key
            ).first()
            if row:
                row.value = str(value)
            else:
                db.add(UserSetting(user_id=current_user.id, key=key, value=str(value)))
    db.commit()
    return _get_user_settings(db, current_user.id)


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
    value = str(body.get("value", ""))
    if key in ADMIN_ONLY_KEYS:
        if current_user.role != "admin":
            raise HTTPException(status_code=403, detail="Admin only")
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value))
    else:
        row = db.query(UserSetting).filter(
            UserSetting.user_id == current_user.id, UserSetting.key == key
        ).first()
        if row:
            row.value = value
        else:
            db.add(UserSetting(user_id=current_user.id, key=key, value=value))
    db.commit()
    return {"key": key, "value": value}
