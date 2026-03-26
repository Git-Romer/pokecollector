from fastapi import APIRouter, UploadFile, File, HTTPException, Depends, Query
from fastapi.responses import FileResponse, StreamingResponse
from api.auth import get_current_user
from models import User
import subprocess
import os
import datetime
import io
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

BACKUP_DIR = "/app/backups"
DATABASE_URL = os.getenv("DATABASE_URL", "")
BACKUP_GROUPS = {
    "collection": ["collection", "wishlist", "binders", "binder_cards"],
    "users": ["users", "user_settings", "settings"],
    "cards": ["cards", "sets", "price_history", "custom_card_matches"],
    "products": ["product_purchases", "portfolio_snapshots"],
    "system": ["sync_log"],
    "images": ["image_cache"],
}


def get_db_params():
    """Parse DATABASE_URL into pg params."""
    url = DATABASE_URL
    # postgresql://user:pass@host:port/dbname
    try:
        url = url.replace("postgresql://", "")
        userpass, rest = url.split("@", 1)
        user, password = userpass.split(":", 1)
        hostport, dbname = rest.split("/", 1)
        if ":" in hostport:
            host, port = hostport.split(":", 1)
        else:
            host, port = hostport, "5432"
        return {"user": user, "password": password, "host": host, "port": port, "dbname": dbname}
    except Exception as e:
        logger.error(f"Failed to parse DATABASE_URL: {e}")
        return None


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
            cmd.extend(["--exclude-table", "image_cache"])
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

    if not file.filename.endswith(".sql"):
        raise HTTPException(status_code=400, detail="Only .sql files are accepted")

    os.makedirs(BACKUP_DIR, exist_ok=True)
    restore_path = os.path.join(BACKUP_DIR, f"restore_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.sql")

    # Save uploaded file
    content = await file.read()
    with open(restore_path, "wb") as f:
        f.write(content)

    env = os.environ.copy()
    env["PGPASSWORD"] = params["password"]

    try:
        result = subprocess.run(
            [
                "psql",
                "-h", params["host"],
                "-p", params["port"],
                "-U", params["user"],
                "-d", params["dbname"],
                "-f", restore_path,
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

        os.unlink(restore_path)

        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Restore failed: {result.stderr}")

        return {"message": "Database restored successfully"}

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Restore timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="psql not found")
