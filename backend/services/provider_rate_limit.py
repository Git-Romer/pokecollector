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
        penalty = min(
            max(float(seconds or DEFAULT_PENALTY_SECONDS), 1.0),
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
