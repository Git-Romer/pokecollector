#!/usr/bin/env python3
"""Summarise scan traces: what is working, what is not, and why.

Traces are written when SCAN_TRACE_DIR is set (see services/scan_trace.py).
Ground truth comes from what the user confirmed in review, so accuracy here is
measured against real decisions rather than a hand-labelled set.

    python scripts/analyse_scan_traces.py [trace_dir] [--failures] [--field-nulls]

Deliberately stdlib-only so it runs anywhere, including inside the container.
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def load(trace_dir: Path):
    for path in sorted(trace_dir.glob("*/*.json")):
        try:
            yield path, json.loads(path.read_text())
        except Exception as exc:  # a half-written trace should not stop analysis
            print(f"  ! skipping {path.name}: {exc}", file=sys.stderr)


def pct(part, whole):
    return f"{100 * part / whole:.0f}%" if whole else "n/a"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("trace_dir", nargs="?", default="data/scan-traces")
    ap.add_argument("--failures", action="store_true", help="list every incorrect scan")
    ap.add_argument("--field-nulls", action="store_true", help="how often each extracted field came back null")
    args = ap.parse_args()

    trace_dir = Path(args.trace_dir)
    if not trace_dir.exists():
        sys.exit(f"No trace directory at {trace_dir}. Set SCAN_TRACE_DIR and run some scans.")

    traces = list(load(trace_dir))
    if not traces:
        sys.exit(f"No traces found under {trace_dir}.")

    total = len(traces)
    labelled = [t for _, t in traces if t.get("ground_truth")]
    correct = [t for t in labelled if t.get("correct")]
    errors = [t for _, t in traces if t.get("error")]

    print(f"\n{total} traces  ({len(labelled)} reviewed, {len(errors)} errored)")
    if labelled:
        print(f"top-1 accuracy: {len(correct)}/{len(labelled)}  ({pct(len(correct), len(labelled))})")
        ranks = Counter(t.get("ground_truth_rank") for t in labelled)
        in_list = sum(v for k, v in ranks.items() if k)
        print(f"correct card present in candidates: {in_list}/{len(labelled)}  ({pct(in_list, len(labelled))})")
        near = sum(v for k, v in ranks.items() if k and k > 1)
        if near:
            print(f"  ...of which ranked below #1: {near}  (retrieval fine, ranking wrong)")
        if ranks.get(None):
            print(f"  never retrieved at all: {ranks[None]}  (search/prefilter problem, not ranking)")

    # Which mechanism decided, and how often each is right. This is the number
    # that says where accuracy actually comes from.
    by_mech = defaultdict(lambda: [0, 0])
    for _, t in traces:
        mech = (t.get("decision") or {}).get("mechanism") or "none"
        by_mech[mech][0] += 1
        if t.get("ground_truth"):
            by_mech[mech][1] += 1 if t.get("correct") else 0
    print("\ndecision mechanism:")
    for mech, (used, right) in sorted(by_mech.items(), key=lambda kv: -kv[1][0]):
        judged = sum(1 for _, t in traces
                     if (t.get("decision") or {}).get("mechanism") == mech and t.get("ground_truth"))
        print(f"  {mech:<14} used {used:>4}  correct {right}/{judged} ({pct(right, judged)})")

    modes = Counter((t.get("mode") or "?") for _, t in traces)
    print(f"\nmode: " + ", ".join(f"{k}={v}" for k, v in modes.items()))

    phash = [t.get("phash") for _, t in traces if t.get("phash")]
    if phash:
        reasons = Counter(p.get("reason") for p in phash)
        print("pHash outcomes: " + ", ".join(f"{k}={v}" for k, v in reasons.items()))

    if args.field_nulls:
        # A field that is usually null is a prompt problem; one that is usually
        # populated but often wrong is a legibility problem.
        counts = defaultdict(lambda: [0, 0])
        for _, t in traces:
            parsed = (t.get("extraction") or {}).get("parsed") or {}
            for field, value in parsed.items():
                counts[field][0] += 1
                if value in (None, "", "null"):
                    counts[field][1] += 1
        print("\nextracted field null rate:")
        for field, (seen, nulls) in sorted(counts.items(), key=lambda kv: -kv[1][1]):
            print(f"  {field:<28} {nulls}/{seen} null ({pct(nulls, seen)})")

    if args.failures:
        bad = [(p, t) for p, t in traces if t.get("ground_truth") and not t.get("correct")]
        print(f"\n{len(bad)} incorrect:")
        for path, t in bad:
            sel = (t.get("decision") or {}).get("selected")
            print(f"  {path.name}")
            print(f"    picked {sel} via {(t.get('decision') or {}).get('mechanism')}, "
                  f"actual {t['ground_truth']} (rank {t.get('ground_truth_rank')})")
            parsed = (t.get("extraction") or {}).get("parsed") or {}
            print(f"    read: " + ", ".join(
                f"{k}={parsed.get(k)!r}" for k in
                ("number_local", "number_total", "set_code", "regulation_mark", "artist", "hp")
            ))
    print()


if __name__ == "__main__":
    main()
