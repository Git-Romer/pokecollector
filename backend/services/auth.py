import logging
import os
import secrets
from datetime import datetime, timedelta

import bcrypt
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from models import User

logger = logging.getLogger(__name__)


def _default_secret_file() -> str:
    return os.getenv(
        "JWT_SECRET_FILE",
        os.path.join(os.getenv("DATA_DIR", "/app/data"), "auth", "jwt_secret.key"),
    )


def resolve_jwt_secret() -> str:
    """Resolve the JWT signing key.

    An explicitly configured JWT_SECRET_KEY wins. It is rejected when blank, because
    docker-compose passes it through as `${JWT_SECRET_KEY:-}` (present but empty) and
    `os.getenv(key, fallback)` only uses the fallback when the variable is *absent*, not
    when it is empty. That made the effective HMAC key the empty string on stock Compose
    installs, so anyone could forge a valid admin token. When no key is configured, a
    strong one is generated and persisted to a file so it survives restarts; if the file
    cannot be written, an ephemeral key is used (unforgeable, but sessions reset on
    restart) rather than falling back to a predictable value.
    """
    configured = os.getenv("JWT_SECRET_KEY")
    if configured and configured.strip():
        return configured

    if configured is not None and not configured.strip():
        logger.warning(
            "JWT_SECRET_KEY is set but empty; ignoring it. Set a non-empty value, or "
            "leave it unset to use a generated, persisted key."
        )

    secret_file = _default_secret_file()
    try:
        if os.path.exists(secret_file):
            with open(secret_file, "r", encoding="utf-8") as fh:
                existing = fh.read().strip()
            if existing:
                return existing

        os.makedirs(os.path.dirname(secret_file), exist_ok=True)
        new_secret = secrets.token_urlsafe(48)
        tmp_path = f"{secret_file}.tmp"
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(new_secret)
        os.replace(tmp_path, secret_file)
        logger.info("Generated and persisted a JWT signing key at %s", secret_file)
        return new_secret
    except OSError as exc:
        logger.warning(
            "Could not persist a JWT signing key (%s); using an ephemeral one. Set "
            "JWT_SECRET_KEY to a fixed value so sessions survive restarts.",
            exc,
        )
        return secrets.token_urlsafe(48)


SECRET_KEY = resolve_jwt_secret()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


def create_access_token(data: dict, expires_delta: timedelta = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


def bootstrap_admin(db: Session):
    """Create admin user on first run if no users exist."""
    if db.query(User).count() > 0:
        return

    username = os.getenv("ADMIN_USERNAME", "admin")
    password = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(20)
    log_credentials = os.getenv("ADMIN_BOOTSTRAP_LOG", "true").lower() != "false"

    admin = User(
        username=username,
        hashed_password=hash_password(password),
        role="admin",
        is_active=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)

    from sqlalchemy import text

    for table in ["collection", "wishlist", "binders", "product_purchases", "portfolio_snapshots"]:
        db.execute(text(f"UPDATE {table} SET user_id = :uid WHERE user_id IS NULL"), {"uid": admin.id})
    db.commit()

    if log_credentials:
        logger.info("Initial admin user created — username: %s", username)
        logger.info("Initial admin password: %s", password)  # nosec — intentional, user can set ADMIN_PASSWORD env var instead
    else:
        logger.info("Initial admin user created (credentials suppressed)")
