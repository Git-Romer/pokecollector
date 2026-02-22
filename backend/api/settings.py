import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from models import Setting

router = APIRouter()

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
}


@router.get("/")
def get_settings(db: Session = Depends(get_db)):
    """Return all settings as a JSON object."""
    rows = db.query(Setting).all()
    result = dict(DEFAULT_SETTINGS)
    result.update({row.key: row.value for row in rows})
    return result


@router.put("/")
def update_settings(data: dict, db: Session = Depends(get_db)):
    """Update one or more settings. Accepts a JSON object with key-value pairs."""
    for key, value in data.items():
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = str(value)
        else:
            db.add(Setting(key=key, value=str(value)))
    db.commit()
    rows = db.query(Setting).all()
    result = dict(DEFAULT_SETTINGS)
    result.update({row.key: row.value for row in rows})
    return result


@router.get("/telegram_status")
def get_telegram_status(db: Session = Depends(get_db)):
    """Check if Telegram bot token is configured (DB first, then env)."""
    # Check DB first
    token_row = db.query(Setting).filter(Setting.key == "telegram_bot_token").first()
    token = token_row.value if (token_row and token_row.value) else os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_row = db.query(Setting).filter(Setting.key == "telegram_chat_id").first()
    chat_id = chat_row.value if (chat_row and chat_row.value) else os.environ.get("TELEGRAM_CHAT_ID", "")
    return {"configured": bool(token and chat_id)}


@router.get("/{key}")
def get_setting(key: str, db: Session = Depends(get_db)):
    """Return a single setting value."""
    # Legacy alias: sync_interval_hours → full_sync_interval_days
    if key == "sync_interval_hours":
        row = db.query(Setting).filter(Setting.key == "full_sync_interval_days").first()
        days = int(row.value) if row else 5
        return {"key": key, "value": str(days * 24)}
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        return {"key": key, "value": row.value}
    # Return default if exists
    if key in DEFAULT_SETTINGS:
        return {"key": key, "value": DEFAULT_SETTINGS[key]}
    raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")


@router.post("/{key}")
def set_setting(key: str, body: dict, db: Session = Depends(get_db)):
    """Set a single setting value. Body: {value: '...'}"""
    value = str(body.get("value", ""))
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))
    db.commit()
    return {"key": key, "value": value}
