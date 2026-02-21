from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
import subprocess
import os
import datetime
import io
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

BACKUP_DIR = "/app/backups"
DATABASE_URL = os.getenv("DATABASE_URL", "")


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
def download_backup():
    """Create and download a PostgreSQL dump."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    params = get_db_params()
    if not params:
        raise HTTPException(status_code=500, detail="Database URL not configured")

    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"pokemon_tcg_backup_{timestamp}.sql"
    filepath = os.path.join(BACKUP_DIR, filename)

    env = os.environ.copy()
    env["PGPASSWORD"] = params["password"]

    try:
        result = subprocess.run(
            [
                "pg_dump",
                "-h", params["host"],
                "-p", params["port"],
                "-U", params["user"],
                "-d", params["dbname"],
                "-f", filepath,
                "--clean",
                "--if-exists",
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
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
async def restore_backup(file: UploadFile = File(...)):
    """Restore database from a SQL dump file."""
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
