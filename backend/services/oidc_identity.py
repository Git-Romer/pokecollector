"""Lookup, provisioning and linking helpers for OIDC identities.

The identity table is deliberately small: the exact configured issuer plus the
provider's stable subject claim identifies an account. Email, username and
display name are never used as lookup or merge keys.

Provisioning blindly creates a *new* local trainer account; it never attaches an
identity to a pre-existing username or email. The user and identity rows commit
in one unit, and a concurrent winner (unique issuer+subject) is resolved after
rolling the candidate back, so a race cannot leave an orphan user. Linking only
adds an identity to the already-authenticated local account and never changes
its role, password or session.
"""
from __future__ import annotations

import re
import secrets

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import OidcIdentity, User

# Match the self-service username limit; local names are display-only.
_MAX_USERNAME_LENGTH = 32
_MAX_USERNAME_HINT_LENGTH = 24
_USERNAME_FALLBACK = "trainer"
_PROVISION_ATTEMPTS = 5
# Conservative local display-name character set. Anything else is collapsed to
# a hyphen, so provider-controlled claims can never inject markup or separators.
_USERNAME_DISALLOWED = re.compile(r"[^A-Za-z0-9._ -]+")
_USERNAME_SEPARATORS = re.compile(r"[\s._-]+")


class OidcProvisioningError(RuntimeError):
    """A local account could not be provisioned safely."""


class OidcIdentityConflictError(RuntimeError):
    """The identity is already linked to this user or another account."""


def find_identity(db: Session, issuer: str, subject: str) -> OidcIdentity | None:
    """Return the identity for an exact issuer+subject pair, if it exists."""
    return (
        db.query(OidcIdentity)
        .filter(OidcIdentity.issuer == issuer, OidcIdentity.subject == subject)
        .first()
    )


def find_user_identity(
    db: Session, user_id: int, issuer: str
) -> OidcIdentity | None:
    """Return a user's identity for one configured issuer (at most one)."""
    return (
        db.query(OidcIdentity)
        .filter(OidcIdentity.user_id == user_id, OidcIdentity.issuer == issuer)
        .first()
    )


def user_has_identity(db: Session, user_id: int, issuer: str) -> bool:
    """True when the user has an identity for exactly this configured issuer."""
    return find_user_identity(db, user_id, issuer) is not None


def resolve_identity_user(db: Session, issuer: str, subject: str) -> User | None:
    """Return the local account for an exact issuer+subject identity.

    Email, username and display name are never considered. An inactive account
    is returned as-is so callers can reject it instead of reprovisioning a new
    account for the same subject.
    """
    identity = find_identity(db, issuer, subject)
    return identity.user if identity is not None else None


def sanitize_username_hint(value: str | None) -> str:
    """Return a bounded, conservative local display name or an empty string."""
    if not isinstance(value, str):
        return ""
    cleaned = _USERNAME_DISALLOWED.sub("-", value.strip())
    cleaned = _USERNAME_SEPARATORS.sub("-", cleaned).strip("-")
    cleaned = cleaned[:_MAX_USERNAME_HINT_LENGTH].strip("-")
    if len(cleaned) < 2:
        return ""
    return cleaned


def validated_username_hint(
    preferred_username: str | None, name: str | None = None
) -> str | None:
    """Return a bounded, conservative hint from provider profile claims.

    ``preferred_username`` wins over ``name``. Unusable values yield ``None`` so
    provisioning falls back to the random suffix instead of persisting raw,
    unbounded or markup-bearing provider text.
    """
    return (
        sanitize_username_hint(preferred_username)
        or sanitize_username_hint(name)
        or None
    )


def _username_is_free(db: Session, candidate: str) -> bool:
    return (
        db.query(User.id).filter(User.username == candidate).first() is None
    )


def _candidate_username(
    db: Session, hint: str | None, *, attempt: int
) -> str:
    """Build a collision-safe local username, never reusing an existing one."""
    base = sanitize_username_hint(hint) or _USERNAME_FALLBACK
    if attempt == 0 and _username_is_free(db, base):
        return base
    # Random suffix fallback; bounded to the self-service username limit.
    suffix = secrets.token_hex(4)
    maximum_base = _MAX_USERNAME_LENGTH - len(suffix) - 1
    return f"{base[:maximum_base].rstrip('-')}-{suffix}"


def provision_user_for_identity(
    db: Session,
    *,
    issuer: str,
    subject: str,
    preferred_username: str | None = None,
    name: str | None = None,
) -> User:
    """Create an active trainer account and identity in one committed unit.

    The new account has no password and does not require a password change.
    If another request wins the ``issuer+subject`` unique constraint, the
    candidate user insertion is rolled back (leaving no orphan) and the winner's
    account is returned. A pre-existing identity for the same pair is resolved
    without creating a second account.
    """
    if not isinstance(issuer, str) or not issuer:
        raise OidcProvisioningError("OIDC issuer is required")
    if not isinstance(subject, str) or not subject:
        raise OidcProvisioningError("OIDC subject is required")

    existing = find_identity(db, issuer, subject)
    if existing is not None:
        return existing.user

    hint = preferred_username or name
    for attempt in range(_PROVISION_ATTEMPTS):
        username = _candidate_username(db, hint, attempt=attempt)
        user = User(
            username=username,
            hashed_password=None,
            role="trainer",
            is_active=True,
            must_change_password=False,
        )
        identity = OidcIdentity(issuer=issuer, subject=subject, user=user)
        db.add(user)
        db.add(identity)
        try:
            db.commit()
        except IntegrityError:
            # Roll back the candidate user *and* identity together, then look
            # for a concurrently committed winner.
            db.rollback()
            db.expire_all()
            winner = find_identity(db, issuer, subject)
            if winner is not None:
                return winner.user
            # A username collision is retried with a fresh random suffix.
            continue
        db.refresh(user)
        return user

    raise OidcProvisioningError("Could not provision a local account")


def link_identity(
    db: Session,
    *,
    user_id: int,
    issuer: str,
    subject: str,
) -> OidcIdentity:
    """Attach an identity to the already-authenticated local account.

    Role, password, active state and existing session are deliberately
    untouched. Either uniqueness conflict (same subject already linked anywhere,
    or this user already linked to the configured issuer) is a generic conflict;
    the caller must already have proved the current user owns this account.
    """
    if not isinstance(issuer, str) or not issuer:
        raise OidcIdentityConflictError("OIDC issuer is required")
    if not isinstance(subject, str) or not subject:
        raise OidcIdentityConflictError("OIDC subject is required")

    if find_identity(db, issuer, subject) is not None:
        raise OidcIdentityConflictError("OIDC identity is already linked")
    if find_user_identity(db, user_id, issuer) is not None:
        raise OidcIdentityConflictError("Account is already linked to this issuer")

    identity = OidcIdentity(issuer=issuer, subject=subject, user_id=user_id)
    db.add(identity)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise OidcIdentityConflictError("OIDC identity is already linked") from None
    db.refresh(identity)
    return identity
