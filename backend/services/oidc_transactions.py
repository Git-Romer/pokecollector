"""Database-backed OIDC login/link/handoff transactions.

One browser may have at most one active authentication flow. The store keeps
only irreversible keyed digests for lookup/binding/handoff secrets and AEAD
ciphertext for the nonce and PKCE verifier.

Lifecycle (the P4 route API; no route consumes this module yet):

* :func:`start_transaction` atomically invalidates **every** row for the browser
  -- pending authorizations, claimed in-flight authorizations and unredeemed
  handoffs -- and inserts the new authorization in one committed unit. On
  PostgreSQL the invalidation and insert run under a transaction-scoped
  advisory lock derived from the browser digest, so concurrent starts for one
  browser serialize. The lock is released before the caller redirects, never
  held across provider network I/O.
* :func:`claim_authorization_transaction` atomically consumes the authorization
  and commits before the token exchange. ``None`` means restart.
* :func:`promote_authorization_to_handoff` atomically promotes the exact claimed
  authorization row (row id + state digest + browser digest + issuer + phase +
  expiry) into a one-minute completion handoff. It never creates a new row:
  ``None`` means the source was missing, deleted or superseded by a newer
  start, and the route must restart the flow. It shares the start lock, so a
  start racing a promotion either deletes the claimed row first or removes the
  freshly promoted handoff.
* :func:`claim_handoff_transaction` atomically redeems a same-browser one-use
  handoff. Route handlers dispatch on ``transaction.operation``.
* :func:`invalidate_user_transactions` and
  :func:`invalidate_identity_transactions` are called inside the P5 unlink
  unit of work: the first removes link rows (including claimed in-flight
  rows), the second removes login handoffs by exact issuer+subject. They return
  the affected row count; the caller commits with the identity deletion.

No database lock is ever held across provider network I/O: claims commit before
the token exchange and promotion runs only after it. ``start_transaction``,
both claims and promotion are commit boundaries; the invalidators leave the
commit to their caller so unlink stays atomic.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta

from sqlalchemy import and_, case, delete, or_, text, update
from sqlalchemy.orm import Session

from models import OidcAuthTransaction
from services import auth
from services.oidc_crypto import (
    TransactionCryptoError,
    decrypt_transaction_secret,
    encrypt_transaction_secret,
)
from services.oidc_identity import validated_username_hint

OPERATION_LOGIN = "login"
OPERATION_LINK = "link"
OPERATIONS = (OPERATION_LOGIN, OPERATION_LINK)

PHASE_AUTHORIZATION = "authorization"
PHASE_HANDOFF = "handoff"

TRANSACTION_TTL = timedelta(minutes=5)
HANDOFF_TTL = timedelta(seconds=60)

# Distinct digest namespaces: a value from one purpose never matches another.
_STATE_NAMESPACE = "oidc-transaction-state"
_BROWSER_NAMESPACE = "oidc-transaction-browser"
_HANDOFF_NAMESPACE = "oidc-transaction-handoff"
_BEARER_NAMESPACE = "oidc-transaction-bearer"

_SECRET_BYTES = 32  # 256 bits of entropy for state/browser/handoff secrets.

# Fixed salt for the PostgreSQL advisory-lock namespace ("OIDC").
_ADVISORY_LOCK_NAMESPACE = 0x4F494443
_SIGNED_64_BIT = 2**63
_UNSIGNED_64_BIT = 2**64


class OidcTransactionError(RuntimeError):
    """Transaction state is unusable (expired, consumed, tampered or rotated)."""


def generate_transaction_secret() -> str:
    """Return a 256-bit URL-safe random secret for state/browser/handoff use."""
    return secrets.token_urlsafe(_SECRET_BYTES)


def bearer_token_fingerprint(token: str) -> str:
    """Irreversible fingerprint binding a link transaction to one app JWT."""
    if not isinstance(token, str) or not token:
        raise OidcTransactionError("Bearer token is required")
    return auth.secret_fingerprint(_BEARER_NAMESPACE, token)


def _digest(namespace: str, value: str) -> str:
    if not isinstance(value, str) or not value:
        raise OidcTransactionError("Transaction secret is required")
    return auth.secret_fingerprint(namespace, value)


def _utcnow(now: datetime | None) -> datetime:
    return now if now is not None else datetime.utcnow()


def _validate_operation(operation: str) -> None:
    if operation not in OPERATIONS:
        raise OidcTransactionError("Unsupported OIDC transaction operation")


def _advisory_lock_key(browser_digest: str) -> int:
    """Return a stable signed 64-bit advisory-lock key for one browser digest."""
    raw = int(browser_digest[:16], 16) ^ _ADVISORY_LOCK_NAMESPACE
    if raw >= _SIGNED_64_BIT:
        raw -= _UNSIGNED_64_BIT
    return raw


def _acquire_browser_lock(db: Session, browser_digest: str) -> None:
    """Take the transaction-scoped PostgreSQL browser lock when supported.

    The lock is keyed from the browser digest and released on commit/rollback.
    SQLite has no advisory locks; its transaction tests are deliberately
    sequential and do not claim PostgreSQL concurrency semantics.
    """
    bind = db.get_bind()
    if getattr(getattr(bind, "dialect", None), "name", None) != "postgresql":
        return
    db.execute(
        text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": _advisory_lock_key(browser_digest)},
    )


def _invalidate_browser_transactions(db: Session, browser_digest: str) -> int:
    """Delete every transaction for one browser, consumed or not.

    Claimed authorizations are deliberately included: a stale callback must not
    be able to promote a flow that a newer start has already superseded.
    """
    result = db.execute(
        delete(OidcAuthTransaction)
        .where(OidcAuthTransaction.browser_digest == browser_digest)
        .execution_options(synchronize_session="fetch")
    )
    return result.rowcount or 0


def start_transaction(
    db: Session,
    *,
    issuer: str,
    operation: str,
    state: str,
    browser_secret: str,
    nonce: str,
    code_verifier: str,
    user_id: int | None = None,
    bearer_token: str | None = None,
    now: datetime | None = None,
) -> OidcAuthTransaction:
    """Create the authorization-phase transaction for this browser.

    Every older flow or handoff issued to the same browser digest is invalidated
    in the same committed unit of work, enforcing one active flow per browser.
    On PostgreSQL an advisory lock keyed from the browser digest serialises
    concurrent starts and promotions; the lock is released before returning.
    Link transactions must carry the initiating local user and bearer token.
    """
    _validate_operation(operation)
    if not isinstance(issuer, str) or not issuer:
        raise OidcTransactionError("OIDC issuer is required")
    if operation == OPERATION_LINK:
        if user_id is None or not bearer_token:
            raise OidcTransactionError(
                "Link transactions require a user and bearer token"
            )
    elif user_id is not None or bearer_token is not None:
        raise OidcTransactionError(
            "Login transactions cannot carry a linked user or bearer token"
        )

    created = _utcnow(now)
    browser_digest = _digest(_BROWSER_NAMESPACE, browser_secret)
    state_digest = _digest(_STATE_NAMESPACE, state)

    _acquire_browser_lock(db, browser_digest)
    _invalidate_browser_transactions(db, browser_digest)

    transaction = OidcAuthTransaction(
        operation=operation,
        phase=PHASE_AUTHORIZATION,
        issuer=issuer,
        state_digest=state_digest,
        browser_digest=browser_digest,
        nonce_ciphertext=encrypt_transaction_secret(nonce),
        verifier_ciphertext=encrypt_transaction_secret(code_verifier),
        subject=None,
        auth_time=None,
        user_id=user_id,
        bearer_fingerprint=(
            bearer_token_fingerprint(bearer_token) if bearer_token else None
        ),
        handoff_digest=None,
        expires_at=created + TRANSACTION_TTL,
        created_at=created,
        consumed_at=None,
    )
    db.add(transaction)
    # Commit the invalidation and insert atomically and release the advisory
    # lock before the route performs any redirect or provider work. Keep this
    # instance populated across the commit: a post-commit refresh could race a
    # newer start that is allowed to delete the row as soon as the lock drops.
    expire_on_commit = db.expire_on_commit
    db.expire_on_commit = False
    try:
        db.commit()
    finally:
        db.expire_on_commit = expire_on_commit
    return transaction


def claim_authorization_transaction(
    db: Session,
    *,
    state: str,
    browser_secret: str,
    now: datetime | None = None,
) -> OidcAuthTransaction | None:
    """Atomically consume a pending authorization transaction.

    Returns ``None`` for unknown, expired, already-consumed or wrong-browser
    state. Consumption is committed before the caller performs any network or
    token work, so a provider error cannot make the attempt replayable.
    """
    claimed_at = _utcnow(now)
    state_digest = _digest(_STATE_NAMESPACE, state)
    browser_digest = _digest(_BROWSER_NAMESPACE, browser_secret)

    result = db.execute(
        update(OidcAuthTransaction)
        .where(
            OidcAuthTransaction.state_digest == state_digest,
            OidcAuthTransaction.browser_digest == browser_digest,
            OidcAuthTransaction.phase == PHASE_AUTHORIZATION,
            OidcAuthTransaction.consumed_at.is_(None),
            OidcAuthTransaction.expires_at > claimed_at,
        )
        .values(consumed_at=claimed_at)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return None

    db.commit()
    return (
        db.query(OidcAuthTransaction)
        .filter(
            OidcAuthTransaction.state_digest == state_digest,
            OidcAuthTransaction.phase == PHASE_AUTHORIZATION,
        )
        .populate_existing()
        .one_or_none()
    )


def promote_authorization_to_handoff(
    db: Session,
    *,
    transaction_id: int,
    state: str,
    browser_secret: str,
    issuer: str,
    handoff_secret: str,
    subject: str,
    auth_time: int | None = None,
    username_hint: str | None = None,
    now: datetime | None = None,
) -> OidcAuthTransaction | None:
    """Atomically turn the exact claimed authorization row into a handoff.

    The conditional UPDATE is keyed by the original row id, state digest,
    browser digest, issuer, authorization phase, a non-null consumption marker
    and a live expiry. It preserves the stored operation/user/bearer binding and
    original issuance time, stores the validated subject/auth_time and a
    bounded/sanitized username hint, clears nonce and PKCE verifier ciphertext,
    and caps completion expiry at the earlier of the original authorization
    deadline and one minute after promotion.

    Exactly one updated row is required. A missing, deleted or superseded source
    returns ``None`` and never creates a replacement handoff; the route must
    restart the flow. The failure path rolls back its transaction (releasing
    the advisory lock) and leaves no row behind. The same browser advisory lock
    as :func:`start_transaction` makes the two operations mutually exclusive.
    """
    if (
        not isinstance(transaction_id, int)
        or isinstance(transaction_id, bool)
        or transaction_id <= 0
    ):
        raise OidcTransactionError("A claimed authorization row id is required")
    if not isinstance(issuer, str) or not issuer:
        raise OidcTransactionError("OIDC issuer is required")
    if not isinstance(subject, str) or not subject:
        raise OidcTransactionError("OIDC subject is required")

    promoted_at = _utcnow(now)
    browser_digest = _digest(_BROWSER_NAMESPACE, browser_secret)
    state_digest = _digest(_STATE_NAMESPACE, state)
    handoff_digest = _digest(_HANDOFF_NAMESPACE, handoff_secret)
    # Store only the bounded, sanitized hint. Invalid provider text becomes
    # NULL and provisioning uses the random suffix fallback.
    bounded_hint = validated_username_hint(username_hint)
    handoff_expiry = promoted_at + HANDOFF_TTL

    _acquire_browser_lock(db, browser_digest)
    result = db.execute(
        update(OidcAuthTransaction)
        .where(
            OidcAuthTransaction.id == transaction_id,
            OidcAuthTransaction.state_digest == state_digest,
            OidcAuthTransaction.browser_digest == browser_digest,
            OidcAuthTransaction.issuer == issuer,
            OidcAuthTransaction.phase == PHASE_AUTHORIZATION,
            OidcAuthTransaction.consumed_at.is_not(None),
            OidcAuthTransaction.expires_at > promoted_at,
        )
        .values(
            phase=PHASE_HANDOFF,
            state_digest=None,
            nonce_ciphertext=None,
            verifier_ciphertext=None,
            subject=subject,
            auth_time=auth_time,
            username_hint=bounded_hint,
            handoff_digest=handoff_digest,
            # Never extend the original transaction deadline; the handoff is
            # valid for at most one minute and never past start + five minutes.
            expires_at=case(
                (
                    OidcAuthTransaction.expires_at < handoff_expiry,
                    OidcAuthTransaction.expires_at,
                ),
                else_=handoff_expiry,
            ),
            consumed_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        # Roll back (releasing the advisory lock) without creating anything.
        db.rollback()
        return None

    db.commit()
    return (
        db.query(OidcAuthTransaction)
        .filter(OidcAuthTransaction.id == transaction_id)
        .populate_existing()
        .one_or_none()
    )


def claim_handoff_transaction(
    db: Session,
    *,
    handoff_secret: str,
    browser_secret: str,
    expected_user_id: int | None = None,
    bearer_token: str | None = None,
    now: datetime | None = None,
) -> OidcAuthTransaction | None:
    """Atomically redeem a completion handoff for this browser.

    Completion infers the operation solely from the stored row; the caller
    cannot choose login versus link. A login handoff is redeemable without an
    authenticated context, while a link handoff is only redeemable when the
    current user id and the initiating bearer token are supplied and match.
    Both are part of the atomic predicate, so an incomplete or mismatched link
    attempt is rejected without consuming somebody else's handoff.

    Route handlers must dispatch on ``transaction.operation`` after the claim:
    a login handoff may issue an application token, a link handoff must return
    the linked result and never replace the current session.
    """
    if (expected_user_id is None) != (bearer_token is None):
        raise OidcTransactionError(
            "Link completion requires both the initiating user and bearer token"
        )

    claimed_at = _utcnow(now)
    handoff_digest = _digest(_HANDOFF_NAMESPACE, handoff_secret)
    browser_digest = _digest(_BROWSER_NAMESPACE, browser_secret)

    predicates = [
        OidcAuthTransaction.handoff_digest == handoff_digest,
        OidcAuthTransaction.browser_digest == browser_digest,
        OidcAuthTransaction.phase == PHASE_HANDOFF,
        OidcAuthTransaction.consumed_at.is_(None),
        OidcAuthTransaction.expires_at > claimed_at,
    ]
    if expected_user_id is None:
        # Unauthenticated completion may only redeem a login handoff.
        predicates.append(OidcAuthTransaction.operation == OPERATION_LOGIN)
    else:
        fingerprint = bearer_token_fingerprint(bearer_token)
        predicates.append(
            or_(
                OidcAuthTransaction.operation == OPERATION_LOGIN,
                and_(
                    OidcAuthTransaction.operation == OPERATION_LINK,
                    OidcAuthTransaction.user_id == expected_user_id,
                    OidcAuthTransaction.bearer_fingerprint == fingerprint,
                ),
            )
        )

    result = db.execute(
        update(OidcAuthTransaction)
        .where(*predicates)
        .values(consumed_at=claimed_at)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        return None

    db.commit()
    return (
        db.query(OidcAuthTransaction)
        .filter(
            OidcAuthTransaction.handoff_digest == handoff_digest,
            OidcAuthTransaction.phase == PHASE_HANDOFF,
        )
        .populate_existing()
        .one_or_none()
    )


def decrypted_nonce(transaction: OidcAuthTransaction) -> str | None:
    """Decrypt and return the transaction nonce, failing closed on tamper."""
    if transaction.nonce_ciphertext is None:
        return None
    try:
        return decrypt_transaction_secret(transaction.nonce_ciphertext)
    except TransactionCryptoError as exc:
        raise OidcTransactionError(str(exc)) from None


def decrypted_code_verifier(transaction: OidcAuthTransaction) -> str | None:
    """Decrypt and return the PKCE verifier, failing closed on tamper."""
    if transaction.verifier_ciphertext is None:
        return None
    try:
        return decrypt_transaction_secret(transaction.verifier_ciphertext)
    except TransactionCryptoError as exc:
        raise OidcTransactionError(str(exc)) from None


def invalidate_user_transactions(db: Session, *, user_id: int) -> int:
    """Delete every transaction bound to one local user.

    Unlink/identity repair must remove pending rows **and** already-claimed
    in-flight authorizations, so a consumed-but-not-yet-promoted row cannot be
    turned into a handoff afterwards. Login handoffs are not user-bound; P5
    unlink must also call :func:`invalidate_identity_transactions` for them.
    Callers commit the surrounding unit of work with the identity change.
    """
    result = db.execute(
        delete(OidcAuthTransaction)
        .where(OidcAuthTransaction.user_id == user_id)
        .execution_options(synchronize_session="fetch")
    )
    return result.rowcount or 0


def invalidate_identity_transactions(
    db: Session, *, issuer: str, subject: str
) -> int:
    """Delete transactions bound to an exact issuer+subject identity.

    P5 unlink calls this so a login handoff created before the unlink cannot
    survive it. Matching is exact on the configured issuer and validated
    subject; email, username and display names are never used.
    """
    if not isinstance(issuer, str) or not issuer:
        raise OidcTransactionError("OIDC issuer is required")
    if not isinstance(subject, str) or not subject:
        raise OidcTransactionError("OIDC subject is required")
    result = db.execute(
        delete(OidcAuthTransaction)
        .where(
            OidcAuthTransaction.issuer == issuer,
            OidcAuthTransaction.subject == subject,
        )
        .execution_options(synchronize_session="fetch")
    )
    return result.rowcount or 0


def purge_expired_transactions(
    db: Session, *, now: datetime | None = None, limit: int = 500
) -> int:
    """Delete at most ``limit`` expired rows; bounded maintenance only."""
    if limit <= 0:
        return 0
    cutoff = _utcnow(now)
    ids = [
        row[0]
        for row in (
            db.query(OidcAuthTransaction.id)
            .filter(OidcAuthTransaction.expires_at <= cutoff)
            .order_by(OidcAuthTransaction.id)
            .limit(limit)
            .all()
        )
    ]
    if not ids:
        return 0
    result = db.execute(
        delete(OidcAuthTransaction)
        .where(OidcAuthTransaction.id.in_(ids))
        .execution_options(synchronize_session="fetch")
    )
    return result.rowcount or 0
