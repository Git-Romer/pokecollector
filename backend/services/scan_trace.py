"""Consent-controlled structured scanner diagnostics for offline analysis.

Tracing is available only when ``SCAN_TRACE_DIR`` is configured and is enabled
separately by each user. One JSON file is written per scan attempt with the
sanitized source image alongside it. Files remain until that user explicitly
deletes them (or their account is deleted).
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from models import UserSetting

logger = logging.getLogger(__name__)

SCAN_DIAGNOSTICS_SETTING_KEY = "scan_diagnostics_enabled"
SCAN_TRACE_STORAGE_ENV = "SCAN_TRACE_STORAGE_DIR"

_SENSITIVE_ERROR_PATTERNS = (
    (re.compile(r"AIza[0-9A-Za-z_-]{20,}"), "[REDACTED_API_KEY]"),
    (
        re.compile(r"(?i)((?:authorization|x-goog-api-key)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+"),
        r"\1[REDACTED]",
    ),
    (
        re.compile(r"(?i)([?&](?:key|api_key|token)=)[^&\s]+"),
        r"\1[REDACTED]",
    ),
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
        "[REDACTED_TOKEN]",
    ),
    (re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{20,}\b"), "[REDACTED_TOKEN]"),
)

CANDIDATE_FIELDS = (
    "tcg_card_id",
    "name",
    "number",
    "set",
    "set_abbreviation",
    "printed_total",
    "artist",
    "hp",
    "regulation_mark",
    "image",
    "lang",
)


def trace_root() -> Path | None:
    raw = (os.environ.get("SCAN_TRACE_DIR") or "").strip()
    return Path(raw) if raw else None


def trace_storage_root() -> Path | None:
    """Stable cleanup root, retained even while new collection is disabled."""
    raw = (os.environ.get(SCAN_TRACE_STORAGE_ENV) or "").strip()
    return Path(raw) if raw else trace_root()


def _ensure_private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path


def _root_is_writable(root: Path | None) -> bool:
    if root is None:
        return False
    try:
        _ensure_private_dir(root)
        return os.access(root, os.W_OK | os.X_OK)
    except OSError:
        return False


def trace_available() -> bool:
    return _root_is_writable(trace_root())


def trace_deletion_available() -> bool:
    return _root_is_writable(trace_storage_root())


def user_trace_enabled(db, user_id: int) -> bool:
    if not trace_available():
        return False
    row = (
        db.query(UserSetting.value)
        .filter(
            UserSetting.user_id == int(user_id),
            UserSetting.key == SCAN_DIAGNOSTICS_SETTING_KEY,
        )
        .first()
    )
    return bool(row and str(row.value).lower() == "true")


def _safe(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(value))


def _user_dir(user_id: int, root: Path | None = None) -> Path | None:
    root = root or trace_root()
    if root is None:
        return None
    return root / f"user-{int(user_id)}"


def _cleanup_roots(extra_root: Path | None = None) -> list[Path]:
    roots: list[Path] = []
    for root in (extra_root, trace_root(), trace_storage_root()):
        if root is not None and root not in roots:
            roots.append(root)
    return roots


def _revocation_path(root: Path, user_id: int) -> Path:
    return root / f".revoked-user-{int(user_id)}"


def _is_revoked(user_id: int, extra_root: Path | None = None) -> bool:
    return any(
        _revocation_path(root, user_id).exists()
        for root in _cleanup_roots(extra_root)
    )


def _write_private(path: Path, content: bytes | str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        if isinstance(content, bytes):
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
        else:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
    except Exception:
        try:
            path.unlink(missing_ok=True)
        finally:
            raise


def _redact_error(message: str) -> str:
    redacted = str(message)
    for pattern, replacement in _SENSITIVE_ERROR_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


class ScanTrace:
    """Collect one scanner attempt without ever recording credentials."""

    def __init__(
        self,
        *,
        enabled: bool,
        user_id: int,
        mode: str,
        job_id: int | None = None,
        item_id: int | None = None,
        filename: str | None = None,
        model: str | None = None,
    ):
        self.enabled = bool(enabled)
        self.user_id = int(user_id)
        self._root = trace_root() if self.enabled else None
        self.trace_id = uuid.uuid4().hex[:12]
        self.data: dict[str, Any] = {
            "schema_version": 1,
            "trace_id": self.trace_id,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "mode": mode,
            "job_id": job_id,
            "item_id": item_id,
            "filename": filename,
            "model": model,
            "extraction": {},
            "search": {"tcgdex": [], "prefilter": None},
            "candidates": [],
            "decision": {"mechanism": None, "selected": None},
            "ground_truth": None,
            "correct": None,
        }
        self._image: bytes | None = None

    def set_image(self, image_bytes: bytes | None) -> None:
        if not self.enabled or not image_bytes:
            return
        self._image = image_bytes
        self.data["image_sha256"] = hashlib.sha256(image_bytes).hexdigest()
        self.data["image_bytes"] = len(image_bytes)

    def record_extraction(
        self,
        *,
        prompt=None,
        raw_response=None,
        parsed=None,
        usage=None,
    ) -> None:
        if not self.enabled:
            return
        section = self.data["extraction"]
        if prompt is not None:
            section["prompt"] = prompt
        if raw_response is not None:
            section["raw_response"] = raw_response
        if parsed is not None:
            section["parsed"] = parsed
        if usage is not None:
            section["usage"] = usage

    def record_visual_verification(self, *, raw_response: str, selected: int | None) -> None:
        if self.enabled:
            self.data["visual_verification"] = {
                "raw_response": raw_response,
                "selected_position": selected,
            }

    def record_tcgdex(
        self,
        *,
        language: str,
        query: str,
        status: int | None,
        count: int | None,
        error: str | None = None,
    ) -> None:
        if not self.enabled:
            return
        entry = {
            "language": language,
            "query": query,
            "status": status,
            "results": count,
        }
        if error:
            entry["error"] = error
        self.data["search"]["tcgdex"].append(entry)

    def record_prefilter(self, target, matched: int, total: int) -> None:
        if self.enabled:
            self.data["search"]["prefilter"] = {
                "target": target,
                "matched": matched,
                "of": total,
            }

    def record_candidates(self, candidates: list[dict], rank_key=None) -> None:
        if not self.enabled:
            return
        snapshot = []
        for position, card in enumerate(candidates):
            entry = {field: card.get(field) for field in CANDIDATE_FIELDS}
            entry["position"] = position
            if rank_key is not None:
                try:
                    entry["rank_key"] = list(rank_key(card))
                except Exception:
                    pass
            snapshot.append(entry)
        self.data["candidates"] = snapshot

    def record_phash(
        self,
        scores: list[tuple[int, str]],
        *,
        accepted: str | None,
        reason: str,
    ) -> None:
        if self.enabled:
            self.data["phash"] = {
                "distances": [
                    {"distance": distance, "tcg_card_id": card_id}
                    for distance, card_id in scores
                ],
                "accepted": accepted,
                "reason": reason,
            }

    def reject_phash(self, reason: str) -> None:
        if self.enabled and isinstance(self.data.get("phash"), dict):
            self.data["phash"]["accepted"] = None
            self.data["phash"]["reason"] = reason

    def record_decision(self, mechanism: str, selected: str | None = None) -> None:
        if self.enabled:
            self.data["decision"] = {
                "mechanism": mechanism,
                "selected": selected,
            }

    def record_error(self, message: str) -> None:
        if self.enabled:
            self.data["error"] = _redact_error(message)

    def save(self) -> Path | None:
        user_dir = _user_dir(self.user_id, self._root)
        if (
            not self.enabled
            or self._root is None
            or user_dir is None
            or _is_revoked(self.user_id, self._root)
        ):
            return None
        image_temp: Path | None = None
        json_temp: Path | None = None
        try:
            _ensure_private_dir(self._root)
            _ensure_private_dir(user_dir)
            day = user_dir / datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
            _ensure_private_dir(day)
            stem = "-".join(
                filter(
                    None,
                    [
                        f"job{_safe(self.data['job_id'])}" if self.data.get("job_id") else None,
                        f"item{_safe(self.data['item_id'])}" if self.data.get("item_id") else None,
                        self.trace_id,
                    ],
                )
            )
            if self._image:
                image_path = day / f"{stem}.jpg"
                image_temp = day / f".{stem}.{uuid.uuid4().hex}.jpg.tmp"
                _write_private(image_temp, self._image)
                self.data["image_file"] = image_path.name
            path = day / f"{stem}.json"
            json_temp = day / f".{stem}.{uuid.uuid4().hex}.json.tmp"
            _write_private(
                json_temp,
                json.dumps(self.data, indent=2, ensure_ascii=False, default=str),
            )
            if _is_revoked(self.user_id, self._root):
                if image_temp:
                    image_temp.unlink(missing_ok=True)
                json_temp.unlink(missing_ok=True)
                return None
            if image_temp:
                image_temp.replace(image_path)
            json_temp.replace(path)
            return path
        except Exception:
            if image_temp:
                image_temp.unlink(missing_ok=True)
            if json_temp:
                json_temp.unlink(missing_ok=True)
            logger.exception("Failed to write scan diagnostics")
            return None


def create_scan_trace(
    db,
    user_id: int,
    *,
    mode: str,
    job_id: int | None = None,
    item_id: int | None = None,
    filename: str | None = None,
    model: str | None = None,
) -> ScanTrace:
    return ScanTrace(
        enabled=user_trace_enabled(db, user_id),
        user_id=user_id,
        mode=mode,
        job_id=job_id,
        item_id=item_id,
        filename=filename,
        model=model,
    )


def record_ground_truth(
    user_id: int,
    job_id: int,
    item_id: int,
    card_id: str,
) -> int:
    """Label all attempts for one reviewed item with the user's confirmed card."""
    if not card_id:
        return 0
    updated = 0
    pattern = f"job{_safe(job_id)}-item{_safe(item_id)}-*.json"
    paths: set[Path] = set()
    for root in _cleanup_roots():
        user_dir = _user_dir(user_id, root)
        if user_dir is not None and user_dir.is_dir():
            paths.update(user_dir.glob(f"*/{pattern}"))
    for path in sorted(paths):
        temp: Path | None = None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["ground_truth"] = card_id
            selected = (data.get("decision") or {}).get("selected")
            # A trace that deliberately abstained did not make a top-1 choice.
            # Keep it labelled for retrieval analysis without counting it as an
            # incorrect automatic decision.
            data["correct"] = (selected == card_id) if selected else None
            candidates = [
                candidate.get("tcg_card_id")
                for candidate in data.get("candidates") or []
            ]
            data["ground_truth_rank"] = (
                candidates.index(card_id) + 1 if card_id in candidates else None
            )
            temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
            _write_private(
                temp,
                json.dumps(data, indent=2, ensure_ascii=False, default=str),
            )
            temp.replace(path)
            updated += 1
        except Exception:
            if temp:
                temp.unlink(missing_ok=True)
            logger.exception("Failed to label scan diagnostics at %s", path)
    return updated


def _delete_user_dir(root: Path, user_id: int) -> dict[str, int]:
    user_dir = _user_dir(user_id, root)
    if user_dir is None or not user_dir.exists():
        return {"traces": 0, "images": 0}
    traces = sum(1 for path in user_dir.rglob("*.json") if path.is_file())
    images = sum(1 for path in user_dir.rglob("*.jpg") if path.is_file())
    if user_dir.is_symlink():
        user_dir.unlink()
    else:
        shutil.rmtree(user_dir)
    return {"traces": traces, "images": images}


def delete_user_traces(user_id: int) -> dict[str, int]:
    """Delete this user's data from all active and stable cleanup roots."""
    deleted = {"traces": 0, "images": 0}
    try:
        for root in _cleanup_roots():
            result = _delete_user_dir(root, user_id)
            deleted["traces"] += result["traces"]
            deleted["images"] += result["images"]
    except Exception:
        logger.exception("Failed to delete scan diagnostics for user %s", user_id)
        raise
    return deleted


def revoke_user_traces(user_id: int) -> dict[str, int]:
    """Permanently prevent a deleted account's in-flight traces from returning."""
    roots = _cleanup_roots()
    created_markers: list[Path] = []
    try:
        for root in roots:
            _ensure_private_dir(root)
            marker = _revocation_path(root, user_id)
            if not marker.exists():
                _write_private(marker, "account deleted\n")
                created_markers.append(marker)
        deleted = {"traces": 0, "images": 0}
        for root in roots:
            result = _delete_user_dir(root, user_id)
            deleted["traces"] += result["traces"]
            deleted["images"] += result["images"]
        return deleted
    except Exception:
        for marker in created_markers:
            marker.unlink(missing_ok=True)
        logger.exception("Failed to revoke scan diagnostics for user %s", user_id)
        raise


def clear_user_trace_revocation(user_id: int) -> None:
    """Undo a tombstone only when account deletion itself rolls back."""
    for root in _cleanup_roots():
        _revocation_path(root, user_id).unlink(missing_ok=True)
