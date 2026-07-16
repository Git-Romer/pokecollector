from __future__ import annotations

import datetime
import json
import logging
import os
from dataclasses import dataclass, field
from html.parser import HTMLParser
from threading import Lock
from typing import TYPE_CHECKING
from typing import Any
from urllib.parse import urljoin, urlparse

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from models import User

logger = logging.getLogger(__name__)

POKEMON_CENTER_URL = "https://www.pokemoncenter.com/"
DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_BROWSER_TIMEOUT_SECONDS = 30.0
NOTIFICATION_COOLDOWN_MINUTES = 60
_CHECK_LOCK = Lock()

QUEUE_STRONG_MARKERS = (
    "queue-it",
    "queueit",
    "queueittoken",
    "x-queueittoken",
    "waiting room",
    "virtual waiting room",
    "estimated wait",
    "estimated wait time",
    "you are now in line",
    "you are in line",
    "line is paused",
    "redirect you to the pokemon center",
)

QUEUE_URL_MARKERS = (
    "queue",
    "queue-it",
    "queueit",
    "waitingroom",
    "waiting-room",
)

BOT_PROTECTION_MARKERS = (
    "incapsula",
    "_incapsula_resource",
    "imperva",
    "distil_referrer",
    "request unsuccessful. incapsula incident id",
    "access denied",
    "captcha",
    "bot detection",
)

BOT_PROTECTION_HEADER_MARKERS = (
    "x-iinfo",
    "visid_incap",
    "incap_ses",
)

INCAPSULA_RESOURCE_MARKER = "_incapsula_resource"


@dataclass
class QueueDetectionResult:
    status: str
    evidence: dict[str, Any] = field(default_factory=dict)
    final_url: str = POKEMON_CENTER_URL
    http_status: int | None = None
    error_message: str | None = None


def _contains_any(value: str, markers: tuple[str, ...]) -> list[str]:
    haystack = (value or "").lower()
    return [marker for marker in markers if marker in haystack]


def _has_confident_queue_url(value: str) -> bool:
    parsed = urlparse(value or "")
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    return (
        host.startswith("queue.")
        or "queue-it" in host
        or "queueit" in host
        or "queue-it" in path
        or "queueit" in path
        or "waitingroom" in path
        or "waiting-room" in path
    )


class _IncapsulaResourceParser(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__()
        self.base_url = base_url
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() not in {"iframe", "script"}:
            return
        attr_map = {str(key).lower(): value for key, value in attrs}
        src = attr_map.get("src")
        if not src or INCAPSULA_RESOURCE_MARKER not in src.lower():
            return
        self.urls.append(urljoin(self.base_url, src))


def _incapsula_resource_urls(body: str, base_url: str) -> list[str]:
    parser = _IncapsulaResourceParser(base_url)
    try:
        parser.feed(body or "")
    except Exception:
        return []
    return parser.urls


def _coerce_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
    else:
        return None
    return number if number > 0 else None


def classify_incapsula_resource_response(
    *,
    url: str,
    status_code: int | None,
    headers: dict[str, str],
    body: str,
) -> QueueDetectionResult:
    """Inspect an Incapsula resource for explicit queue-position JSON."""
    normalized_headers = {str(key).lower(): str(value) for key, value in (headers or {}).items()}
    body_sample = (body or "")[:1000]
    evidence = {
        "url": url,
        "http_status": status_code,
        "content_type": normalized_headers.get("content-type"),
        "body_sample": body_sample,
    }

    try:
        payload = json.loads(body or "")
    except (TypeError, ValueError):
        payload = None

    if isinstance(payload, dict):
        position = _coerce_positive_int(payload.get("pos"))
        if position is None:
            position = _coerce_positive_int(payload.get("position"))
        evidence["json_keys"] = sorted(str(key) for key in payload.keys())[:20]
        if position is not None:
            evidence["queue_position"] = position
            return QueueDetectionResult(
                status="queue",
                evidence=evidence,
                final_url=url,
                http_status=status_code,
            )

    return QueueDetectionResult(
        status="unknown",
        evidence=evidence,
        final_url=url,
        http_status=status_code,
    )


def _merge_evidence(primary: dict[str, Any], secondary_key: str, secondary: dict[str, Any]) -> dict[str, Any]:
    return {
        **(primary or {}),
        secondary_key: secondary,
    }


def classify_queue_response(
    *,
    url: str,
    final_url: str,
    status_code: int | None,
    headers: dict[str, str],
    body: str,
) -> QueueDetectionResult:
    """Classify a Pokemon Center response without trying to bypass protections."""
    normalized_headers = {str(key).lower(): str(value) for key, value in (headers or {}).items()}
    header_blob = "\n".join(f"{key}: {value}" for key, value in normalized_headers.items())
    body_sample = (body or "")[:2000]

    queue_url_markers = _contains_any(final_url, QUEUE_URL_MARKERS)
    queue_url_confident = _has_confident_queue_url(final_url)
    queue_header_markers = _contains_any(header_blob, QUEUE_STRONG_MARKERS)
    queue_body_markers = _contains_any(body, QUEUE_STRONG_MARKERS)

    bot_header_markers = [
        marker
        for marker in BOT_PROTECTION_HEADER_MARKERS
        if marker in normalized_headers or marker in header_blob.lower()
    ]
    bot_body_markers = _contains_any(body, BOT_PROTECTION_MARKERS)

    evidence = {
        "url": url,
        "final_url": final_url,
        "http_status": status_code,
        "queue_url_markers": queue_url_markers,
        "queue_url_confident": queue_url_confident,
        "queue_header_markers": queue_header_markers,
        "queue_body_markers": queue_body_markers,
        "bot_header_markers": bot_header_markers,
        "bot_body_markers": bot_body_markers,
        "body_sample": body_sample,
    }

    if bot_header_markers or bot_body_markers:
        # Bot-protection pages often contain queue-like URLs or text snippets.
        # Only explicit Incapsula queue-position JSON is allowed to promote
        # those responses, and that is handled outside this classifier.
        return QueueDetectionResult(
            status="bot_protection",
            evidence=evidence,
            final_url=final_url,
            http_status=status_code,
        )

    if queue_url_confident or queue_header_markers or queue_body_markers:
        return QueueDetectionResult(
            status="queue",
            evidence=evidence,
            final_url=final_url,
            http_status=status_code,
        )

    if bot_header_markers or bot_body_markers:
        return QueueDetectionResult(
            status="bot_protection",
            evidence=evidence,
            final_url=final_url,
            http_status=status_code,
        )

    if status_code is not None and 200 <= status_code < 400:
        return QueueDetectionResult(
            status="normal",
            evidence=evidence,
            final_url=final_url,
            http_status=status_code,
        )

    return QueueDetectionResult(
        status="unknown",
        evidence=evidence,
        final_url=final_url,
        http_status=status_code,
    )


def classify_browser_snapshot(
    *,
    url: str,
    final_url: str,
    status_code: int | None,
    body: str,
    network_evidence: list[dict[str, Any]] | None = None,
) -> QueueDetectionResult:
    result = classify_queue_response(
        url=url,
        final_url=final_url,
        status_code=status_code,
        headers={},
        body=body,
    )
    result.evidence["browser_rendered"] = True
    if network_evidence:
        result.evidence["browser_network"] = network_evidence[:10]
        for item in network_evidence:
            position = _coerce_positive_int(item.get("queue_position"))
            if position is not None:
                result.evidence["queue_position"] = position
                return QueueDetectionResult(
                    status="queue",
                    evidence=result.evidence,
                    final_url=final_url,
                    http_status=status_code,
                )
    return result


def fetch_browser_queue_status(url: str = POKEMON_CENTER_URL) -> QueueDetectionResult:
    """Render Pokemon Center in Chromium and inspect page/network signals."""
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        return QueueDetectionResult(
            status="error",
            evidence={"url": url, "browser_rendered": True, "exception": type(exc).__name__},
            final_url=url,
            error_message=f"Browser queue check unavailable: {exc}",
        )

    timeout_ms = int(DEFAULT_BROWSER_TIMEOUT_SECONDS * 1000)
    network_evidence: list[dict[str, Any]] = []
    try:
        with sync_playwright() as playwright:
            executable_path = os.getenv("POKEMON_CENTER_BROWSER_EXECUTABLE", "/usr/bin/chromium")
            launch_kwargs: dict[str, Any] = {
                "headless": True,
                "args": ["--no-sandbox", "--disable-dev-shm-usage"],
            }
            if os.path.exists(executable_path):
                launch_kwargs["executable_path"] = executable_path
            browser = playwright.chromium.launch(**launch_kwargs)
            try:
                context = browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
                    ),
                    locale="en-US",
                    viewport={"width": 1365, "height": 900},
                )
                page = context.new_page()

                def inspect_response(response) -> None:
                    response_url = response.url or ""
                    if INCAPSULA_RESOURCE_MARKER not in response_url.lower():
                        return
                    try:
                        body = response.text()
                    except Exception as exc:
                        network_evidence.append(
                            {
                                "url": response_url,
                                "http_status": response.status,
                                "error": type(exc).__name__,
                            }
                        )
                        return
                    resource_result = classify_incapsula_resource_response(
                        url=response_url,
                        status_code=response.status,
                        headers=response.headers,
                        body=body,
                    )
                    evidence = {
                        "url": response_url,
                        "http_status": response.status,
                        "status": resource_result.status,
                        "content_type": resource_result.evidence.get("content_type"),
                    }
                    if "queue_position" in resource_result.evidence:
                        evidence["queue_position"] = resource_result.evidence["queue_position"]
                    network_evidence.append(evidence)

                page.on("response", inspect_response)
                response = None
                try:
                    response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                    page.wait_for_timeout(7000)
                except PlaywrightTimeoutError:
                    pass
                body = page.locator("body").inner_text(timeout=5000) if page.locator("body").count() else ""
                final_url = page.url or url
                status_code = response.status if response is not None else None
                return classify_browser_snapshot(
                    url=url,
                    final_url=final_url,
                    status_code=status_code,
                    body=body,
                    network_evidence=network_evidence,
                )
            finally:
                browser.close()
    except Exception as exc:
        return QueueDetectionResult(
            status="error",
            evidence={
                "url": url,
                "browser_rendered": True,
                "exception": type(exc).__name__,
                "browser_network": network_evidence[:10],
            },
            final_url=url,
            error_message=f"Browser queue check failed: {exc}",
        )


def fetch_queue_status(url: str = POKEMON_CENTER_URL) -> QueueDetectionResult:
    import httpx

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        with httpx.Client(timeout=DEFAULT_TIMEOUT_SECONDS, follow_redirects=True, headers=headers) as client:
            response = client.get(url)
            result = classify_queue_response(
                url=url,
                final_url=str(response.url),
                status_code=response.status_code,
                headers=dict(response.headers),
                body=response.text or "",
            )

            if result.status == "bot_protection":
                resource_urls = _incapsula_resource_urls(response.text or "", str(response.url))
                result.evidence["incapsula_resource_urls"] = resource_urls[:3]
                for resource_url in resource_urls[:1]:
                    try:
                        resource_response = client.get(
                            resource_url,
                            headers={
                                "Accept": "application/json,text/plain,*/*",
                                "Referer": str(response.url),
                            },
                        )
                        resource_result = classify_incapsula_resource_response(
                            url=str(resource_response.url),
                            status_code=resource_response.status_code,
                            headers=dict(resource_response.headers),
                            body=resource_response.text or "",
                        )
                        result.evidence["incapsula_resource_probe"] = resource_result.evidence
                        if resource_result.status == "queue":
                            resource_result.evidence = _merge_evidence(
                                result.evidence,
                                "incapsula_resource_probe",
                                resource_result.evidence,
                            )
                            return resource_result
                    except Exception as exc:
                        result.evidence["incapsula_resource_probe_error"] = type(exc).__name__
                        break

            if result.status in {"bot_protection", "normal", "unknown"}:
                browser_result = fetch_browser_queue_status(url)
                result.evidence["browser_probe"] = browser_result.evidence
                if browser_result.status in {"queue", "normal", "bot_protection"}:
                    browser_result.evidence = _merge_evidence(
                        result.evidence,
                        "browser_probe",
                        browser_result.evidence,
                    )
                    return browser_result
                if browser_result.status == "error":
                    result.evidence["browser_probe_error"] = browser_result.error_message

        return result
    except Exception as exc:
        evidence = {"url": url, "exception": type(exc).__name__}
        return QueueDetectionResult(
            status="error",
            evidence=evidence,
            final_url=url,
            error_message=str(exc),
        )


def _get_or_create_status_row(db: Session) -> PokemonCenterQueueStatus:
    from models import PokemonCenterQueueStatus

    row = db.query(PokemonCenterQueueStatus).order_by(PokemonCenterQueueStatus.id.asc()).first()
    if row:
        return row
    row = PokemonCenterQueueStatus(status="unknown", url=POKEMON_CENTER_URL)
    db.add(row)
    db.flush()
    return row


def _user_setting_map(db: Session, user_id: int) -> dict[str, str]:
    from models import UserSetting

    rows = db.query(UserSetting).filter(UserSetting.user_id == user_id).all()
    return {row.key: row.value for row in rows}


def _queue_alert_users(db: Session) -> list[User]:
    from models import User
    from services import telegram

    users = db.query(User).filter(User.is_active == True).all()
    enabled_users: list[User] = []
    for user in users:
        settings = _user_setting_map(db, user.id)
        if settings.get("pokemon_center_queue_alerts_enabled") != "true":
            continue
        if not telegram.is_configured(db=db, user_id=user.id):
            continue
        enabled_users.append(user)
    return enabled_users


def has_queue_alert_subscribers(db: Session) -> bool:
    return bool(_queue_alert_users(db))


def _notify_queue_started(db: Session, users: list[User]) -> int:
    from services import telegram

    message = (
        "🚨 <b>Pokemon Center Queue Detected</b>\n\n"
        "Pokemon Center appears to have opened a waiting room/queue.\n"
        "Open the site manually and join the queue:\n"
        f"{POKEMON_CENTER_URL}\n\n"
        "This alert does not join, bypass, or reserve a queue spot."
    )
    sent = 0
    for user in users:
        if telegram.send_message(message, db=db, user_id=user.id):
            sent += 1
    return sent


def check_pokemon_center_queue(db: Session, *, force: bool = False) -> dict[str, Any]:
    if not _CHECK_LOCK.acquire(blocking=False):
        logger.info("Pokemon Center queue check skipped: another check is already running")
        return {"status": "unknown", "skipped": True, "reason": "check already running"}

    try:
        subscribers = _queue_alert_users(db)
        if not subscribers and not force:
            row = _get_or_create_status_row(db)
            previous_status = row.status
            now = datetime.datetime.utcnow()
            reason = "no opted-in Telegram users"
            row.previous_status = previous_status
            row.checked_at = now
            row.url = POKEMON_CENTER_URL
            row.evidence = {"skipped": True, "reason": reason}
            row.error_message = reason
            db.commit()
            logger.info("Pokemon Center queue check skipped: %s", reason)
            return {
                "status": row.status,
                "previous_status": previous_status,
                "checked_at": row.checked_at.isoformat() if row.checked_at else None,
                "skipped": True,
                "reason": reason,
                "evidence": row.evidence,
                "error_message": row.error_message,
            }

        result = fetch_queue_status()
        row = _get_or_create_status_row(db)
        previous_status = row.status
        now = datetime.datetime.utcnow()

        row.previous_status = previous_status
        row.status = result.status
        row.checked_at = now
        row.url = POKEMON_CENTER_URL
        row.final_url = result.final_url
        row.http_status = result.http_status
        row.evidence = result.evidence
        row.error_message = result.error_message

        cooldown_cutoff = now - datetime.timedelta(minutes=NOTIFICATION_COOLDOWN_MINUTES)
        cooldown_allows_alert = row.notified_at is None or row.notified_at < cooldown_cutoff

        notified_count = 0
        if previous_status != "queue" and result.status == "queue" and subscribers and cooldown_allows_alert:
            notified_count = _notify_queue_started(db, subscribers)
            if notified_count > 0:
                row.notified_at = now

        db.commit()

        log_payload = {
            "status": result.status,
            "previous_status": previous_status,
            "http_status": result.http_status,
            "final_url": result.final_url,
            "notified_count": notified_count,
            "notification_cooldown_minutes": NOTIFICATION_COOLDOWN_MINUTES,
            "notification_cooldown_allows_alert": cooldown_allows_alert,
            "evidence": result.evidence,
            "error_message": result.error_message,
        }
        if result.status == "queue":
            logger.warning("Pokemon Center queue detected: %s", log_payload)
        elif result.status in {"bot_protection", "unknown", "error"}:
            logger.info("Pokemon Center queue monitor diagnostic: %s", log_payload)
        else:
            logger.info("Pokemon Center queue monitor check: %s", log_payload)

        return {
            "status": result.status,
            "previous_status": previous_status,
            "checked_at": row.checked_at.isoformat() if row.checked_at else None,
            "notified_at": row.notified_at.isoformat() if row.notified_at else None,
            "notified_count": notified_count,
            "evidence": result.evidence,
            "error_message": result.error_message,
        }
    finally:
        _CHECK_LOCK.release()


def get_queue_status(db: Session) -> dict[str, Any]:
    from models import PokemonCenterQueueStatus

    row = db.query(PokemonCenterQueueStatus).order_by(PokemonCenterQueueStatus.id.asc()).first()
    if not row:
        return {
            "status": "unknown",
            "previous_status": None,
            "checked_at": None,
            "notified_at": None,
            "url": POKEMON_CENTER_URL,
            "final_url": None,
            "http_status": None,
            "evidence": None,
            "error_message": None,
        }
    return {
        "status": row.status,
        "previous_status": row.previous_status,
        "checked_at": row.checked_at.isoformat() if row.checked_at else None,
        "notified_at": row.notified_at.isoformat() if row.notified_at else None,
        "url": row.url,
        "final_url": row.final_url,
        "http_status": row.http_status,
        "evidence": row.evidence,
        "error_message": row.error_message,
    }
