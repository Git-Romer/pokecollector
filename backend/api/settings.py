import logging
import os
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from api.auth import get_current_user
from sqlalchemy.orm import Session
from database import get_db
from models import CollectionCardPhoto, Setting, UserSetting, User
from services.debug_logging import configure_debug_logging, get_debug_log_path
from services.digital_sets import DIGITAL_SETS_SETTING_KEY, refresh_digital_catalogue_flags
from services.exchange_rates import (
    ExchangeRateError,
    fallback_exchange_rate,
    normalize_currency_pair,
    parse_frankfurter_v2_rate,
)
from services.card_visibility import get_visible_filter_languages
from services.public_profile_feature import PUBLIC_PROFILES_SETTING_KEY
from services.tcgdex_languages import (
    DEFAULT_TCGDEX_SYNC_LANGUAGES,
    supported_tcgdex_language_payload,
    validate_tcgdex_sync_languages,
)
from services.scan_trace import (
    SCAN_DIAGNOSTICS_SETTING_KEY,
    delete_user_traces,
    trace_available,
    trace_deletion_available,
)

from services.scan_providers import (
    DEFAULT_OPENAI_BASE_URL,
    GEMINI,
    OPENAI,
    SCANNER_MODEL_SETTINGS,
    ScanProvider,
    allowed_models,
    enabled_providers,
    image_part,
    installation_model,
    openai_base_url,
    openai_enabled,
    openai_requires_key,
    provider_key_help_url,
    provider_label,
    resolve_model,
    resolve_provider_name,
    SCANNER_PROVIDER_SETTING,
    SCANNER_PROVIDER_GUIDE_URL,
    text_part,
)

router = APIRouter()
logger = logging.getLogger(__name__)
PHOTO_PREFERENCE_SETTING_KEY = "prefer_own_card_photos"

PER_USER_KEYS = {
    "language", "currency", "price_primary", "price_display",
    "set_overview_filters", "hidden_set_ids",
    "telegram_bot_token", "telegram_chat_id", "telegram_enabled",
    "price_alerts_enabled", "price_alert_threshold",
    "gemini_api_key", "trainer_name", "portfolio_display_mode",
    "openai_api_key",
    SCANNER_PROVIDER_SETTING, *SCANNER_MODEL_SETTINGS.values(),
    SCAN_DIAGNOSTICS_SETTING_KEY, PHOTO_PREFERENCE_SETTING_KEY,
}

MANAGED_SCANNER_KEYS = {
    "gemini_api_key",
    "openai_api_key",
    SCANNER_PROVIDER_SETTING,
    *SCANNER_MODEL_SETTINGS.values(),
    # Prevent the removed PR prototype settings from being recreated through
    # the legacy generic endpoint.
    "scanner_model",
    "scanner_visual_verification",
}


class ScannerConfigurationUpdate(BaseModel):
    provider: str
    model: str
    api_key: str | None = None
    clear_api_key: bool = False


SCANNER_TEST_IMAGE_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF"
    "gAI/6hZ6WQAAAABJRU5ErkJggg=="
)

ADMIN_ONLY_KEYS = {
    "full_sync_interval_days", "price_sync_interval_minutes", "multi_user_mode",
    "tcgdex_sync_languages", "debug_mode",
    "cross_language_price_fallback", "cross_language_image_fallback",
    DIGITAL_SETS_SETTING_KEY,
    PUBLIC_PROFILES_SETTING_KEY,
}

DEFAULT_SETTINGS = {
    "trainer_name": "TRAINER",
    "full_sync_interval_days": "5",
    "price_sync_interval_minutes": "30",
    "telegram_enabled": "false",
    "telegram_chat_id": "",
    "price_alerts_enabled": "false",
    "price_alert_threshold": "10",
    "language": "en",
    "currency": "EUR",
    "price_primary": "trend",
    "portfolio_display_mode": "portfolio_value",
    "price_display": '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
    "set_overview_filters": "{}",
    "hidden_set_ids": "[]",
    "tcgdex_sync_languages": "en,de",
    DIGITAL_SETS_SETTING_KEY: "true",
    "cross_language_price_fallback": "true",
    "cross_language_image_fallback": "true",
    "debug_mode": "false",
    PUBLIC_PROFILES_SETTING_KEY: "false",
    SCAN_DIAGNOSTICS_SETTING_KEY: "false",
    PHOTO_PREFERENCE_SETTING_KEY: "false",
}


def _normalize_tcgdex_sync_languages(value) -> str:
    try:
        return validate_tcgdex_sync_languages(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _coerce_setting_value(key: str, value) -> str:
    if key == "tcgdex_sync_languages":
        return _normalize_tcgdex_sync_languages(value)
    if key in {
        "debug_mode", "cross_language_price_fallback",
        "cross_language_image_fallback", DIGITAL_SETS_SETTING_KEY,
        PUBLIC_PROFILES_SETTING_KEY, SCAN_DIAGNOSTICS_SETTING_KEY,
        PHOTO_PREFERENCE_SETTING_KEY,
    }:
        return "true" if str(value).lower() in {"true", "1", "yes", "on"} else "false"
    if key == "portfolio_display_mode":
        normalized = str(value).strip().lower()
        if normalized not in {"portfolio_value", "capital_invested"}:
            raise HTTPException(status_code=422, detail="portfolio_display_mode is invalid")
        return normalized
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
        if row.key not in MANAGED_SCANNER_KEYS:
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

    for key, value in DEFAULT_SETTINGS.items():
        result.setdefault(key, value)
    result["scan_diagnostics_available"] = "true" if trace_available() else "false"
    result["scan_diagnostics_deletion_available"] = (
        "true" if trace_deletion_available() else "false"
    )

    return result


@router.get("/")
def get_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return _get_user_settings(db, current_user.id)


def _scanner_key_name(provider: str) -> str:
    return "gemini_api_key" if provider == GEMINI else "openai_api_key"


def _scanner_requires_key(provider: str) -> bool:
    return provider == GEMINI or openai_requires_key()


def _user_setting(db: Session, user_id: int, key: str) -> UserSetting | None:
    return db.query(UserSetting).filter(
        UserSetting.user_id == user_id, UserSetting.key == key
    ).first()


def _safe_endpoint_summary(url: str) -> str:
    """Show admins where requests go without reflecting credentials or query data."""
    try:
        parsed = urlsplit(url)
        if not parsed.scheme or not parsed.hostname:
            return "Configured endpoint"
        host = parsed.hostname
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port else ""
        return urlunsplit((parsed.scheme, f"{host}{port}", "", "", ""))
    except (TypeError, ValueError):
        return "Configured endpoint"


def _administrator_scanner_summary() -> dict:
    openai_hosted = openai_base_url() == DEFAULT_OPENAI_BASE_URL
    return {
        "setup_guide_url": SCANNER_PROVIDER_GUIDE_URL,
        "providers": [
            {
                "id": GEMINI,
                "label": provider_label(GEMINI),
                "enabled": True,
                "endpoint_type": "hosted",
                "endpoint": "Google Gemini API",
                "models": allowed_models(GEMINI),
                "requires_api_key": True,
            },
            {
                "id": OPENAI,
                "label": provider_label(OPENAI),
                "enabled": openai_enabled(),
                "endpoint_type": "hosted" if openai_hosted else "custom",
                "endpoint": _safe_endpoint_summary(openai_base_url()),
                "models": allowed_models(OPENAI),
                "requires_api_key": openai_requires_key(),
            },
        ],
    }


def _scanner_configuration(db: Session, user_id: int, *, is_admin: bool = False) -> dict:
    selected = resolve_provider_name(db, user_id)
    providers = []
    for provider in enabled_providers():
        key_row = _user_setting(db, user_id, _scanner_key_name(provider))
        key_configured = bool(key_row and key_row.value)
        providers.append({
            "id": provider,
            "label": provider_label(provider),
            "models": allowed_models(provider),
            "default_model": installation_model(provider),
            "selected_model": resolve_model(db, user_id, provider),
            "requires_api_key": _scanner_requires_key(provider),
            "api_key_configured": key_configured,
            "endpoint_type": (
                "hosted"
                if provider == GEMINI or openai_base_url() == DEFAULT_OPENAI_BASE_URL
                else "custom"
            ),
            "key_help_url": provider_key_help_url(provider),
            "setup_help_url": SCANNER_PROVIDER_GUIDE_URL,
        })
    active = next(item for item in providers if item["id"] == selected)
    ready = not active["requires_api_key"] or active["api_key_configured"]
    status = (
        "admin_setup_required"
        if not active["models"]
        else ("ready" if ready else "api_key_required")
    )
    result = {
        "provider": selected,
        "model": active["selected_model"] if active["selected_model"] in active["models"] else active["default_model"],
        "providers": providers,
        "status": status,
        "visual_verification": "automatic",
    }
    if is_admin:
        result["administrator"] = _administrator_scanner_summary()
    return result


def _validated_scanner_draft(
    data: ScannerConfigurationUpdate,
    db: Session,
    user_id: int,
    *,
    require_ready: bool = False,
) -> tuple[str, str, str]:
    provider = data.provider.strip().lower()
    if provider not in enabled_providers():
        raise HTTPException(status_code=422, detail="This scanner provider is not enabled by the administrator.")
    model = data.model.strip()
    if model not in allowed_models(provider):
        raise HTTPException(status_code=422, detail="Choose one of the models enabled by the administrator.")
    if data.api_key is not None and len(data.api_key) > 4096:
        raise HTTPException(status_code=422, detail="API key is too long.")
    existing = _user_setting(db, user_id, _scanner_key_name(provider))
    credential = (existing.value if existing else "") or ""
    if data.clear_api_key:
        credential = ""
    elif data.api_key is not None:
        credential = data.api_key.strip()
    if require_ready and _scanner_requires_key(provider) and not credential:
        raise HTTPException(status_code=422, detail="An API key is required for this provider.")
    return provider, model, credential


def _upsert_user_setting(db: Session, user_id: int, key: str, value: str) -> None:
    row = _user_setting(db, user_id, key)
    if row:
        row.value = value
    else:
        db.add(UserSetting(user_id=user_id, key=key, value=value))


@router.get("/scanner")
def get_scanner_configuration(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    return _scanner_configuration(db, current_user.id, is_admin=current_user.role == "admin")


@router.put("/scanner")
def update_scanner_configuration(
    data: ScannerConfigurationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    provider, model, credential = _validated_scanner_draft(data, db, current_user.id)
    _upsert_user_setting(db, current_user.id, SCANNER_PROVIDER_SETTING, provider)
    _upsert_user_setting(db, current_user.id, SCANNER_MODEL_SETTINGS[provider], model)
    if data.api_key is not None or data.clear_api_key:
        _upsert_user_setting(db, current_user.id, _scanner_key_name(provider), credential)
    db.commit()
    return _scanner_configuration(db, current_user.id, is_admin=current_user.role == "admin")


@router.post("/scanner/test")
async def test_scanner_configuration(
    data: ScannerConfigurationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    provider, model, credential = _validated_scanner_draft(
        data, db, current_user.id, require_ready=True
    )
    candidate = ScanProvider(provider, model)
    async with httpx.AsyncClient(timeout=30) as client:
        text, _usage = await candidate.generate_text(
            client,
            credential,
            [
                text_part("Inspect this image, then reply with only OK."),
                image_part("image/png", SCANNER_TEST_IMAGE_B64),
            ],
            max_attempts=1,
        )
    if not text.strip().lower().startswith("ok"):
        raise HTTPException(
            status_code=502,
            detail="The selected model did not complete the scanner image test.",
        )
    return {"status": "ready"}


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
    if MANAGED_SCANNER_KEYS.intersection(data):
        raise HTTPException(
            status_code=409,
            detail="Use the atomic scanner configuration endpoint for scanner settings.",
        )
    pending_side_effects = []
    for key, value in data.items():
        if key == "multi_user_mode":
            raise HTTPException(
                status_code=409,
                detail="Multi-user mode can only be changed through /api/auth/mode",
            )
        coerced_value = _coerce_setting_value(key, value)
        if key in ADMIN_ONLY_KEYS:
            if current_user.role != "admin":
                if key == PUBLIC_PROFILES_SETTING_KEY:
                    raise HTTPException(status_code=403, detail="Admin only")
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
    return Response(
        content=path.read_bytes(),
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="pokecollector-debug.log"',
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@router.delete("/scan-diagnostics")
def delete_scan_diagnostics(
    current_user: User = Depends(get_current_user),
):
    try:
        deleted = delete_user_traces(current_user.id)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="Stored scanner diagnostics could not be deleted.",
        ) from exc
    return {"deleted": deleted}


@router.delete("/card-photos")
def delete_card_photos(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete only this user's private collection-card photos."""
    deleted = db.query(CollectionCardPhoto).filter(
        CollectionCardPhoto.user_id == current_user.id,
    ).delete(synchronize_session=False)
    db.commit()
    return {"deleted": int(deleted or 0)}


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
    if key in MANAGED_SCANNER_KEYS:
        raise HTTPException(
            status_code=409,
            detail="Use the scanner configuration endpoint for scanner settings.",
        )
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
    if key in MANAGED_SCANNER_KEYS:
        raise HTTPException(
            status_code=409,
            detail="Use the atomic scanner configuration endpoint for scanner settings.",
        )
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
