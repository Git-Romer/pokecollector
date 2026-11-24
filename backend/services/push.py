"""Web Push (VAPID) delivery for wishlist price alerts.

See docs/PWA_OFFLINE_DESIGN.md §6.7. The server POSTs to an endpoint that the client
supplied, so subscriptions are only accepted for the known push-service hosts.
"""

from __future__ import annotations

import base64
import datetime
import fcntl
import ipaddress
import json
import logging
import os
import tempfile
import threading
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from sqlalchemy.orm import Session

from models import PushSubscription

try:  # pywebpush is a hard requirement of the backend image; tolerate its absence in lightweight test envs.
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
except ModuleNotFoundError:  # pragma: no cover
    Vapid = None
    webpush = None

    class WebPushException(Exception):  # type: ignore[no-redef]
        response = None

logger = logging.getLogger(__name__)

DEFAULT_VAPID_SUBJECT = "https://github.com/Git-Romer/pokecollector"
MAX_ENDPOINT_LENGTH = 2048
MAX_PAYLOAD_BYTES = 4096
MAX_FAILURES = 10
PUSH_TTL_SECONDS = 86400
PUSH_TIMEOUT_SECONDS = 10
ALERT_NAVIGATE_PATH = "/wishlist"

# Exact hosts and dot-prefixed domain suffixes of the push services that browsers use.
_ALLOWED_HOSTS = {"fcm.googleapis.com"}
_ALLOWED_SUFFIXES = (".push.apple.com", ".push.services.mozilla.com", ".notify.windows.com")


def validate_push_endpoint(raw_endpoint: str) -> str:
    """Return the endpoint unchanged or raise ValueError when it is not an allowed push-service URL."""
    endpoint = (raw_endpoint or "").strip()
    if not endpoint or len(endpoint) > MAX_ENDPOINT_LENGTH:
        raise ValueError("Push endpoint is missing or too long")
    parsed = urlparse(endpoint)
    if parsed.scheme != "https":
        raise ValueError("Push endpoint must use https")
    if parsed.username or parsed.password:
        raise ValueError("Push endpoint must not include credentials")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Push endpoint has an invalid port") from exc
    if port not in (None, 443):
        raise ValueError("Push endpoint must use the default HTTPS port")
    host = (parsed.hostname or "").rstrip(".").lower()
    if not host:
        raise ValueError("Push endpoint must include a host")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("Push endpoint host must not be an IP address")
    if host in _ALLOWED_HOSTS or any(host.endswith(suffix) for suffix in _ALLOWED_SUFFIXES):
        return endpoint
    raise ValueError("Push endpoint host is not a known push service")


# --- VAPID key pair -----------------------------------------------------------------

_vapid_lock = threading.Lock()
_vapid_cache: tuple | None = None


def _vapid_key_file() -> str:
    return os.getenv(
        "VAPID_PRIVATE_KEY_FILE",
        os.path.join(os.getenv("DATA_DIR", "/app/data"), "auth", "vapid_private.pem"),
    )


def vapid_subject() -> str:
    configured = (os.getenv("VAPID_SUBJECT") or "").strip()
    return configured or DEFAULT_VAPID_SUBJECT


def _public_key_b64(vapid) -> str:
    point = vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.urlsafe_b64encode(point).rstrip(b"=").decode("ascii")


def _new_vapid():
    vapid = Vapid()
    vapid.generate_keys()
    return vapid


def _vapid_from_pem(pem: bytes):
    return Vapid.from_pem(pem)


def _pem_bytes(vapid) -> bytes:
    return vapid.private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def _load_or_create_vapid():
    configured = os.getenv("VAPID_PRIVATE_KEY")
    if configured and configured.strip():
        value = configured.strip().replace("\\n", "\n")
        try:
            if "BEGIN" in value:
                return _vapid_from_pem(value.encode("ascii"))
            return Vapid.from_string(value)
        except Exception:
            logger.warning("VAPID_PRIVATE_KEY is set but could not be parsed; ignoring it.")

    key_file = _vapid_key_file()
    key_dir = os.path.dirname(key_file) or "."
    tmp_path = None
    try:
        os.makedirs(key_dir, mode=0o700, exist_ok=True)
        lock_fd = os.open(f"{key_file}.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            if os.path.exists(key_file):
                with open(key_file, "rb") as fh:
                    existing = fh.read()
                if existing.strip():
                    return _vapid_from_pem(existing)

            vapid = _new_vapid()
            tmp_fd, tmp_path = tempfile.mkstemp(prefix=".vapid_private.", dir=key_dir)
            try:
                os.fchmod(tmp_fd, 0o600)
                with os.fdopen(tmp_fd, "wb") as fh:
                    tmp_fd = None
                    fh.write(_pem_bytes(vapid))
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp_path, key_file)
                tmp_path = None
            finally:
                if tmp_fd is not None:
                    os.close(tmp_fd)
                if tmp_path is not None:
                    try:
                        os.unlink(tmp_path)
                    except FileNotFoundError:
                        pass
            logger.info("Generated and persisted a VAPID key pair at %s", key_file)
            return vapid
        finally:
            os.close(lock_fd)
    except OSError as exc:
        logger.warning(
            "Could not persist a VAPID key (%s); using an ephemeral one. Push subscriptions "
            "will stop working after a restart. Set VAPID_PRIVATE_KEY to a fixed value.",
            exc,
        )
        return _new_vapid()


def get_or_create_vapid_keys() -> tuple:
    """Return (Vapid instance, base64url uncompressed public point). The private key is never logged."""
    global _vapid_cache
    with _vapid_lock:
        if _vapid_cache is None:
            vapid = _load_or_create_vapid()
            # py_vapid's strict check rejects https subjects that carry a path, such as the
            # default project URL. Apple accepts any URL or mailto: here, so skip that check.
            vapid.conf = {**(getattr(vapid, "conf", None) or {}), "no-strict": True}
            _vapid_cache = (vapid, _public_key_b64(vapid))
        return _vapid_cache


def _reset_vapid_cache() -> None:
    global _vapid_cache
    with _vapid_lock:
        _vapid_cache = None


# --- sending -------------------------------------------------------------------------


def _encode_payload(title: str, body: str, navigate: str) -> str:
    return json.dumps(
        {"web_push": 8030, "notification": {"title": title, "body": body, "navigate": navigate}},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def build_price_alert_payload(card_name: str) -> str:
    """Declarative Web Push JSON, at most 4096 bytes UTF-8. Only the card name is included."""
    name = (card_name or "").strip() or "Card"
    name = name[:120]
    while True:
        payload = _encode_payload("Wishlist price alert", name, ALERT_NAVIGATE_PATH)
        if len(payload.encode("utf-8")) <= MAX_PAYLOAD_BYTES or len(name) <= 1:
            return payload
        name = name[: max(1, len(name) // 2)]


def _status_of(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def _send_one(db: Session, sub: PushSubscription, payload: str, vapid, now: datetime.datetime) -> str:
    """Send to one subscription and apply the outcome rules. Returns 'sent', 'removed' or 'skipped'."""
    try:
        webpush(
            subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
            data=payload,
            vapid_private_key=vapid,
            vapid_claims={"sub": vapid_subject()},
            ttl=PUSH_TTL_SECONDS,
            headers={"Urgency": "normal"},
            timeout=PUSH_TIMEOUT_SECONDS,
        )
    except WebPushException as exc:
        status = _status_of(exc)
        if status in (404, 410):
            db.delete(sub)
            return "removed"
        if status == 403:
            logger.warning("Push service rejected VAPID credentials for subscription %s (403)", sub.id)
            return "skipped"
        if status == 429:
            return "skipped"
        return _record_failure(db, sub, f"HTTP {status}" if status else "no response")
    except Exception as exc:  # network errors, timeouts, malformed keys
        return _record_failure(db, sub, type(exc).__name__)

    sub.last_success_at = now
    sub.failure_count = 0
    return "sent"


def _record_failure(db: Session, sub: PushSubscription, reason: str) -> str:
    sub.failure_count = (sub.failure_count or 0) + 1
    logger.warning("Push to subscription %s failed (%s); failure %s/%s", sub.id, reason, sub.failure_count, MAX_FAILURES)
    if sub.failure_count >= MAX_FAILURES:
        db.delete(sub)
        return "removed"
    return "skipped"


def send_to_user(db: Session, user_id: int, payload: dict | str) -> dict:
    """Send a payload (dict or prepared JSON string) to every subscription of the user."""
    body = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(body.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        raise ValueError("Push payload exceeds 4096 bytes")

    subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
    result = {"sent": 0, "removed": 0}
    if not subs:
        return result

    vapid, _public = get_or_create_vapid_keys()
    now = datetime.datetime.utcnow()
    for sub in subs:
        outcome = _send_one(db, sub, body, vapid, now)
        if outcome in result:
            result[outcome] += 1
    db.commit()
    return result


def send_test(db: Session, user_id: int) -> dict:
    payload = _encode_payload("Test notification", "Notifications are working on this device.", ALERT_NAVIGATE_PATH)
    return send_to_user(db, user_id, payload)


def send_price_alert(
    db: Session, user_id: int, card_name: str, price: float, threshold: float, alert_type: str
) -> dict:
    """Notify a user's devices about a wishlist price alert. Price and threshold are deliberately not sent."""
    return send_to_user(db, user_id, build_price_alert_payload(card_name))
