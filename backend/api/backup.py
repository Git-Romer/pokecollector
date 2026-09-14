import datetime
import logging
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from api.auth import get_current_user
from models import User
from services.postgres_cli import parse_database_url

router = APIRouter()
logger = logging.getLogger(__name__)

BACKUP_DIR = "/app/backups"
DATABASE_URL = os.getenv("DATABASE_URL", "")
RESTORE_CHUNK_SIZE = 1024 * 1024
BACKUP_GROUPS = {
    "collection": ["collection", "wishlist", "binders", "binder_cards"],
    "users": ["users", "user_settings", "settings"],
    "cards": ["cards", "sets", "price_history", "custom_card_matches"],
    "products": ["product_purchases", "product_cards", "product_ledger_entries", "portfolio_snapshots"],
    "system": ["sync_log"],
    "images": ["image_cache"],
}


def get_db_params():
    """Parse DATABASE_URL into pg params."""
    return parse_database_url(DATABASE_URL)


@router.get("/download")
def download_backup(
    include: str = Query(
        default="full",
        description="Comma-separated: full,collection,users,cards,products,images",
    ),
    current_user: User = Depends(get_current_user),
):
    """Create and download a PostgreSQL dump."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    params = get_db_params()
    if not params:
        raise HTTPException(status_code=500, detail="Database URL not configured")

    groups = [group.strip() for group in include.split(",") if group.strip()]
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"pokemon_tcg_backup_{timestamp}.sql"
    filepath = os.path.join(BACKUP_DIR, filename)

    env = os.environ.copy()
    env["PGPASSWORD"] = params["password"]

    cmd = [
        "pg_dump",
        "-h", params["host"],
        "-p", params["port"],
        "-U", params["user"],
        "-d", params["dbname"],
        "-f", filepath,
        "--clean",
        "--if-exists",
    ]

    if "full" in groups:
        if "images" not in groups:
            # Keep the cache schema and its owned sequence, but omit the large cache rows.
            cmd.extend(["--exclude-table-data", "image_cache"])
    else:
        tables = []
        for group in groups:
            if group in BACKUP_GROUPS:
                tables.extend(BACKUP_GROUPS[group])
        tables = list(dict.fromkeys(tables))
        if not tables:
            raise HTTPException(status_code=400, detail="No valid backup groups selected")
        for table in tables:
            cmd.extend(["-t", table])

    try:
        result = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"pg_dump failed: {result.stderr}")

        return FileResponse(
            filepath,
            media_type="application/sql",
            filename=filename,
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Backup timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="pg_dump not found")


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Restore database from a SQL dump file."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    params = get_db_params()
    if not params:
        raise HTTPException(status_code=500, detail="Database URL not configured")

    if not (file.filename or "").lower().endswith(".sql"):
        raise HTTPException(status_code=400, detail="Only .sql files are accepted")

    restore_path: Path | None = None
    try:
        restore_dir = Path(BACKUP_DIR)
        restore_dir.mkdir(parents=True, exist_ok=True)
        restore_fd, raw_restore_path = tempfile.mkstemp(
            prefix="restore_",
            suffix=".sql",
            dir=restore_dir,
        )
        restore_path = Path(raw_restore_path)
        uploaded_bytes = 0
        with os.fdopen(restore_fd, "wb") as destination:
            while chunk := await file.read(RESTORE_CHUNK_SIZE):
                destination.write(chunk)
                uploaded_bytes += len(chunk)
        if uploaded_bytes == 0:
            raise HTTPException(status_code=400, detail="Backup file is empty")

        env = os.environ.copy()
        env["PGPASSWORD"] = params["password"]
        result = subprocess.run(
            [
                "psql",
                "-h", params["host"],
                "-p", params["port"],
                "-U", params["user"],
                "-d", params["dbname"],
                "--no-psqlrc",
                "-v", "ON_ERROR_STOP=1",
                "--single-transaction",
                "-f", str(restore_path),
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Restore failed: {result.stderr}")

        return {"message": "Database restored successfully"}

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Restore timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="psql not found")
    finally:
        if restore_path is not None:
            try:
                restore_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove temporary restore file %s", restore_path, exc_info=True)


@router.post("/clear-image-cache")
def clear_image_cache(current_user: User = Depends(get_current_user)):
    """Clear the image cache directory (admin only)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    import shutil
    images_dir = "/app/images"
    if os.path.exists(images_dir):
        shutil.rmtree(images_dir)
        os.makedirs(images_dir, exist_ok=True)
    return {"message": "Image cache cleared"}
