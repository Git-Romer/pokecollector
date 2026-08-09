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
INTERACTIVE_RESERVATION_GRACE_SECONDS = 5.0
_priority = contextvars.ContextVar("gemini_request_priority", default="interactive")


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

            blocked_until = state.blocked_until if state.blocked_until and state.blocked_until > now else now
            token_ready_at = now
            if state.tokens < 1:
                token_ready_at = now + datetime.timedelta(
                    seconds=(1 - state.tokens) / rate_per_second
                )
            ready_at = max(blocked_until, token_ready_at)
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


def penalize_gemini_key(api_key: str, *, seconds: float | None = None) -> None:
    """Persist an upstream 429 backoff so every worker respects it."""
    fingerprint = key_fingerprint(api_key)
    _ensure_state(fingerprint)
    penalty = seconds if seconds and seconds > 0 else DEFAULT_PENALTY_SECONDS
    db = SessionLocal()
    try:
        state = _locked_state(db, fingerprint)
        if state is None:
            return
        now = datetime.datetime.utcnow()
        blocked_until = now + datetime.timedelta(seconds=penalty)
        if not state.blocked_until or state.blocked_until < blocked_until:
            state.blocked_until = blocked_until
        # Resume with exactly one immediate call, then return to normal pacing;
        # otherwise the blocked period would silently refill a full burst.
        state.tokens = 1.0
        state.last_refill_at = blocked_until
        state.next_request_at = blocked_until
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
