"""Audit static shot-coordinate coverage against every tactical session."""

from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shotmap import load_shotmap_points


RATIOS_PATH = ROOT / "data" / "tactical_3zone_ratio.csv"
REPORT_PATH = ROOT / "data" / "missing_shotmap_sessions.csv"
REPORT_FIELDS = (
    "fotmob_player_id", "player_name", "competition_name", "season_name",
    "heatmap_key", "reason",
)


def audit() -> tuple[int, int, int, Counter[str]]:
    snapshots = load_shotmap_points()
    with RATIOS_PATH.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    missing: list[dict[str, str]] = []
    covered = 0
    empty = 0
    by_season: Counter[str] = Counter()
    for row in rows:
        key = str(row.get("heatmap_key") or "").strip()
        if key in snapshots:
            covered += 1
            empty += not bool(snapshots[key])
            continue
        season = str(row.get("season_name") or "")
        by_season[season] += 1
        missing.append({
            field: (
                "snapshot_missing" if field == "reason"
                else str(row.get(field) or "")
            )
            for field in REPORT_FIELDS
        })
    with REPORT_PATH.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=REPORT_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(missing)
    return len(rows), covered, empty, by_season


if __name__ == "__main__":
    total, covered, empty, by_season = audit()
    print(f"Shotmap coverage: {covered}/{total}; verified zero-shot sessions: {empty}")
    print("Missing by season: " + ", ".join(f"{season}={count}" for season, count in sorted(by_season.items())))
