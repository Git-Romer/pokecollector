"""Host-only inspection and repair of one OpenID Connect identity linkage.

This command exists for local operator recovery on a database the operator
already controls. It is deliberately *not* exposed over HTTP and it never
creates administrators or changes roles, passwords, JWTs or collection data.

Safety rules:

* The default is a dry-run preview; nothing is written without ``--confirm``.
* ``--issuer`` must exactly equal the configured ``OIDC_ISSUER_URL``.
* The target must be an existing local user id and the subject must be supplied
  explicitly. There is no username, email or claim-based matching.
* An identity is never moved: if the exact issuer+subject pair is already
  linked to another account, the command refuses instead of reassigning it.
* A user that already has a different identity for the configured issuer is
  refused; the operator must unlink first through the application.
* Pending link transactions for the target user and login handoffs for the
  exact issuer+subject are invalidated in the same commit, matching unlink.

``AUTH_MODE`` is environment-pinned. This command does not change, override or
pretend to change the running policy: to return to mixed/local authentication
the operator must edit the environment and restart the backend separately.
"""
from __future__ import annotations

import argparse
import os
import sys

from sqlalchemy.exc import IntegrityError

from database import SessionLocal
from models import OidcIdentity, User
from services.auth_policy import AuthConfigError, _validate_url
from services.oidc_identity import find_identity, find_user_identity
from services.oidc_transactions import (
    invalidate_identity_transactions,
    invalidate_user_transactions,
)


def _configured_issuer() -> str | None:
    value = (os.getenv("OIDC_ISSUER_URL") or "").strip()
    return value or None


def _print_environment_note() -> None:
    print(
        "Note: AUTH_MODE and the OIDC_* settings come from the environment. "
        "This command does not change or override them; edit the environment "
        "and restart the backend separately."
    )


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Inspect and (with --confirm) repair one exact issuer+subject OIDC "
            "identity linkage on the local database. Host-only recovery tool; "
            "no HTTP route, no role/password/collection changes."
        )
    )
    parser.add_argument(
        "--user-id",
        type=int,
        required=True,
        help="local account id that should own the identity",
    )
    parser.add_argument(
        "--issuer",
        required=True,
        help="must exactly match the configured OIDC_ISSUER_URL",
    )
    parser.add_argument(
        "--subject",
        required=True,
        help="exact provider subject to link (never an email or username)",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="apply the change; without it the command only previews",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    configured = _configured_issuer()
    if configured is None:
        print(
            "OIDC_ISSUER_URL is not set; refusing to repair an OIDC identity.",
            file=sys.stderr,
        )
        return 1
    try:
        _validate_url("OIDC_ISSUER_URL", configured)
    except AuthConfigError as exc:
        print(f"OIDC_ISSUER_URL is invalid: {exc}", file=sys.stderr)
        return 1
    if args.issuer != configured:
        print(
            "--issuer must exactly match the configured OIDC_ISSUER_URL.",
            file=sys.stderr,
        )
        return 1
    if not isinstance(args.user_id, int) or args.user_id <= 0:
        print("--user-id must be a positive integer.", file=sys.stderr)
        return 1
    if not args.subject or not args.subject.strip():
        print("--subject must not be empty.", file=sys.stderr)
        return 1
    if len(args.issuer) > 1024:
        print("--issuer is longer than the supported limit.", file=sys.stderr)
        return 1
    if len(args.subject) > 255:
        print("--subject is longer than the supported limit.", file=sys.stderr)
        return 1

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == args.user_id).first()
        if user is None:
            print(f"No user with id {args.user_id}.", file=sys.stderr)
            return 1

        print(
            f"Target user: id={user.id} username={user.username!r} "
            f"role={user.role!r} active={bool(user.is_active)}"
        )
        print(f"Configured issuer: {configured!r}")
        print(f"Subject: {args.subject!r}")

        existing = find_identity(db, configured, args.subject)
        if existing is not None:
            if existing.user_id == user.id:
                print(
                    "This exact issuer+subject identity is already linked to "
                    "the target user. Nothing to do."
                )
                _print_environment_note()
                return 0
            print(
                "Refusing: this issuer+subject identity is already linked to "
                f"user id {existing.user_id}. Identities are never moved or "
                "deleted by this command.",
                file=sys.stderr,
            )
            return 1

        if find_user_identity(db, user.id, configured) is not None:
            print(
                "Refusing: the target user already has a different identity "
                "for this issuer. Unlink it through the application first.",
                file=sys.stderr,
            )
            return 1

        if not args.confirm:
            print(
                "Dry run: the identity would be created for this account. "
                "No changes made; re-run with --confirm to apply."
            )
            _print_environment_note()
            return 0

        try:
            removed_user = invalidate_user_transactions(db, user_id=user.id)
            removed_identity = invalidate_identity_transactions(
                db, issuer=configured, subject=args.subject
            )
            db.add(
                OidcIdentity(
                    issuer=configured,
                    subject=args.subject,
                    user_id=user.id,
                )
            )
            db.commit()
        except IntegrityError:
            db.rollback()
            print(
                "Refusing: the identity changed concurrently. No changes made.",
                file=sys.stderr,
            )
            return 1
        except Exception:
            db.rollback()
            raise

        print(
            f"Linked the identity to user id {user.id}. Invalidated "
            f"{removed_user} user-bound and {removed_identity} "
            "identity-bound transaction(s)."
        )
        print("Roles, passwords and collection data were not changed.")
        _print_environment_note()
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
