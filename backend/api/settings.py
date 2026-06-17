import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from api.auth import get_current_user
from sqlalchemy.orm import Session
from database import get_db
from models import Setting, UserSetting, User
from services.debug_logging import configure_debug_logging, get_debug_log_path
from services.digital_sets import DIGITAL_SETS_SETTING_KEY, refresh_digital_catalogue_flags
from services.exchange_rates import (
    ExchangeRateError,
    fallback_exchange_rate,
    normalize_currency_pair,
    parse_frankfurter_v2_rate,
)
from services.card_visibility import get_visible_filter_languages
from services.tcgdex_languages import (
    DEFAULT_TCGDEX_SYNC_LANGUAGES,
    supported_tcgdex_language_payload,
    validate_tcgdex_sync_languages,
)

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
    DIGITAL_SETS_SETTING_KEY,
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
    "price_display": '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
    "tcgdex_sync_languages": "en,de",
    DIGITAL_SETS_SETTING_KEY: "true",
    "cross_language_price_fallback": "true",
    "cross_language_image_fallback": "true",
    "debug_mode": "false",
}


def _normalize_tcgdex_sync_languages(value) -> str:
    try:
        return validate_tcgdex_sync_languages(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _coerce_setting_value(key: str, value) -> str:
    if key == "tcgdex_sync_languages":
        return _normalize_tcgdex_sync_languages(value)
    if key in {"debug_mode", "cross_language_price_fallback", "cross_language_image_fallback", DIGITAL_SETS_SETTING_KEY}:
        return "true" if str(value).lower() in {"true", "1", "yes", "on"} else "false"
    return str(value)


def _apply_setting_side_effect(db: Session, key: str, value: str) -> None:
    if key == "debug_mode":
        enabled = value == "true"
        configure_debug_logging(enabled)
        logger.info("Debug mode setting changed to %s", enabled)
    elif key == DIGITAL_SETS_SETTING_KEY:
        result = refresh_digital_catalogue_flags(db)
        logger.info(
            "Digital set visibility changed to %s; marked %s digital sets and %s digital cards",
            value == "true",
            result["sets_marked"],
            result["cards_marked"],
        )


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


@router.get("/tcgdex-languages")
def get_tcgdex_languages(current_user: User = Depends(get_current_user)):
    return {
        "languages": supported_tcgdex_language_payload(),
        "default": list(DEFAULT_TCGDEX_SYNC_LANGUAGES),
        "english_fallback": "en",
    }


@router.get("/tcgdex-filter-languages")
def get_tcgdex_filter_languages(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    visible_codes = set(get_visible_filter_languages(db, current_user.id))
    return {
        "languages": [
            language for language in supported_tcgdex_language_payload()
            if language["code"] in visible_codes
        ],
    }


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
    for key, value in pending_side_effects:
        _apply_setting_side_effect(db, key, value)
    db.commit()
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


@router.get("/exchange-rate")
def get_exchange_rate(
    from_currency: str = Query(alias="from"),
    to_currency: str = Query(alias="to"),
    _current_user: User = Depends(get_current_user),
):
    try:
        source, target = normalize_currency_pair(from_currency, to_currency)
    except ExchangeRateError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None

    fallback_rate = fallback_exchange_rate(source, target)
    if source == target:
        return {"from": source, "to": target, "rate": fallback_rate, "fallback": False}

    try:
        response = httpx.get(
            f"https://api.frankfurter.dev/v2/rate/{source}/{target}",
            timeout=8,
        )
        response.raise_for_status()
        rate = parse_frankfurter_v2_rate(response.json())
        return {"from": source, "to": target, "rate": rate, "fallback": False}
    except Exception as exc:
        logger.warning("Failed to fetch exchange rate %s to %s: %s", source, target, exc)
        return {"from": source, "to": target, "rate": fallback_rate, "fallback": True}


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
    if key in ADMIN_ONLY_KEYS:
        _apply_setting_side_effect(db, *pending_side_effect)
    db.commit()
    return {"key": key, "value": value}
