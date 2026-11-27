"""Finalize a claimed OIDC LINK handoff as an account-transition operation.

The handoff claim itself is committed before this module runs. That claim is
intentionally separate from the local identity mutation so no provider network
work ever happens while a database lock is held. Once the claim is committed,
however, the local link mutation must not race :func:`api.auth.unlink_oidc_identity`:
unlink deletes the exact claimed row as part of its unit of work, so a stale
in-memory claim must never be able to insert an identity after that deletion.

This module closes that window with the same transaction-scoped administrator
transition lock used by unlink. Under that lock it re-reads the claimed row,
proves it still exists with the same operation, phase, consumption marker,
issuer, subject, user and bearer binding, re-reads the active password-capable
account, and only then inserts the identity.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from models import OidcAuthTransaction, OidcIdentity, User
from services.auth import has_valid_password_hash
from services.auth_admin import lock_admin_transitions
from services.auth_policy import (
    AUTH_MODE_MIXED,
    AuthConfigError,
    load_auth_policy,
)
from services.oidc_identity import (
    OidcIdentityConflictError,
    link_identity,
)
from services.oidc_transactions import (
    OPERATION_LINK,
    PHASE_HANDOFF,
    TRANSACTION_TTL,
    bearer_token_fingerprint,
)

LINK_REASON_POLICY = "policy"
LINK_REASON_AUTHENTICATION = "authentication"
LINK_REASON_INVALID = "invalid"


class OidcLinkCompletionError(RuntimeError):
    """A claimed LINK handoff can no longer be finalized safely.

    ``reason`` lets the HTTP layer choose a generic status without exposing any
    transaction material: policy is forbidden, authentication required, and
    everything else is an indistinguishable invalid/expired handoff.
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _abort(db: Session, reason: str) -> None:
    """Roll back (releasing every held lock) and raise the generic reason."""
    db.rollback()
    raise OidcLinkCompletionError(reason)


def finalize_link_handoff(
    db: Session,
    *,
    transaction: OidcAuthTransaction,
    current_user_id: int,
    bearer_token: str,
    now: datetime | None = None,
) -> OidcIdentity:
    """Insert the identity for an already-claimed LINK handoff, safely.

    The caller must have obtained ``transaction`` from
    :func:`services.oidc_transactions.claim_handoff_transaction`, which has
    already committed the one-use consumption marker. This function then:

    * takes the same ``pg_advisory_xact_lock`` as unlink;
    * re-reads the exact row by primary key and verifies every binding value;
    * re-reads and row-locks the active local user;
    * re-resolves the current mixed/password-capable policy;
    * inserts the identity while the lock is still held.

    A missing row means unlink (or another invalidation) won the race and the
    completion fails without touching identities. A conflict with an existing
    identity surfaces as :class:`OidcIdentityConflictError`. All failure paths
    roll back and therefore release the advisory lock.
    """
    if transaction is None or transaction.id is None:
        raise OidcLinkCompletionError(LINK_REASON_INVALID)
    if not isinstance(current_user_id, int) or isinstance(current_user_id, bool):
        raise OidcLinkCompletionError(LINK_REASON_AUTHENTICATION)
    if not isinstance(bearer_token, str) or not bearer_token:
        raise OidcLinkCompletionError(LINK_REASON_AUTHENTICATION)

    # Capture the claimed values before expiring the session; the object may be
    # detached from another session and must never be re-read lazily.
    transaction_id = transaction.id
    expected_issuer = transaction.issuer
    expected_subject = transaction.subject
    expected_user_id = transaction.user_id
    expected_bearer_fingerprint = transaction.bearer_fingerprint
    expected_consumed_at = transaction.consumed_at
    expected_created_at = transaction.created_at

    lock_admin_transitions(db)
    db.expire_all()

    row = (
        db.query(OidcAuthTransaction)
        .filter(OidcAuthTransaction.id == transaction_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if row is None:
        _abort(db, LINK_REASON_INVALID)

    if (
        row.operation != OPERATION_LINK
        or row.phase != PHASE_HANDOFF
        or row.consumed_at is None
        or row.consumed_at != expected_consumed_at
        or row.issuer != expected_issuer
        or row.subject != expected_subject
        or row.user_id != expected_user_id
        or row.user_id != current_user_id
        or row.bearer_fingerprint != expected_bearer_fingerprint
        or row.bearer_fingerprint != bearer_token_fingerprint(bearer_token)
    ):
        _abort(db, LINK_REASON_INVALID)

    check_time = now if now is not None else datetime.utcnow()
    if row.expires_at is None or row.expires_at <= check_time:
        _abort(db, LINK_REASON_INVALID)
    if (
        expected_created_at is None
        or expected_created_at + TRANSACTION_TTL <= check_time
    ):
        _abort(db, LINK_REASON_INVALID)

    try:
        policy = load_auth_policy()
    except AuthConfigError:
        _abort(db, LINK_REASON_POLICY)
    if (
        policy.auth_mode != AUTH_MODE_MIXED
        or not policy.password_management_enabled
        or policy.oidc is None
        or row.issuer != policy.oidc.issuer_url
    ):
        _abort(db, LINK_REASON_POLICY)

    user = (
        db.query(User)
        .filter(User.id == current_user_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if user is None or not user.is_active:
        _abort(db, LINK_REASON_AUTHENTICATION)
    if user.id != row.user_id:
        _abort(db, LINK_REASON_INVALID)
    if not has_valid_password_hash(user.hashed_password):
        _abort(db, LINK_REASON_POLICY)

    # link_identity commits while the advisory lock and user row lock are still
    # held, so unlink cannot observe a half-applied link.
    return link_identity(
        db,
        user_id=user.id,
        issuer=row.issuer,
        subject=row.subject,
    )
