"""Vision providers for the card scanner.

Gemini stays the default and its request path is untouched: this module calls the
existing post_gemini_generate() rather than reimplementing it, so Gemini keeps its
own retry, rate limiting and quota handling exactly as before.

The second provider speaks the OpenAI chat-completions API, which covers hosted
OpenAI and any compatible local server (Ollama, llama.cpp, LM Studio).

Two rules shape the design:

- The base URL is read from the environment only. A user-supplied backend URL would
  let any account point the server at an arbitrary host, which is a server-side
  request forgery. Administrators configure the endpoint; users only choose between
  the providers the administrator has made available.
- The Gemini rate limiter is keyed by a fingerprint of the API key. A local endpoint
  usually has no key, so every account would share one bucket and one user's penalty
  would block everybody. Non-Gemini providers therefore never enter that limiter.
"""

import base64
import json
import logging
import math
import os
import re
from contextlib import nullcontext

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import UserSetting

logger = logging.getLogger(__name__)

GEMINI = "gemini"
OPENAI = "openai"
PROVIDERS = (GEMINI, OPENAI)

SCANNER_PROVIDER_SETTING = "scanner_provider"
VISUAL_VERIFICATION_SETTING = "scanner_visual_verification"
SCANNER_MODEL_SETTING = "scanner_model"

DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
# The OpenAI counterpart to DEFAULT_GEMINI_MODEL: what an installation uses when
# no model is configured. Chosen on measured card-scanning behaviour rather than
# headline price, and overridable per installation and per user.
DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"

# Retried rather than surfaced: the same classes Gemini already retries.
OPENAI_TRANSIENT_STATUS_CODES = {502, 503, 504}


def openai_base_url() -> str:
    """Where OpenAI-compatible requests go, set by the administrator.

    Stripped before the fallback, because a value of only whitespace is truthy and
    would otherwise pass through as an empty base URL.
    """
    configured = (os.environ.get("OPENAI_BASE_URL") or "").strip().rstrip("/")
    return configured or DEFAULT_OPENAI_BASE_URL


def openai_chat_completions_url() -> str:
    return f"{openai_base_url()}/chat/completions"


def openai_model() -> str:
    return (os.environ.get("OPENAI_MODEL") or "").strip() or DEFAULT_OPENAI_MODEL


def openai_requires_key() -> bool:
    """Only the hosted API needs a credential.

    Pointing OPENAI_BASE_URL at a local server means there is usually nothing to
    authenticate against, and demanding a key there would make local use impossible.
    """
    return openai_base_url() == DEFAULT_OPENAI_BASE_URL


def resolve_model(db: Session, user_id: int | None, provider: str) -> str:
    """The model this user scans with, or "" to use the installation default.

    Free text on purpose: providers add models constantly, and a fixed list here
    would be stale within weeks and would block anyone running a self-hosted
    model with a name we have never heard of.
    """
    if user_id is None:
        return ""
    row = (
        db.query(UserSetting)
        .filter(UserSetting.user_id == user_id, UserSetting.key == SCANNER_MODEL_SETTING)
        .first()
    )
    return ((row.value if row else "") or "").strip()


def resolve_provider_name(db: Session, user_id: int | None) -> str:
    """Which provider this user scans with, defaulting to Gemini.

    An unrecognised stored value falls back rather than raising: settings validation
    rejects bad input at write time, and a scan is the wrong place to fail over a
    configuration typo.
    """
    if user_id is None:
        return GEMINI
    row = (
        db.query(UserSetting)
        .filter(UserSetting.user_id == user_id, UserSetting.key == SCANNER_PROVIDER_SETTING)
        .first()
    )
    value = (row.value if row else "") or ""
    value = value.strip().lower()
    return value if value in PROVIDERS else GEMINI


def visual_verification_default(provider: str) -> bool:
    """The default for a provider, with no user preference stored.

    The single source of truth for this rule: the settings API publishes it so
    the UI can show the same state the scanner will actually use, rather than
    reimplementing the condition in the frontend where OPENAI_BASE_URL is not
    visible.
    """
    # openai_requires_key() is true only for the hosted API, which is the same
    # signal that distinguishes it from a self-hosted endpoint.
    return provider == GEMINI or openai_requires_key()


def visual_verification_enabled(db: Session, user_id: int | None, provider: str) -> bool:
    """Whether to spend a second model call on picking between candidates.

    The default follows model capability rather than provider name. Gemini and
    the hosted OpenAI API both handle the multi-image comparison well, so it
    stays on for them and nothing changes for existing users. It starts off only
    when the endpoint has been pointed at a self-hosted model, where the ask is
    usually beyond what is running and a confident wrong pick is worse than no
    pick at all. Either default can be overridden per user.
    """
    if user_id is not None:
        row = (
            db.query(UserSetting)
            .filter(
                UserSetting.user_id == user_id,
                UserSetting.key == VISUAL_VERIFICATION_SETTING,
            )
            .first()
        )
        if row and row.value:
            return str(row.value).strip().lower() in {"true", "1", "yes", "on"}
    return visual_verification_default(provider)


class ProviderRateLimitError(HTTPException):
    """A 429 carrying the retry metadata scan_queue reads off the exception.

    scan_queue._scan_error_from_http() pulls retry_after_seconds and
    retry_reason by getattr, so a plain HTTPException would be retried with no
    backoff at all.
    """

    def __init__(self, *, retry_after_seconds: float | None, detail: str):
        self.retry_after_seconds = (
            float(retry_after_seconds) if retry_after_seconds else None
        )
        self.retry_reason = "rate_limit"
        headers = None
        if self.retry_after_seconds:
            headers = {"Retry-After": str(max(1, int(self.retry_after_seconds + 0.999)))}
        super().__init__(status_code=429, detail=detail, headers=headers)


def log_upstream_detail(resp: httpx.Response, context: str) -> None:
    """Record the provider's own message at debug level, and nowhere else.

    Provider text is never put into HTTPException.detail: that detail is
    returned to the caller, persisted as a queue-item error and surfaced in job
    details. A compatible endpoint is free to say "Invalid API key: <secret>",
    and pattern redaction can only catch credential shapes it already knows, so
    an arbitrary token would survive it. Operators who need the upstream wording
    can turn on debug logging.
    """
    from services.scan_trace import redact_sensitive

    message = redact_sensitive(openai_error_message(resp)).strip()
    if message:
        logger.debug("Scanner provider %s: %s", context, message[:200])


def openai_error_message(resp: httpx.Response) -> str:
    """Best-effort upstream detail, without assuming the error envelope."""
    try:
        payload = resp.json()
    except Exception:
        return ""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or "").strip()
        if isinstance(error, str):
            return error.strip()
        if payload.get("message"):
            return str(payload["message"]).strip()
    return ""


# A day is longer than any retry worth honouring in-process, and it keeps the
# value inside what timedelta and the Retry-After header can represent. Without
# a bound, 1e309 parses to infinity and overflows building the 429, while 1e308
# survives that only to overflow timedelta in the queue and abort the drain.
MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60


def openai_retry_after_seconds(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return min(value, MAX_RETRY_AFTER_SECONDS)


def _openai_content(parts: list[dict]) -> list[dict]:
    """Turn neutral parts into OpenAI content blocks.

    Neutral part shapes, shared with the Gemini serialiser:
        {"text": "..."}
        {"image": {"mime_type": "image/jpeg", "data": "<base64>"}}
    """
    content = []
    for part in parts:
        if "text" in part:
            content.append({"type": "text", "text": part["text"]})
        elif "image" in part:
            image = part["image"]
            mime = image.get("mime_type") or "image/jpeg"
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{image['data']}"},
            })
    return content


def _gemini_parts(parts: list[dict]) -> list[dict]:
    """Turn neutral parts into Gemini parts, the shape it already expects."""
    converted = []
    for part in parts:
        if "text" in part:
            converted.append({"text": part["text"]})
        elif "image" in part:
            image = part["image"]
            converted.append({"inline_data": {
                "mime_type": image.get("mime_type") or "image/jpeg",
                "data": image["data"],
            }})
    return converted


def image_part(mime_type: str | None, data_b64: str) -> dict:
    return {"image": {"mime_type": mime_type or "image/jpeg", "data": data_b64}}


def text_part(text: str) -> dict:
    return {"text": text}


def image_part_from_bytes(mime_type: str | None, raw: bytes) -> dict:
    return image_part(mime_type, base64.b64encode(raw).decode())


async def post_openai_chat(
    client: httpx.AsyncClient,
    url: str,
    api_key: str,
    payload: dict,
    *,
    max_attempts: int = 3,
) -> httpx.Response:
    """Call an OpenAI-compatible endpoint, retrying the same transient classes.

    Deliberately not routed through the Gemini rate limiter: see the module
    docstring. A local endpoint has no shared quota to protect.
    """
    import asyncio

    last_error = None
    for attempt in range(max_attempts):
        try:
            headers = {"Content-Type": "application/json"}
            # Sent only when there is one. A local server rejects, or ignores, an
            # Authorization header carrying an empty bearer token.
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"

            resp = await client.post(url, headers=headers, json=payload)

            if resp.status_code == 429:
                log_upstream_detail(resp, "rate limited")
                detail = "The scanner provider is rate limited. Please try again shortly."
                raise ProviderRateLimitError(
                    retry_after_seconds=openai_retry_after_seconds(resp),
                    detail=detail,
                )
            if resp.status_code in {401, 403}:
                # Deliberately no upstream text on the authentication classes.
                # This is exactly where endpoints quote the offending credential
                # back, and this detail is persisted and logged downstream.
                log_upstream_detail(resp, "credentials rejected")
                if openai_requires_key():
                    detail = "The OpenAI API key was rejected. Please check it in Settings."
                else:
                    detail = "The scanner endpoint rejected the request."
                raise HTTPException(status_code=400, detail=detail)
            if resp.status_code == 400:
                # Not an authentication failure: a rejected image, an oversized
                # request or an unsupported option. Telling a user with a valid
                # key to replace it sends them after the wrong thing.
                log_upstream_detail(resp, "request rejected")
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "The scanner provider rejected this request. The image or "
                        "model options may not be supported."
                    ),
                )
            if resp.status_code == 404:
                log_upstream_detail(resp, "model not found")
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"The scanner model \"{payload.get('model', '')}\" was not "
                        "found at this endpoint. Change it in Settings, or ask an "
                        "administrator to check the configured model and endpoint."
                    ),
                )
            if resp.status_code in OPENAI_TRANSIENT_STATUS_CODES:
                if attempt < max_attempts - 1:
                    await asyncio.sleep(2 ** attempt)
                    continue
                raise HTTPException(
                    status_code=503,
                    detail="The scanner provider is temporarily unavailable. Please try again shortly.",
                )
            if resp.is_error:
                log_upstream_detail(resp, f"error {resp.status_code}")
                raise HTTPException(
                    status_code=502,
                    detail=f"The scanner request failed ({resp.status_code}).",
                )
            return resp
        except HTTPException:
            raise
        except httpx.RequestError as exc:
            last_error = exc
            if attempt < max_attempts - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            raise HTTPException(
                status_code=503,
                detail="The scanner endpoint could not be reached. Check the connection and try again.",
            )

    raise HTTPException(status_code=500, detail=f"The scanner request failed: {last_error}")


def extract_openai_text(payload: dict) -> str:
    """Pull the assistant message out of a chat-completions response."""
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("No message content in the scanner response") from exc

    if content is None:
        return ""
    # Not stripped here, to match the Gemini adapter: call sites decide.
    if isinstance(content, str):
        return content
    # Newer OpenAI-compatible servers may answer with a list of content parts
    # rather than a bare string. Returning that unchecked would fail later on
    # .strip() and surface as a 500.
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict)
        )
    raise ValueError(f"Unexpected message content type: {type(content).__name__}")


class ScanProvider:
    """One provider's calling convention, so call sites stay provider-agnostic."""

    def __init__(self, name: str, chosen_model: str = ""):
        self.name = name
        # Resolved once, because the request payload needs it and generate_text
        # has no database session of its own.
        self._chosen_model = (chosen_model or "").strip()

    @property
    def is_gemini(self) -> bool:
        return self.name == GEMINI

    def model(self) -> str:
        from api.recognize import get_gemini_model

        if self._chosen_model:
            return self._chosen_model
        return get_gemini_model() if self.is_gemini else openai_model()

    def installation_model(self) -> str:
        """The model used when this user has not named one."""
        from api.recognize import get_gemini_model

        return get_gemini_model() if self.is_gemini else openai_model()

    def credential(self, db: Session, user_id: int | None) -> str:
        from api.recognize import get_gemini_key

        if self.is_gemini:
            return get_gemini_key(db, user_id=user_id)
        if user_id is None:
            return ""
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user_id, UserSetting.key == "openai_api_key")
            .first()
        )
        return (row.value if row else "") or ""

    def requires_credential(self) -> bool:
        return True if self.is_gemini else openai_requires_key()

    def missing_credential_message(self) -> str:
        if self.is_gemini:
            return "Kein Gemini API Key konfiguriert. Bitte in den Einstellungen eintragen."
        return "No OpenAI API key configured. Add one in Settings first."

    def rate_limit_scope(self, priority: str):
        """Gemini's queue priority scope, and nothing for other providers."""
        if self.is_gemini:
            from services.gemini_rate_limit import gemini_priority_scope

            return gemini_priority_scope(priority)
        return nullcontext()

    async def generate_text(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        parts: list[dict],
        *,
        max_attempts: int = 3,
    ) -> tuple[str, dict | None]:
        """Run one multimodal request and return (text, usage).

        Usage is whatever the provider reports, or None. Callers record it for
        diagnostics and must not depend on its shape.
        """
        if self.is_gemini:
            from api.recognize import build_gemini_generate_url, post_gemini_generate

            response = await post_gemini_generate(
                client,
                # The chosen model has to reach the URL, or the request runs on
                # the installation model while diagnostics record the user's.
                build_gemini_generate_url(self.model()),
                api_key,
                {"contents": [{"parts": _gemini_parts(parts)}]},
                max_attempts=max_attempts,
            )
            payload = response.json()
            # Returned exactly as received. Upstream stripped at the extraction
            # and composite call sites but recorded visual verification
            # unstripped, so stripping here would change what Gemini writes into
            # diagnostics. Call sites strip where they always did.
            text = payload["candidates"][0]["content"]["parts"][0]["text"]
            return text, payload.get("usageMetadata")

        response = await post_openai_chat(
            client,
            openai_chat_completions_url(),
            api_key,
            {
                "model": self.model(),
                "messages": [{"role": "user", "content": _openai_content(parts)}],
            },
            max_attempts=max_attempts,
        )
        try:
            payload = response.json()
            return extract_openai_text(payload), payload.get("usage")
        except (ValueError, TypeError) as exc:
            # A 200 whose body is not a chat completion is the endpoint's fault,
            # not the caller's, so it is a 502 rather than a raw 500.
            raise HTTPException(
                status_code=502,
                detail="The scanner endpoint returned an unreadable response.",
            ) from exc


def get_provider(db: Session, user_id: int | None) -> ScanProvider:
    name = resolve_provider_name(db, user_id)
    return ScanProvider(name, resolve_model(db, user_id, name))
