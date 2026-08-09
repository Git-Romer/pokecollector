"""Validated temporary storage for background card scans."""

from __future__ import annotations

import datetime
import io
import os
import shutil
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import text
from sqlalchemy.orm import Session

from models import ScanJob, ScanJobItem

try:
    from pillow_heif import register_heif_opener

    register_heif_opener(thumbnails=False)
    HEIC_AVAILABLE = True
except ImportError:  # pragma: no cover - production installs the dependency
    HEIC_AVAILABLE = False


MAX_FILES_PER_JOB = 50
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_JOB_BYTES = 200 * 1024 * 1024
MAX_IMAGE_PIXELS = 50_000_000
MAX_IMAGE_EDGE = 2048
JPEG_QUALITY = 90
SCAN_RETENTION_DAYS = 14
ALLOWED_IMAGE_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "HEIF", "HEIC"})


class ScanUploadError(ValueError):
    """An uploaded file is unsafe or outside the scanner limits."""


@dataclass(frozen=True)
class SanitizedScanImage:
    data: bytes
    content_type: str = "image/jpeg"


def scan_upload_root() -> Path:
    configured = os.environ.get("SCAN_UPLOAD_DIR", "").strip()
    root = Path(configured) if configured else Path(__file__).resolve().parent.parent / "data" / "scan-uploads"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root.resolve()


async def read_limited_upload(upload, *, remaining_job_bytes: int) -> bytes:
    """Read one UploadFile without allowing it or the whole job to grow unbounded."""
    if remaining_job_bytes <= 0:
        raise ScanUploadError("The scan job exceeds the 200 MB upload limit.")

    limit = min(MAX_FILE_BYTES, remaining_job_bytes)
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await upload.read(min(1024 * 1024, limit + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_FILE_BYTES:
            raise ScanUploadError("Each scan photo must be 15 MB or smaller.")
        if size > remaining_job_bytes:
            raise ScanUploadError("The scan job exceeds the 200 MB upload limit.")
        chunks.append(chunk)

    if not chunks:
        raise ScanUploadError("An uploaded scan photo is empty.")
    return b"".join(chunks)


def sanitize_image_bytes(raw: bytes) -> SanitizedScanImage:
    """Decode, verify, orient, resize, and metadata-strip a scan photo."""
    if not raw:
        raise ScanUploadError("An uploaded scan photo is empty.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                image_format = str(source.format or "").upper()
                if image_format not in ALLOWED_IMAGE_FORMATS:
                    raise ScanUploadError("Only JPEG, PNG, WebP, and HEIC scan photos are supported.")
                if image_format in {"HEIF", "HEIC"} and not HEIC_AVAILABLE:
                    raise ScanUploadError("HEIC support is unavailable on this server.")
                if getattr(source, "n_frames", 1) != 1:
                    raise ScanUploadError("Animated images cannot be used as scan photos.")
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise ScanUploadError("The scan photo has unsupported dimensions.")
                source.load()
                oriented = ImageOps.exif_transpose(source)
                if oriented.mode in {"RGBA", "LA"} or (
                    oriented.mode == "P" and "transparency" in oriented.info
                ):
                    rgba = oriented.convert("RGBA")
                    rgb = Image.new("RGB", rgba.size, "white")
                    rgb.paste(rgba, mask=rgba.getchannel("A"))
                    oriented = rgb
                else:
                    oriented = oriented.convert("RGB")
                oriented.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                oriented.save(
                    output,
                    format="JPEG",
                    quality=JPEG_QUALITY,
                    optimize=True,
                    progressive=True,
                )
    except ScanUploadError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ScanUploadError("The scan photo is too large to decode safely.")
    except (UnidentifiedImageError, OSError, ValueError):
        raise ScanUploadError("The uploaded file is not a valid supported image.")

    return SanitizedScanImage(output.getvalue())


def _job_directory(job_id: int) -> Path:
    return scan_upload_root() / str(int(job_id))


def store_sanitized_image(job_id: int, image: SanitizedScanImage) -> tuple[str, int]:
    """Atomically persist an already-sanitized JPEG under a random name."""
    job_dir = _job_directory(job_id)
    job_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = f"{uuid.uuid4().hex}.jpg"
    final_path = job_dir / name
    temporary_path = job_dir / f".{name}.tmp"
    try:
        with temporary_path.open("xb") as handle:
            handle.write(image.data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, final_path)
        final_path.chmod(0o600)
    finally:
        temporary_path.unlink(missing_ok=True)
    relative_path = final_path.relative_to(scan_upload_root()).as_posix()
    return relative_path, len(image.data)


def resolve_scan_path(relative_path: str) -> Path:
    root = scan_upload_root()
    candidate = (root / str(relative_path or "")).resolve()
    if candidate == root or root not in candidate.parents:
        raise ScanUploadError("Invalid scan image path.")
    return candidate


def delete_scan_image(relative_path: str | None) -> None:
    if not relative_path:
        return
    try:
        path = resolve_scan_path(relative_path)
    except ScanUploadError:
        return
    path.unlink(missing_ok=True)
    try:
        path.parent.rmdir()
    except OSError:
        pass


def delete_job_directory(job_id: int) -> None:
    shutil.rmtree(_job_directory(job_id), ignore_errors=True)


def purge_orphaned_scan_directories(
    db: Session,
    *,
    now: datetime.datetime | None = None,
    grace_minutes: int = 60,
) -> int:
    """Remove crash leftovers that have no committed database job."""
    now = now or datetime.datetime.utcnow()
    cutoff = now.timestamp() - (grace_minutes * 60)
    known_ids = {str(row[0]) for row in db.query(ScanJob.id).all()}
    removed = 0
    for child in scan_upload_root().iterdir():
        if not child.is_dir() or child.name in known_ids:
            continue
        try:
            if child.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(child, ignore_errors=True)
        removed += 1
    return removed


async def create_scan_job(db: Session, user_id: int, uploads: list) -> ScanJob:
    """Validate and persist a job without retaining any original upload bytes."""
    if not uploads:
        raise ScanUploadError("At least one scan photo is required.")
    if len(uploads) > MAX_FILES_PER_JOB:
        raise ScanUploadError("A scan job can contain at most 50 photos.")

    now = datetime.datetime.utcnow()
    job = ScanJob(
        user_id=user_id,
        status="pending",
        created_at=now,
        updated_at=now,
        expires_at=now + datetime.timedelta(days=SCAN_RETENTION_DAYS),
    )
    db.add(job)
    db.flush()
    # Creating two jobs for the same user at once must not race on the
    # round-robin cursor's primary key. PostgreSQL and the SQLite test suite
    # both support this conflict-safe insert.
    db.execute(
        text(
            "INSERT INTO scan_queue_user_state (user_id, last_dispatched_at) "
            "VALUES (:user_id, NULL) ON CONFLICT (user_id) DO NOTHING"
        ),
        {"user_id": user_id},
    )

    raw_total = 0
    try:
        for position, upload in enumerate(uploads):
            raw = await read_limited_upload(
                upload,
                remaining_job_bytes=MAX_JOB_BYTES - raw_total,
            )
            raw_total += len(raw)
            sanitized = sanitize_image_bytes(raw)
            relative_path, byte_size = store_sanitized_image(job.id, sanitized)
            db.add(
                ScanJobItem(
                    job_id=job.id,
                    user_id=user_id,
                    position=position,
                    image_path=relative_path,
                    content_type=sanitized.content_type,
                    byte_size=byte_size,
                    status="pending",
                    resolved=False,
                    attempts=0,
                    transient_failures=0,
                    next_attempt_at=now,
                    created_at=now,
                    updated_at=now,
                )
            )
        db.commit()
        db.refresh(job)
        return job
    except Exception:
        db.rollback()
        delete_job_directory(job.id)
        raise
