"""Automatic pre-upgrade database backups.

The app runs lightweight, startup-time migrations. Before a version change can run
those migrations against an existing installation, create a PostgreSQL dump so an
admin can roll back if the upgrade has an unexpected data issue.
"""
from __future__ import annotations

import datetime as _dt
import logging
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlparse

from sqlalchemy import text

logger = logging.getLogger(__name__)

BACKUP_DIR = Path(os.getenv("BACKUP_DIR", "/app/backups"))
LAST_VERSION_SETTING = "last_successful_app_version"
_BACKUP_VERSION_RE = re.compile(
    r"^pre_upgrade_(?P<from>.+)_to_(?P<to>.+)_(?P<timestamp>\d{8}_\d{6})\.sql$"
)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        logger.warning("Invalid %s=%r, using default %s", name, raw, default)
        return default


def _safe_slug(value: str | None) -> str:
    value = (value or "unknown").strip() or "unknown"
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value)[:80]


def _parse_database_url(database_url: str) -> dict[str, str] | None:
    parsed = urlparse(database_url)
    scheme = parsed.scheme.split("+", 1)[0]
    if scheme not in {"postgresql", "postgres"}:
        return None
    if not parsed.hostname or not parsed.path or parsed.path == "/":
        return None
    return {
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "host": parsed.hostname,
        "port": str(parsed.port or 5432),
        "dbname": unquote(parsed.path.lstrip("/")),
    }


def _settings_table_exists(conn) -> bool:
    return bool(conn.execute(text("""
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'settings'
        )
    """)).scalar())


def _read_setting(conn, key: str) -> str | None:
    row = conn.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": key}).first()
    return str(row[0]) if row and row[0] is not None else None


def record_successful_app_version(engine, current_version: str) -> None:
    """Record the app version only after startup migrations completed."""
    if not current_version:
        return
    try:
        with engine.begin() as conn:
            if not _settings_table_exists(conn):
                return
            conn.execute(text("""
                INSERT INTO settings (key, value)
                VALUES (:key, :value)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            """), {"key": LAST_VERSION_SETTING, "value": current_version})
    except Exception:
        logger.warning("Could not record successful app version %s", current_version, exc_info=True)


def _backup_already_exists(current_version: str, previous_version: str | None) -> bool:
    if not BACKUP_DIR.exists():
        return False
    from_slug = _safe_slug(previous_version)
    to_slug = _safe_slug(current_version)
    prefix = f"pre_upgrade_{from_slug}_to_{to_slug}_"
    return any(
        path.is_file() and path.stat().st_size > 0
        for path in BACKUP_DIR.glob(f"{prefix}*.sql")
        if _BACKUP_VERSION_RE.match(path.name)
    )


def _create_pg_dump(database_url: str, current_version: str, previous_version: str | None) -> Path:
    params = _parse_database_url(database_url)
    if not params:
        raise RuntimeError("DATABASE_URL is not a valid PostgreSQL URL")

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = (
        f"pre_upgrade_{_safe_slug(previous_version)}_"
        f"to_{_safe_slug(current_version)}_{timestamp}.sql"
    )
    filepath = BACKUP_DIR / filename
    temp_path = filepath.with_name(f".{filename}.tmp")

    try:
        temp_path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not remove stale temporary backup %s", temp_path, exc_info=True)

    env = os.environ.copy()
    env["PGPASSWORD"] = params["password"]
    cmd = [
        "pg_dump",
        "-h", params["host"],
        "-p", params["port"],
        "-U", params["user"],
        "-d", params["dbname"],
        "-f", str(temp_path),
        "--clean",
        "--if-exists",
    ]

    try:
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"pg_dump failed: {result.stderr.strip() or result.stdout.strip()}")
        if not temp_path.exists() or temp_path.stat().st_size == 0:
            raise RuntimeError("pg_dump did not create a non-empty backup file")
        os.replace(temp_path, filepath)
        return filepath
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove failed temporary backup %s", temp_path, exc_info=True)
        raise


def _backup_sort_key(path: Path) -> tuple[str, float]:
    match = _BACKUP_VERSION_RE.match(path.name)
    timestamp = match.group("timestamp") if match else ""
    return timestamp, path.stat().st_mtime


def _prune_old_backups(keep: int) -> None:
    if keep <= 0 or not BACKUP_DIR.exists():
        return
    backups = [
        path for path in BACKUP_DIR.glob("pre_upgrade_*.sql")
        if _BACKUP_VERSION_RE.match(path.name)
    ]
    backups.sort(key=_backup_sort_key, reverse=True)
    for old_backup in backups[keep:]:
        try:
            old_backup.unlink()
            logger.info("Removed old pre-upgrade backup %s", old_backup)
        except OSError:
            logger.warning("Could not remove old pre-upgrade backup %s", old_backup, exc_info=True)


def maybe_create_pre_upgrade_backup(engine, database_url: str, current_version: str) -> Path | None:
    """Create a backup before startup migrations if an existing install changed version.

    Returns the backup path when a backup was created, otherwise None.
    Raises when backup is required and cannot be created.
    """
    enabled = _env_bool("PRE_UPGRADE_BACKUP_ENABLED", True)
    required = _env_bool("PRE_UPGRADE_BACKUP_REQUIRED", True)
    keep = _env_int("PRE_UPGRADE_BACKUP_KEEP", 10, minimum=1)

    if not enabled:
        logger.info("Pre-upgrade backups are disabled by PRE_UPGRADE_BACKUP_ENABLED")
        return None
    if not current_version or current_version == "0.0.0":
        logger.info("Skipping pre-upgrade backup because app version is not set")
        return None

    try:
        with engine.connect() as conn:
            if not _settings_table_exists(conn):
                logger.info("Skipping pre-upgrade backup on fresh database: settings table does not exist yet")
                return None
            previous_version = _read_setting(conn, LAST_VERSION_SETTING)
    except Exception as exc:
        message = f"Could not inspect database before upgrade backup: {exc}"
        if required:
            raise RuntimeError(message) from exc
        logger.warning(message, exc_info=True)
        return None

    if previous_version == current_version:
        logger.info("Skipping pre-upgrade backup: app version %s already recorded", current_version)
        return None
    if previous_version is None:
        logger.info(
            "No previous app version is recorded; treating this existing database as an install worth backing up"
        )
    if _backup_already_exists(current_version, previous_version):
        logger.info(
            "Skipping pre-upgrade backup: backup already exists for %s -> %s",
            previous_version or "unknown",
            current_version,
        )
        return None

    try:
        backup_path = _create_pg_dump(database_url, current_version, previous_version)
        logger.info(
            "Created pre-upgrade backup before version change %s -> %s: %s",
            previous_version or "unknown",
            current_version,
            backup_path,
        )
        _prune_old_backups(keep)
        return backup_path
    except Exception as exc:
        message = f"Pre-upgrade backup failed before version {current_version}: {exc}"
        if required:
            raise RuntimeError(message) from exc
        logger.warning(message, exc_info=True)
        return None
