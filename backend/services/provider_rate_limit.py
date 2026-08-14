"""Persistent blocking for non-Gemini scanner providers."""

import datetime
import hashlib
import hmac
import os

from sqlalchemy.exc import IntegrityError

from database import SessionLocal
from models import ScannerProviderLimitState


DEFAULT_PENALTY_SECONDS = 30.0
MAX_PENALTY_SECONDS = 14 * 24 * 60 * 60.0
FALLBACK_PENALTY_SECONDS = (30.0, 120.0, 600.0, 1800.0, 3600.0, 21600.0)
FALLBACK_RESET_AFTER = datetime.timedelta(hours=24)


class ProviderScopeBlockedError(RuntimeError):
    def __init__(self, retry_after_seconds: float, reason: str | None = None):
        super().__init__("Scanner provider is temporarily rate limited.")
        self.retry_after_seconds = max(0.0, float(retry_after_seconds))
        self.reason = reason or "rate_limit"


def provider_scope_fingerprint(provider: str, endpoint: str, credential: str) -> str:
    """Identify a hosted key or keyless endpoint without persisting either value."""
    secret = os.environ.get(
        "JWT_SECRET_KEY", "pokecollector-scanner-provider-state"
    ).encode()
    material = f"{provider}\0{endpoint}\0{credential}".encode()
    return hmac.new(secret, material, hashlib.sha256).hexdigest()


def _ensure_state(scope: str, provider: str) -> None:
    db = SessionLocal()
    try:
        if db.get(ScannerProviderLimitState, scope) is None:
            db.add(ScannerProviderLimitState(scope_fingerprint=scope, provider=provider))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
    finally:
        db.close()


def raise_if_provider_blocked(scope: str) -> None:
    db = SessionLocal()
    try:
        state = db.get(ScannerProviderLimitState, scope)
        now = datetime.datetime.utcnow()
        if state and state.blocked_until and state.blocked_until > now:
            raise ProviderScopeBlockedError(
                (state.blocked_until - now).total_seconds(), state.blocked_reason
            )
    finally:
        db.close()


def penalize_provider_scope(
    scope: str,
    provider: str,
    *,
    seconds: float | None = None,
    reason: str = "rate_limit",
) -> float:
    _ensure_state(scope, provider)
    db = SessionLocal()
    try:
        state = (
            db.query(ScannerProviderLimitState)
            .filter(ScannerProviderLimitState.scope_fingerprint == scope)
            .with_for_update()
            .first()
        )
        if state is None:
            return DEFAULT_PENALTY_SECONDS
        now = datetime.datetime.utcnow()
        if seconds is None:
            previous = 0.0
            if (
                state.blocked_until
                and state.updated_at
                and now - state.updated_at <= FALLBACK_RESET_AFTER
            ):
                previous = max(
                    0.0,
                    (state.blocked_until - state.updated_at).total_seconds(),
                )
            penalty = next(
                (value for value in FALLBACK_PENALTY_SECONDS if value > previous + 0.5),
                FALLBACK_PENALTY_SECONDS[-1],
            )
        else:
            penalty = min(
                max(float(seconds), 1.0),
                MAX_PENALTY_SECONDS,
            )
        proposed = now + datetime.timedelta(seconds=penalty)
        if state.blocked_until and state.blocked_until > proposed:
            return (state.blocked_until - now).total_seconds()
        state.blocked_until = proposed
        state.blocked_reason = reason
        state.updated_at = now
        db.commit()
        return penalty
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def purge_stale_provider_limit_states(
    *, now: datetime.datetime | None = None, older_than_days: int = 14
) -> int:
    cutoff = (now or datetime.datetime.utcnow()) - datetime.timedelta(days=older_than_days)
    db = SessionLocal()
    try:
        removed = (
            db.query(ScannerProviderLimitState)
            .filter(ScannerProviderLimitState.updated_at < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        return removed
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
