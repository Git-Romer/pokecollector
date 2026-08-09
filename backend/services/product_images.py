"""Opaque access tokens and shared cache keys for manual product images."""

from __future__ import annotations

import hashlib
import hmac

from sqlalchemy import text

from services.auth import SECRET_KEY


_TOKEN_KEY = hmac.new(
    SECRET_KEY.encode("utf-8"),
    b"pokecollector:product-image-token:v1",
    hashlib.sha256,
).digest()


def product_image_token(product_id: int, user_id: int, image_url: str) -> str:
    payload = f"product:{product_id}:user:{user_id}:url:{image_url}".encode("utf-8")
    return hmac.new(_TOKEN_KEY, payload, hashlib.sha256).hexdigest()


def valid_product_image_token(product_id: int, user_id: int, image_url: str, token: str) -> bool:
    if not token:
        return False
    expected = product_image_token(product_id, user_id, image_url)
    return hmac.compare_digest(expected, token)


def product_image_cache_key(image_url: str) -> str:
    digest = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
    return f"product:custom:{digest}"


def _lock_product_image_url(db, image_url: str) -> None:
    """Serialize fetch/cache and reference cleanup for one URL on PostgreSQL."""
    if db.bind.dialect.name != "postgresql":
        return
    digest = hashlib.sha256(image_url.encode("utf-8")).digest()
    lock_key = int.from_bytes(digest[:8], "big", signed=True)
    db.execute(text("SELECT pg_advisory_xact_lock(:lock_key)"), {"lock_key": lock_key})


def prepare_product_image_cache(db, image_url: str) -> bool:
    """Lock a URL and confirm it is still referenced before caching fetched bytes."""
    from models import ProductPurchase

    _lock_product_image_url(db, image_url)
    db.expire_all()
    return db.query(ProductPurchase.id).filter(ProductPurchase.image_url == image_url).first() is not None


def cleanup_product_image_cache_if_unreferenced(db, image_url: str | None) -> None:
    """Delete cached bytes once the last product reference is removed."""
    if not image_url:
        return

    from models import ImageCache, ProductPurchase

    _lock_product_image_url(db, image_url)
    if db.query(ProductPurchase.id).filter(ProductPurchase.image_url == image_url).first() is None:
        db.query(ImageCache).filter(
            ImageCache.image_key == product_image_cache_key(image_url)
        ).delete(synchronize_session=False)
