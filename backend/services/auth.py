import logging
import os
import secrets
from datetime import datetime, timedelta

import bcrypt
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from models import User

logger = logging.getLogger(__name__)

SECRET_KEY = os.getenv("JWT_SECRET_KEY", secrets.token_urlsafe(32))
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
