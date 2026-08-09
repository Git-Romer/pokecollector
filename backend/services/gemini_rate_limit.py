"""Cross-worker Gemini pacing with interactive-request preference."""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import datetime
import hashlib
import hmac
import os

from sqlalchemy.exc import IntegrityError

from database import SessionLocal
from models import GeminiQuotaState


DEFAULT_RATE_PER_MINUTE = 6.0
DEFAULT_BURST = 3.0
DEFAULT_PENALTY_SECONDS = 30.0
DAILY_QUOTA_FIRST_PENALTY_SECONDS = 60 * 60.0
DAILY_QUOTA_REPEAT_PENALTY_SECONDS = 6 * 60 * 60.0
INTERACTIVE_RESERVATION_GRACE_SECONDS = 5.0
_priority = contextvars.ContextVar("gemini_request_priority", default="interactive")


class GeminiKeyBlockedError(RuntimeError):
    """A persisted upstream limit still blocks this API key."""

    def __init__(self, retry_after_seconds: float, reason: str | None = None):
        super().__init__("Gemini API key is temporarily rate limited.")
        self.retry_after_seconds = max(0.0, float(retry_after_seconds))
        self.reason = reason or "rate_limit"


def _positive_float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def request_interval_seconds() -> float:
    return 60.0 / _positive_float("GEMINI_RATE_PER_MIN", DEFAULT_RATE_PER_MINUTE)


def burst_capacity() -> float:
    return _positive_float("GEMINI_RATE_BURST", DEFAULT_BURST)


def key_fingerprint(api_key: str) -> str:
    """Return a stable, non-reversible identifier without persisting the key."""
    secret = os.environ.get("JWT_SECRET_KEY", "pokecollector-gemini-quota-state").encode()
    return hmac.new(secret, api_key.encode(), hashlib.sha256).hexdigest()


@contextlib.contextmanager
def gemini_priority_scope(priority: str):
    if priority not in {"interactive", "background"}:
        raise ValueError("Gemini priority must be interactive or background")
    token = _priority.set(priority)
    try:
        yield
    finally:
        _priority.reset(token)


def current_gemini_priority() -> str:
    return _priority.get()


def _locked_state(db, fingerprint: str):
    return (
        db.query(GeminiQuotaState)
        .filter(GeminiQuotaState.key_fingerprint == fingerprint)
        .with_for_update()
        .first()
    )


def _ensure_state(fingerprint: str) -> None:
    db = SessionLocal()
    try:
        if db.get(GeminiQuotaState, fingerprint) is None:
            db.add(GeminiQuotaState(key_fingerprint=fingerprint))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
    finally:
        db.close()


async def acquire_gemini_slot(api_key: str, *, priority: str | None = None) -> None:
    """Wait for and atomically reserve one request slot for this key."""
    fingerprint = key_fingerprint(api_key)
    priority = priority or current_gemini_priority()
    if priority not in {"interactive", "background"}:
        raise ValueError("Gemini priority must be interactive or background")
    _ensure_state(fingerprint)

    while True:
        db = SessionLocal()
        wait_seconds = 0.05
        try:
            now = datetime.datetime.utcnow()
            state = _locked_state(db, fingerprint)
            if state is None:  # A concurrently rolled-back insert; recreate and retry.
                db.rollback()
                _ensure_state(fingerprint)
                await asyncio.sleep(wait_seconds)
                continue

            capacity = burst_capacity()
            rate_per_second = 1.0 / request_interval_seconds()
            if state.tokens is None or state.last_refill_at is None:
                state.tokens = capacity
                state.last_refill_at = now
            elif now > state.last_refill_at:
                elapsed = (now - state.last_refill_at).total_seconds()
                state.tokens = min(capacity, state.tokens + elapsed * rate_per_second)
                state.last_refill_at = now

            if state.blocked_until and state.blocked_until > now:
                retry_after = (state.blocked_until - now).total_seconds()
                reason = state.blocked_reason
                db.rollback()
                raise GeminiKeyBlockedError(retry_after, reason)

            token_ready_at = now
            if state.tokens < 1:
                token_ready_at = now + datetime.timedelta(
                    seconds=(1 - state.tokens) / rate_per_second
                )
            ready_at = token_ready_at
            interactive_waiting = bool(
                state.interactive_pending_until and state.interactive_pending_until > now
            )

            if priority == "interactive" and ready_at > now:
                state.interactive_pending_until = ready_at + datetime.timedelta(
                    seconds=INTERACTIVE_RESERVATION_GRACE_SECONDS
                )
                state.updated_at = now
                wait_seconds = max(0.05, (ready_at - now).total_seconds())
                db.commit()
            elif priority == "background" and interactive_waiting:
                wait_seconds = max(
                    0.05,
                    (state.interactive_pending_until - now).total_seconds(),
                )
                db.commit()
            elif ready_at > now:
                wait_seconds = max(0.05, (ready_at - now).total_seconds())
                db.commit()
            else:
                state.tokens -= 1
                state.next_request_at = (
                    now
                    if state.tokens >= 1
                    else now + datetime.timedelta(seconds=(1 - state.tokens) / rate_per_second)
                )
                if priority == "interactive":
                    state.interactive_pending_until = None
                state.updated_at = now
                db.commit()
                return
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
        await asyncio.sleep(min(wait_seconds, 30.0))


def penalize_gemini_key(
    api_key: str,
    *,
    seconds: float | None = None,
    reason: str = "rate_limit",
) -> float:
    """Persist an upstream 429 backoff and return the effective delay."""
    fingerprint = key_fingerprint(api_key)
    _ensure_state(fingerprint)
    db = SessionLocal()
    try:
        state = _locked_state(db, fingerprint)
        if state is None:
            return DEFAULT_PENALTY_SECONDS
        now = datetime.datetime.utcnow()
        provider_penalty = seconds if seconds and seconds > 0 else 0.0
        from_provider = bool(provider_penalty)
        active_block = bool(state.blocked_until and state.blocked_until > now)
        if active_block:
            # A daily block dominates a racing short-term response. Within the
            # same class, provider metadata may replace a fallback, while a
            # missing-delay response never replaces an existing block.
            if state.blocked_reason == "daily_quota" and reason != "daily_quota":
                return (state.blocked_until - now).total_seconds()
            if state.blocked_reason == reason and not from_provider:
                return (state.blocked_until - now).total_seconds()
        if reason == "daily_quota":
            if provider_penalty:
                # Gemini's structured RetryInfo is authoritative, including
                # the daily reset boundary observed in the live API response.
                state.consecutive_daily_failures = 0
                penalty = provider_penalty
            else:
                state.consecutive_daily_failures = int(state.consecutive_daily_failures or 0) + 1
                penalty = (
                    DAILY_QUOTA_FIRST_PENALTY_SECONDS
                    if int(state.consecutive_daily_failures or 0) <= 1
                    else DAILY_QUOTA_REPEAT_PENALTY_SECONDS
                )
        else:
            state.consecutive_daily_failures = 0
            penalty = provider_penalty or DEFAULT_PENALTY_SECONDS
        effective_blocked_until = now + datetime.timedelta(seconds=penalty)
        state.blocked_until = effective_blocked_until
        state.blocked_reason = reason
        # Resume with exactly one immediate call, then return to normal pacing;
        # otherwise the blocked period would silently refill a full burst.
        state.tokens = 1.0
        state.last_refill_at = effective_blocked_until
        state.next_request_at = effective_blocked_until
        state.updated_at = now
        db.commit()
        return max(0.0, (effective_blocked_until - now).total_seconds())
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def record_gemini_success(api_key: str) -> None:
    """Clear quota classification after a successful provider response."""
    fingerprint = key_fingerprint(api_key)
    db = SessionLocal()
    try:
        state = _locked_state(db, fingerprint)
        if state is None:
            db.rollback()
            return
        now = datetime.datetime.utcnow()
        # A successful request that was already in flight must not erase a
        # newer penalty recorded by another concurrent request.
        if state.blocked_until and state.blocked_until > now:
            db.rollback()
            return
        state.blocked_until = None
        state.blocked_reason = None
        state.consecutive_daily_failures = 0
        state.updated_at = now
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def purge_stale_quota_states(
    *,
    now: datetime.datetime | None = None,
    older_than_days: int = 14,
) -> int:
    """Remove inactive key fingerprints on the same retention schedule as scans."""
    cutoff = (now or datetime.datetime.utcnow()) - datetime.timedelta(days=older_than_days)
    db = SessionLocal()
    try:
        removed = (
            db.query(GeminiQuotaState)
            .filter(GeminiQuotaState.updated_at < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        return removed
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
