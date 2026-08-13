"""Backfill the persisted CCA width with the 30-zone True Core definition."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from true_core import true_core_zones_from_points


DATA_DIR = ROOT / "data"
RATIOS_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
POINTS_PATH = DATA_DIR / "tactical_heatmap_points.json"
DEFINITION_VERSION = "true-core-30zone-v1"


def backfill() -> tuple[int, int, int]:
    points_by_key = json.loads(POINTS_PATH.read_text(encoding="utf-8"))
    with RATIOS_PATH.open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    if not fieldnames:
        raise RuntimeError("tactical ratio CSV has no header")

    output: list[dict[str, str]] = []
    seen_keys: set[str] = set()
    updated = 0
    duplicates = 0
    for row in rows:
        heatmap_key = str(row.get("heatmap_key") or "").strip()
        if not heatmap_key or heatmap_key not in points_by_key:
            raise RuntimeError(f"missing stored heatmap points for {heatmap_key or '<empty>'}")
        if heatmap_key in seen_keys:
            duplicates += 1
            continue
        seen_keys.add(heatmap_key)
        core = true_core_zones_from_points(points_by_key[heatmap_key])
        if not core["zoneCount"]:
            raise RuntimeError(f"empty True Core for {heatmap_key}")
        row["cca_area_pct"] = f"{float(core['coreAreaPct']):.2f}"
        row["activity_filter"] = DEFINITION_VERSION
        output.append(row)
        updated += 1

    temporary = RATIOS_PATH.with_suffix(".csv.tmp")
    with temporary.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(output)
    temporary.replace(RATIOS_PATH)
    return len(rows), updated, duplicates


if __name__ == "__main__":
    before, updated, duplicates = backfill()
    print(f"True Core backfill: {before} -> {updated} rows; removed {duplicates} duplicate sessions")
