import httpx
import os
import logging

logger = logging.getLogger(__name__)


def _get_telegram_credentials(db=None, user_id=None):
    """Read Telegram credentials from user settings first, fallback to env vars."""
    token = ""
    chat_id = ""
    if db is not None and user_id is not None:
        try:
            from models import UserSetting
            token_row = db.query(UserSetting).filter(
                UserSetting.user_id == user_id, UserSetting.key == "telegram_bot_token"
            ).first()
            chat_row = db.query(UserSetting).filter(
                UserSetting.user_id == user_id, UserSetting.key == "telegram_chat_id"
            ).first()
            if token_row and token_row.value:
                token = token_row.value
            if chat_row and chat_row.value:
                chat_id = chat_row.value
        except Exception:
            pass
    if db is not None and not token:
        try:
            from models import Setting
            token_row = db.query(Setting).filter(Setting.key == "telegram_bot_token").first()
            chat_row = db.query(Setting).filter(Setting.key == "telegram_chat_id").first()
            if token_row and token_row.value:
                token = token_row.value
            if chat_row and chat_row.value:
                chat_id = chat_row.value
        except Exception:
            pass
    # Fallback to environment variables
    if not token:
        token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    if not chat_id:
        chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    return token, chat_id


def is_configured(db=None, user_id=None) -> bool:
    """Check if Telegram is configured (from DB or env)."""
    token, chat_id = _get_telegram_credentials(db, user_id=user_id)
    return bool(token and chat_id)


def send_message(text: str, db=None, user_id=None) -> bool:
    """Send a message via Telegram Bot API."""
    token, chat_id = _get_telegram_credentials(db, user_id=user_id)
    if not token or not chat_id:
        logger.warning("Telegram not configured, skipping notification")
        return False

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
    }

    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.post(url, json=payload)
            response.raise_for_status()
            return True
    except Exception as e:
        logger.error(f"Failed to send Telegram message: {e}")
        return False


def send_price_alert(card_name: str, current_price: float, threshold: float, alert_type: str, db=None, user_id=None):
    """Send a price alert notification."""
    emoji = "📈" if alert_type == "above" else "📉"
    direction = "above" if alert_type == "above" else "below"

    text = (
        f"{emoji} <b>Pokemon TCG Price Alert</b>\n\n"
        f"🃏 <b>{card_name}</b>\n"
        f"Current price: <b>€{current_price:.2f}</b>\n"
        f"Alert threshold ({direction}): <b>€{threshold:.2f}</b>\n\n"
        f"Check your collection! 🎯"
    )
    return send_message(text, db=db, user_id=user_id)


def send_new_sets_notification(new_sets: list, db=None, user_id=None):
    """Notify about newly detected sets."""
    if not new_sets:
        return False

    sets_list = "\n".join([f"• {s['name']} ({s['series']})" for s in new_sets[:10]])
    text = (
        f"🆕 <b>New Pokemon Sets Detected!</b>\n\n"
        f"{sets_list}\n\n"
        f"Check your collection app to explore! 🎮"
    )
    return send_message(text, db=db, user_id=user_id)
