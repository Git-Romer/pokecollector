"""Structural administrator-account safeguards.

An account is a *usable administrator* when it is active, has role ``admin``,
and has at least one authentication method enabled by the current policy:

* local: a syntactically valid password hash;
* mixed: a valid password hash or an identity for the configured issuer;
* oidc-only: an identity for the configured issuer.

That definition is structural only. It cannot prove the operator knows the
password or that the identity provider is reachable, and it must not claim to.

Account-mutation guards (demote/deactivate/delete, and later identity unlinking)
use this definition and serialize through a shared PostgreSQL advisory lock so
two concurrent removals cannot both observe the other as still usable.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from models import User
from services.auth import bootstrap_admin, has_valid_password_hash
from services.auth_policy import AUTH_MODE_LOCAL, AUTH_MODE_OIDC_ONLY, AuthPolicy
from services.oidc_identity import user_has_identity

# Fixed application-wide lock key for authentication-method transitions. Any
# code path that can remove an administrator's usable method must take this
# transaction-scoped lock before re-counting usable administrators.
ADMIN_TRANSITION_LOCK_KEY = 0x50433241444D494E  # "PC2ADMIN" as a 64-bit integer


class LastUsableAdminError(RuntimeError):
    """Raised when a transition would remove the last usable administrator."""


def lock_admin_transitions(db: Session) -> None:
    """Serialize administrator transitions on PostgreSQL.

    ``pg_advisory_xact_lock`` is released automatically at COMMIT/ROLLBACK. It is
    process- and worker-independent, unlike an in-process mutex. SQLite has no
    advisory locks and no production OIDC deployment; single-process guard
    behaviour remains the same there.
    """
    if db.get_bind().dialect.name == "postgresql":
        db.execute(
            text("SELECT pg_advisory_xact_lock(:key)"),
            {"key": ADMIN_TRANSITION_LOCK_KEY},
        )


def _configured_issuer(policy: AuthPolicy) -> str | None:
    return policy.oidc.issuer_url if policy.oidc is not None else None


def is_usable_admin(db: Session, user: User, policy: AuthPolicy) -> bool:
    """Structural usability check for one account under the current policy."""
    if user is None or not user.is_active or user.role != "admin":
        return False

    if policy.auth_mode == AUTH_MODE_LOCAL:
        return has_valid_password_hash(user.hashed_password)

    issuer = _configured_issuer(policy)
    if policy.auth_mode != AUTH_MODE_OIDC_ONLY and has_valid_password_hash(
        user.hashed_password
    ):
        return True
    return bool(issuer) and user_has_identity(db, user.id, issuer)


def count_usable_admins(db: Session, policy: AuthPolicy) -> int:
    """Count active administrators with at least one method enabled by policy."""
    admins = (
        db.query(User)
        .filter(User.role == "admin", User.is_active == True)  # noqa: E712
        .all()
    )
    return sum(1 for admin in admins if is_usable_admin(db, admin, policy))


def ensure_admin_transition_keeps_usable_admin(
    db: Session,
    user: User,
    policy: AuthPolicy,
    *,
    next_role: str,
    next_is_active: bool,
) -> None:
    """Reject a role/active transition that removes the last usable admin.

    Callers must hold :func:`lock_admin_transitions` and must count against a
    freshly-read database state (no stale identity-map values).
    """
    removes_admin = user.role == "admin" and user.is_active and (
        next_role != "admin" or not next_is_active
    )
    if not removes_admin or not is_usable_admin(db, user, policy):
        return
    if count_usable_admins(db, policy) <= 1:
        raise LastUsableAdminError(
            "At least one active admin account with a usable authentication method is required"
        )


def validate_oidc_only_startup(db: Session, policy: AuthPolicy) -> None:
    """Fail startup unless an active administrator is linked to the issuer.

    Fresh installations and unlinked administrators must start in mixed mode,
    link explicitly, and only then switch to oidc-only. This never mints an
    administrator from provider claims and never falls back to single-user
    access. The message names configuration, not secret values.
    """
    if policy.auth_mode != AUTH_MODE_OIDC_ONLY or policy.oidc is None:
        return

    issuer = policy.oidc.issuer_url
    linked_admins = [
        admin
        for admin in db.query(User)
        .filter(User.role == "admin", User.is_active == True)  # noqa: E712
        .order_by(User.id.asc())
        .all()
        if user_has_identity(db, admin.id, issuer)
    ]
    if linked_admins:
        return

    raise RuntimeError(
        "AUTH_MODE=oidc-only requires an active administrator linked to the "
        "configured OIDC issuer before startup can complete. Start with "
        "AUTH_MODE=mixed, sign in as a local administrator, link that account, "
        "then switch to oidc-only."
    )


def initialize_admin_accounts(db: Session, policy: AuthPolicy) -> None:
    """Run the policy-appropriate first-boot administrator step.

    Local and mixed modes preserve the legacy password bootstrap. OIDC-only
    never creates a password administrator (and therefore never logs bootstrap
    credentials); it requires a previously linked active administrator instead.
    """
    if policy.auth_mode == AUTH_MODE_OIDC_ONLY:
        validate_oidc_only_startup(db, policy)
        return
    bootstrap_admin(db)
