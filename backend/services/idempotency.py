"""Exactly-once effects for retried append operations (``Idempotency-Key``).

The key row is staged in the same database transaction as the business write,
so a crash can never leave a write without its key (or a key without its
write). Only successful (2xx) results are stored; failures roll back with the
transaction and a retry simply runs again.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import IdempotencyKey

IDEMPOTENCY_HEADER = "Idempotency-Key"
EXPECTED_USER_HEADER = "X-Expected-User-Id"
REPLAYED_HEADER = "Idempotent-Replayed"
KEY_TTL = datetime.timedelta(days=14)
SCOPE_COLLECTION_ADD = "collection.add"
SCOPE_WISHLIST_ADD = "wishlist.add"
SCOPE_SCAN_ENQUEUE = "scan.enqueue"

_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_DIGEST_CHUNK_BYTES = 1024 * 1024


@dataclass(frozen=True)
class StoredResponse:
    status_code: int
    body: Any


class IdempotencyContext:
    """Result of :func:`begin_idempotent`.

    ``active`` is True when a valid key was supplied. A non-None ``replay``
    means the caller must return ``replay_response(replay)`` immediately.
    """

    def __init__(
        self,
        active: bool = False,
        replay: StoredResponse | None = None,
        recorder: Callable[[Session, int, Any], None] | None = None,
    ):
        self.active = active
        self.replay = replay
        self._recorder = recorder

    def record(self, db: Session, status_code: int, body: Any) -> None:
        """Stage the completed row in the CURRENT transaction (does not commit)."""
        if not self.active or self._recorder is None:
            return
        self._recorder(db, status_code, body)


def _error(status_code: int, code: str, message: str, headers: dict | None = None) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
        headers=headers,
    )


def _header(headers: Mapping[str, str] | None, name: str) -> str | None:
    if not headers:
        return None
    try:
        value = headers.get(name)
    except Exception:
        value = None
    if value is not None:
        return value
    lowered = name.lower()
    for candidate, candidate_value in dict(headers).items():
        if str(candidate).lower() == lowered:
            return candidate_value
    return None


def has_idempotency_key(headers: Mapping[str, str] | None) -> bool:
    """True when the request carries an ``Idempotency-Key`` header (valid or not)."""
    return _header(headers, IDEMPOTENCY_HEADER) is not None


def check_expected_user(user, headers: Mapping[str, str] | None) -> None:
    """Reject a request made under a different account than the client expected."""
    raw = _header(headers, EXPECTED_USER_HEADER)
    if raw is None:
        return
    candidate = raw.strip()
    if not re.fullmatch(r"[0-9]{1,18}", candidate):
        raise _error(400, "idempotency_key_invalid", f"{EXPECTED_USER_HEADER} must be an integer.")
    if int(candidate) != user.id:
        raise _error(409, "wrong_account", "This request was queued for a different account.")


def _db_dialect_name(db: Session) -> str | None:
    bind = db.get_bind()
    dialect = getattr(bind, "dialect", None)
    return getattr(dialect, "name", None)


def begin_idempotent(
    db: Session,
    user,
    headers: Mapping[str, str] | None,
    *,
    scope: str,
    fingerprint: str,
) -> IdempotencyContext:
    check_expected_user(user, headers)

    raw_key = _header(headers, IDEMPOTENCY_HEADER)
    if raw_key is None:
        return IdempotencyContext(active=False)

    key = raw_key.strip()
    if len(key) >= 2 and key.startswith('"') and key.endswith('"'):
        key = key[1:-1]
    if not _KEY_PATTERN.match(key):
        raise _error(
            400,
            "idempotency_key_invalid",
            f"{IDEMPOTENCY_HEADER} must be 16-64 characters of A-Z, a-z, 0-9, '_' or '-'.",
        )

    if _db_dialect_name(db) == "postgresql":
        # Never a blocking lock: sync DB waits inside async handlers would
        # freeze the event loop. A held lock means the first request is still
        # running, so the client is told to come back shortly.
        acquired = db.execute(
            text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"),
            {"k": f"idem:{user.id}:{key}"},
        ).scalar()
        if not acquired:
            raise _error(
                409,
                "idempotency_in_progress",
                "A request with this key is still being processed.",
                headers={"Retry-After": "2"},
            )

    now = datetime.datetime.utcnow()
    row = (
        db.query(IdempotencyKey)
        .filter(IdempotencyKey.user_id == user.id, IdempotencyKey.key == key)
        .first()
    )
    if row is not None:
        if row.expires_at <= now:
            db.delete(row)
            db.flush()
        elif row.scope != scope or row.request_hash != fingerprint:
            raise _error(
                422,
                "idempotency_key_reused",
                "This Idempotency-Key was already used for a different request.",
            )
        else:
            return IdempotencyContext(
                active=True,
                replay=StoredResponse(row.response_status, row.response_body),
            )

    user_id = user.id

    def _record(session: Session, status_code: int, body: Any) -> None:
        if not 200 <= status_code < 300:
            raise ValueError("Only successful (2xx) results may be stored.")
        created = datetime.datetime.utcnow()
        session.add(
            IdempotencyKey(
                user_id=user_id,
                key=key,
                scope=scope,
                request_hash=fingerprint,
                response_status=status_code,
                response_body=body,
                created_at=created,
                expires_at=created + KEY_TTL,
            )
        )
        try:
            session.flush()
        except IntegrityError:
            # Another transaction won the race after an intermediate commit
            # released the advisory lock. Rolling back also discards the
            # business writes, which is the point.
            session.rollback()
            raise _error(
                409,
                "idempotency_in_progress",
                "A request with this key is still being processed.",
                headers={"Retry-After": "2"},
            )

    return IdempotencyContext(active=True, recorder=_record)


def fingerprint_json(scope: str, payload: Any) -> str:
    encoded = json.dumps(
        {"scope": scope, "payload": payload},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


async def digest_uploads(uploads) -> list[str]:
    """SHA-256 of each upload's bytes, read in 1 MiB chunks, then rewound."""
    digests: list[str] = []
    for upload in uploads:
        digest = hashlib.sha256()
        while True:
            chunk = await upload.read(_DIGEST_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
        await upload.seek(0)
        digests.append(digest.hexdigest())
    return digests


def fingerprint_scan(scope: str, positions, digests: list[str]) -> str:
    return fingerprint_json(
        scope,
        {"individual_positions": sorted(positions), "files": list(digests)},
    )


def replay_response(stored: StoredResponse) -> JSONResponse:
    return JSONResponse(
        status_code=stored.status_code,
        content=stored.body,
        headers={REPLAYED_HEADER: "true"},
    )


def purge_expired_idempotency_keys(
    db: Session,
    now: datetime.datetime | None = None,
    batch_size: int = 1000,
) -> int:
    """Delete expired rows in bounded batches and return how many were removed."""
    now = now or datetime.datetime.utcnow()
    removed = 0
    while True:
        ids = [
            row[0]
            for row in db.query(IdempotencyKey.id)
            .filter(IdempotencyKey.expires_at <= now)
            .limit(batch_size)
            .all()
        ]
        if not ids:
            break
        db.query(IdempotencyKey).filter(IdempotencyKey.id.in_(ids)).delete(
            synchronize_session=False
        )
        db.commit()
        removed += len(ids)
    return removed
