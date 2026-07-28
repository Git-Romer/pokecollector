"""Weekly local Excel backups for John John's PC.

The XLSX workbook is the portable, user-facing backup format. These backups are
local files in the existing mounted backup directory and intentionally do not
send collection data to external services.
"""

from __future__ import annotations

import datetime
import logging
import os
from pathlib import Path

from sqlalchemy.orm import Session, joinedload

from api.export import build_collection_workbook
from models import Card, CollectionItem, ProductPurchase, StorageLocation, User
from services.card_visibility import visible_card_filter

logger = logging.getLogger(__name__)

BACKUP_DIR = Path(os.getenv("EXCEL_BACKUP_DIR", os.getenv("BACKUP_DIR", "/app/backups"))) / "excel"
EXCEL_BACKUP_KEEP = int(os.getenv("EXCEL_BACKUP_KEEP", "8"))


def _safe_username(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in {"-", "_"} else "_" for char in value.strip())
    return cleaned[:48] or "user"


def _backup_sort_key(path: Path) -> tuple[float, str]:
    try:
        return path.stat().st_mtime, path.name
    except OSError:
        return 0, path.name


def _prune_user_backups(directory: Path, user_slug: str, keep: int = EXCEL_BACKUP_KEEP) -> list[Path]:
    if keep <= 0 or not directory.exists():
        return []
    backups = list(directory.glob(f"john-johns-pc-{user_slug}-*.xlsx"))
    backups.sort(key=_backup_sort_key, reverse=True)
    removed = []
    for old_backup in backups[keep:]:
        try:
            old_backup.unlink()
            removed.append(old_backup)
        except OSError:
            logger.warning("Could not remove old Excel backup %s", old_backup, exc_info=True)
    return removed


def create_weekly_excel_backups(db: Session, backup_date: datetime.date | None = None) -> list[Path]:
    """Create one local XLSX backup per active user and retain the newest eight."""

    backup_date = backup_date or datetime.date.today()
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    created = []
    users = db.query(User).filter(User.is_active == True).order_by(User.id).all()
    for user in users:
        items = db.query(CollectionItem).join(Card, Card.id == CollectionItem.card_id).options(
            joinedload(CollectionItem.card).joinedload(Card.set_ref)
        ).filter(
            CollectionItem.user_id == user.id,
            visible_card_filter(db, user.id, "all"),
        ).all()
        products = db.query(ProductPurchase).filter(
            ProductPurchase.user_id == user.id
        ).order_by(ProductPurchase.purchase_date.desc()).all()
        locations = db.query(StorageLocation).filter(
            StorageLocation.user_id == user.id
        ).order_by(StorageLocation.is_default.desc(), StorageLocation.name).all()

        user_slug = f"{user.id}-{_safe_username(user.username)}"
        filename = f"john-johns-pc-{user_slug}-{backup_date.isoformat()}.xlsx"
        path = BACKUP_DIR / filename
        tmp_path = path.with_suffix(".tmp")
        tmp_path.write_bytes(build_collection_workbook(items, products, locations))
        tmp_path.replace(path)
        created.append(path)
        removed = _prune_user_backups(BACKUP_DIR, user_slug)
        if removed:
            logger.info("Pruned %s old Excel backup(s) for user %s", len(removed), user.id)

    logger.info("Created %s weekly Excel backup(s) in %s", len(created), BACKUP_DIR)
    return created


def run_weekly_excel_backup() -> None:
    from database import SessionLocal

    db = SessionLocal()
    try:
        create_weekly_excel_backups(db)
    except Exception as exc:
        logger.error("Weekly Excel backup failed: %s", exc, exc_info=True)
    finally:
        db.close()
