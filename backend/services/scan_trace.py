"""Structured recording of scan attempts, for offline analysis.

Every stage that influences the final match is captured — the prompt, the raw
model response, the parsed fields, every candidate with the signals ranking saw,
and which mechanism actually decided the answer. Ground truth is filled in later
from what the user picked in review, so accuracy can be measured over time rather
than eyeballed one card at a time.

Off unless SCAN_TRACE_DIR is set, so production installs pay nothing. Traces are
plain JSON files (one per scan, image alongside) rather than DB rows: they are
write-once analysis data, easy to grep, diff and delete, and keeping image bytes
out of Postgres avoids repeating the unbounded-growth problem image_cache has.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Signals ranking consumes, snapshotted per candidate so a later analysis can ask
# "which signal would have fixed this?" without re-running the scan.
CANDIDATE_FIELDS = (
    "tcg_card_id", "name", "number", "set", "set_abbreviation",
    "artist", "hp", "regulation_mark", "printed_total_mismatch", "image",
)


def trace_dir() -> Optional[Path]:
    raw = (os.environ.get("SCAN_TRACE_DIR") or "").strip()
    if not raw:
        return None
    return Path(raw)


def trace_enabled() -> bool:
    return trace_dir() is not None


def _safe(part: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(part))


class ScanTrace:
    """Collects one scan's data. Inert when tracing is disabled, so call sites
    never need to branch on it."""

    def __init__(self, *, mode: str, job_id=None, item_id=None, filename=None, model=None):
        self.enabled = trace_enabled()
        self.trace_id = uuid.uuid4().hex[:12]
        self.data: dict = {
            "trace_id": self.trace_id,
            "created_at": datetime.datetime.utcnow().isoformat(),
            "mode": mode,                 # "single" | "batch"
            "job_id": job_id,
            "item_id": item_id,
            "filename": filename,
            "model": model,
            "extraction": {},
            "search": {"tcgdex": [], "prefilter": None},
            "candidates": [],
            "decision": {"mechanism": None, "selected": None},
            # Filled in when the user acts in review — see record_ground_truth.
            "ground_truth": None,
            "correct": None,
        }
        self._image: Optional[bytes] = None

    # ── collection ────────────────────────────────────────────────────────
    def set_image(self, image_bytes: Optional[bytes]) -> None:
        if not self.enabled or not image_bytes:
            return
        self._image = image_bytes
        self.data["image_sha256"] = hashlib.sha256(image_bytes).hexdigest()
        self.data["image_bytes"] = len(image_bytes)

    def record_extraction(self, *, prompt=None, raw_response=None, parsed=None, usage=None) -> None:
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

    def record_tcgdex(self, url: str, status: int, count: Optional[int]) -> None:
        if not self.enabled:
            return
        self.data["search"]["tcgdex"].append({"url": url, "status": status, "results": count})

    def record_prefilter(self, target, matched: int, total: int) -> None:
        if not self.enabled:
            return
        self.data["search"]["prefilter"] = {"target": target, "matched": matched, "of": total}

    def record_candidates(self, candidates: list[dict], rank_key=None) -> None:
        """Snapshot the ranked candidate list, including each one's rank key."""
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

    def record_phash(self, scores: list[tuple[int, str]], *, accepted: Optional[str], reason: str) -> None:
        if not self.enabled:
            return
        self.data["phash"] = {
            "distances": [{"distance": d, "tcg_card_id": cid} for d, cid in scores],
            "accepted": accepted,
            "reason": reason,
        }

    def record_decision(self, mechanism: str, selected=None) -> None:
        """Which mechanism actually settled the match — the single most useful
        field for spotting where accuracy is coming from."""
        if not self.enabled:
            return
        self.data["decision"] = {"mechanism": mechanism, "selected": selected}

    def record_error(self, message: str) -> None:
        if not self.enabled:
            return
        self.data["error"] = str(message)

    # ── persistence ───────────────────────────────────────────────────────
    def save(self) -> Optional[Path]:
        base = trace_dir()
        if not self.enabled or base is None:
            return None
        try:
            day = base / datetime.datetime.utcnow().strftime("%Y-%m-%d")
            day.mkdir(parents=True, exist_ok=True)
            stem = "-".join(filter(None, [
                f"job{_safe(self.data['job_id'])}" if self.data.get("job_id") else None,
                f"item{_safe(self.data['item_id'])}" if self.data.get("item_id") else None,
                self.trace_id,
            ]))
            if self._image:
                image_path = day / f"{stem}.jpg"
                image_path.write_bytes(self._image)
                self.data["image_file"] = image_path.name
            path = day / f"{stem}.json"
            path.write_text(json.dumps(self.data, indent=2, ensure_ascii=False, default=str))
            return path
        except Exception:
            logger.exception("Failed to write scan trace")
            return None


def record_ground_truth(job_id, item_id, card_id: str) -> Optional[Path]:
    """Mark what the card actually was, from the user's choice in review.

    This is the whole point of tracing: the review UI is a human confirming the
    identity, so every confirmation is a free labelled example. Scores the
    existing decision as correct or not so accuracy is queryable directly.
    """
    base = trace_dir()
    if base is None or not card_id:
        return None
    try:
        pattern = f"job{_safe(job_id)}-item{_safe(item_id)}-*.json"
        matches = sorted(base.glob(f"*/{pattern}"))
        if not matches:
            return None
        path = matches[-1]
        data = json.loads(path.read_text())
        data["ground_truth"] = card_id
        selected = (data.get("decision") or {}).get("selected")
        data["correct"] = (selected == card_id) if selected else False
        # Where the right answer actually sat, so near-misses are distinguishable
        # from complete failures.
        ranks = [c.get("tcg_card_id") for c in data.get("candidates") or []]
        data["ground_truth_rank"] = ranks.index(card_id) + 1 if card_id in ranks else None
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str))
        return path
    except Exception:
        logger.exception("Failed to record scan ground truth")
        return None
