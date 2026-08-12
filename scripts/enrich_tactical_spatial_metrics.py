"""Backfill S.P.E.A.R. 2.0 spatial fields from already stored heatmap points.

This job deliberately makes no SportsAPI or FotMob request.  It is safe to run
while the API ticket quota is exhausted and only enriches sessions whose saved
heatmap key still has coordinates.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.build_tactical_ratios import ACTIVITY_FILTER_VERSION, OUTPUT_FIELDS, core_activity_points, spatial_metrics


CSV_PATH = ROOT / "data" / "tactical_3zone_ratio.csv"
POINTS_PATH = ROOT / "data" / "tactical_heatmap_points.json"


def main() -> None:
    if not CSV_PATH.exists() or not POINTS_PATH.exists():
        raise SystemExit("tactical ratio CSV or heatmap point JSON is missing")
    rows = list(csv.DictReader(CSV_PATH.open(encoding="utf-8", newline="")))
    points_by_key = json.loads(POINTS_PATH.read_text(encoding="utf-8"))
    enriched = 0
    for row in rows:
        points = points_by_key.get(row.get("heatmap_key", ""), [])
        valid_points = points if isinstance(points, list) else []
        metrics = spatial_metrics(
            core_activity_points(valid_points), positional_points=valid_points,
        )
        for field, value in metrics.items():
            row[field] = f"{value:.4f}"
        row["activity_filter"] = ACTIVITY_FILTER_VERSION
        if valid_points:
            enriched += 1
    fieldnames = list(dict.fromkeys([*OUTPUT_FIELDS, *(key for row in rows for key in row)]))
    with CSV_PATH.open("w", encoding="utf-8", newline="") as destination:
        writer = csv.DictWriter(destination, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"Enriched {enriched}/{len(rows)} tactical sessions without API calls.")


if __name__ == "__main__":
    main()
