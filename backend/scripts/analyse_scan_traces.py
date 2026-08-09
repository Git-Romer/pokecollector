#!/usr/bin/env python3
"""Summarise consented scanner diagnostics written under SCAN_TRACE_DIR.

Usage:
    python scripts/analyse_scan_traces.py [trace_dir] [--failures] [--field-nulls]
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def load(trace_dir: Path):
    for path in sorted(trace_dir.glob("user-*/*/*.json")):
        try:
            yield path, json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"  ! skipping {path.name}: {exc}", file=sys.stderr)


def pct(part, whole):
    return f"{100 * part / whole:.0f}%" if whole else "n/a"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("trace_dir", nargs="?", default="data/scan-traces")
    parser.add_argument("--failures", action="store_true")
    parser.add_argument("--field-nulls", action="store_true")
    args = parser.parse_args()

    trace_dir = Path(args.trace_dir)
    if not trace_dir.exists():
        sys.exit(f"No trace directory at {trace_dir}.")

    traces = list(load(trace_dir))
    if not traces:
        sys.exit(f"No consented traces found under {trace_dir}.")

    total = len(traces)
    labelled = [trace for _, trace in traces if trace.get("ground_truth")]
    judged = [trace for trace in labelled if trace.get("correct") is not None]
    correct = [trace for trace in judged if trace.get("correct")]
    errors = [trace for _, trace in traces if trace.get("error")]

    print(f"\n{total} traces ({len(labelled)} reviewed, {len(errors)} errored)")
    if labelled:
        print(
            f"top-1 accuracy: {len(correct)}/{len(judged)} "
            f"({pct(len(correct), len(judged))}); "
            f"{len(labelled) - len(judged)} abstained"
        )
        ranks = Counter(trace.get("ground_truth_rank") for trace in labelled)
        in_list = sum(count for rank, count in ranks.items() if rank)
        print(
            f"correct card present in candidates: {in_list}/{len(labelled)} "
            f"({pct(in_list, len(labelled))})"
        )
        below_first = sum(count for rank, count in ranks.items() if rank and rank > 1)
        if below_first:
            print(f"  ranked below #1: {below_first} (retrieval worked; ranking missed)")
        if ranks.get(None):
            print(f"  never retrieved: {ranks[None]}")

    by_mechanism = defaultdict(lambda: [0, 0, 0])
    for _, trace in traces:
        mechanism = (trace.get("decision") or {}).get("mechanism") or "none"
        by_mechanism[mechanism][0] += 1
        if trace.get("ground_truth") and trace.get("correct") is not None:
            by_mechanism[mechanism][1] += 1
            by_mechanism[mechanism][2] += 1 if trace.get("correct") else 0
    print("\ndecision mechanism:")
    for mechanism, (used, judged, right) in sorted(
        by_mechanism.items(), key=lambda entry: -entry[1][0]
    ):
        print(
            f"  {mechanism:<20} used {used:>4}  "
            f"correct {right}/{judged} ({pct(right, judged)})"
        )

    modes = Counter(trace.get("mode") or "?" for _, trace in traces)
    print("\nmode: " + ", ".join(f"{key}={value}" for key, value in modes.items()))

    phash = [trace.get("phash") for _, trace in traces if trace.get("phash")]
    if phash:
        reasons = Counter(entry.get("reason") for entry in phash)
        print("pHash outcomes: " + ", ".join(f"{k}={v}" for k, v in reasons.items()))

    if args.field_nulls:
        counts = defaultdict(lambda: [0, 0])
        for _, trace in traces:
            parsed = (trace.get("extraction") or {}).get("parsed") or {}
            for field, value in parsed.items():
                counts[field][0] += 1
                if value in (None, "", "null"):
                    counts[field][1] += 1
        print("\nextracted field null rate:")
        for field, (seen, nulls) in sorted(counts.items(), key=lambda item: -item[1][1]):
            print(f"  {field:<28} {nulls}/{seen} null ({pct(nulls, seen)})")

    if args.failures:
        failures = [
            (path, trace)
            for path, trace in traces
            if trace.get("ground_truth") and trace.get("correct") is False
        ]
        print(f"\n{len(failures)} incorrect:")
        for path, trace in failures:
            selected = (trace.get("decision") or {}).get("selected")
            print(f"  {path.name}")
            print(
                f"    picked {selected} via "
                f"{(trace.get('decision') or {}).get('mechanism')}, "
                f"actual {trace['ground_truth']} (rank {trace.get('ground_truth_rank')})"
            )
    print()


if __name__ == "__main__":
    main()
