from __future__ import annotations

import argparse
import getpass
import sys

from database import SessionLocal
from models import User
from services.auth import hash_password


def _read_password(non_interactive: str | None) -> str:
    """Read the new password from --password (for automation) or prompt twice via getpass."""
    if non_interactive is not None:
        password = non_interactive
        if not password.strip():
            print("Password must not be empty.", file=sys.stderr)
            raise SystemExit(2)
        return password

    password = getpass.getpass("New password: ")
    if not password.strip():
        print("Password must not be empty.", file=sys.stderr)
        raise SystemExit(2)
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords do not match.", file=sys.stderr)
        raise SystemExit(2)
    return password


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Set (reset) an account's password from the host. Use this to recover an admin "
            "account whose password is unknown - for example before or after enabling "
            "multi-user mode."
        )
    )
    parser.add_argument("--username", default="admin", help="account to update (default: admin)")
    parser.add_argument(
        "--password",
        help="new password; omit to be prompted (prompting is preferred so it stays out of shell history)",
    )
    parser.add_argument(
        "--make-admin",
        action="store_true",
        help="also promote the account to admin and activate it (useful if the only admin was demoted)",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == args.username).first()
        if not user:
            print(f"No user named {args.username!r}.", file=sys.stderr)
            existing = [u.username for u in db.query(User).order_by(User.id.asc()).all()]
            if existing:
                print("Existing users: " + ", ".join(existing), file=sys.stderr)
            return 1

        password = _read_password(args.password)
        user.hashed_password = hash_password(password)
        user.must_change_password = False
        if args.make_admin:
            user.role = "admin"
            user.is_active = True
        db.commit()
        print(f"Password updated for {user.username!r} (role: {user.role}).")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
