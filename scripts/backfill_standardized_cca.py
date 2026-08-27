"""Offline static CCA and activity-range backfill from stored heatmap snapshots.

This script deliberately never imports or calls SportsAPI collection code.  It
only reads ``data/tactical_heatmap_points.json`` and atomically rewrites CCA
and activity-range columns of the selected CSV.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from continuous_core import _valid_points, continuous_core_summary


DEFAULT_RATIOS = ROOT / "data" / "tactical_3zone_ratio.csv"
DEFAULT_POINTS = ROOT / "data" / "tactical_heatmap_points.json"
ACTIVITY_SPREAD_FIELDS = ("activity_spread_x", "activity_spread_y", "activity_valid_point_count")


def _activity_spreads(points: object) -> tuple[float, float]:
    """Return population standard deviations on the stored 0–100 coordinate axes.

    These are coordinate-distribution ranges, not distance or work-rate data.
    The static CSV stores them so tactical-summary-v2 never processes heatmap
    coordinates at request time.
    """
    valid = _valid_points(points if isinstance(points, list) else [])
    if not valid:
        return 0.0, 0.0

    def population_stddev(values: list[float]) -> float:
        mean = sum(values) / len(values)
        return (sum((value - mean) ** 2 for value in values) / len(values)) ** 0.5

    return (
        population_stddev([point[0] for point in valid]),
        population_stddev([point[1] for point in valid]),
    )


def recalculate_rows(
    rows: list[dict[str, str]], points_by_key: dict[str, object], *, keys: set[str] | None = None,
    recalculate_cca: bool = True,
) -> tuple[list[dict[str, str]], list[float]]:
    """Return copied rows with only requested heatmap sessions recalculated."""
    areas: list[float] = []
    result: list[dict[str, str]] = []
    for original in rows:
        row = dict(original)
        heatmap_key = str(row.get("heatmap_key") or "")
        if keys is not None and heatmap_key not in keys:
            result.append(row)
            continue
        points = points_by_key.get(heatmap_key)
        if not isinstance(points, list):
            raise ValueError(
                f"heatmap snapshot missing a list for heatmap_key={heatmap_key!r}"
            )
        area = 0.0
        if recalculate_cca:
            core = continuous_core_summary(points, heatmap_key=heatmap_key)
            area = float(core["coreAreaPct"])
            row["cca_area_pct"] = f"{area:.4f}"
            row["activity_filter"] = "fixed-n60-r20-v2"
        spread_x, spread_y = _activity_spreads(points)
        valid_point_count = len(_valid_points(points))
        row["activity_spread_x"] = f"{spread_x:.4f}"
        row["activity_spread_y"] = f"{spread_y:.4f}"
        row["activity_valid_point_count"] = str(valid_point_count)
        areas.append(area)
        result.append(row)
    return result, areas


def backfill(ratios_path: Path, points_path: Path, output_path: Path, *, keys: set[str] | None = None,
             recalculate_cca: bool = True) -> tuple[int, int]:
    with ratios_path.open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        fieldnames = reader.fieldnames
        if not fieldnames or "cca_area_pct" not in fieldnames or "heatmap_key" not in fieldnames:
            raise ValueError("ratios CSV must contain heatmap_key and cca_area_pct")
        rows = list(reader)
    fieldnames = list(fieldnames)
    for field in ACTIVITY_SPREAD_FIELDS:
        if field not in fieldnames:
            fieldnames.append(field)
    raw_points = json.loads(points_path.read_text(encoding="utf-8"))
    if not isinstance(raw_points, dict):
        raise ValueError("heatmap snapshot must be an object keyed by heatmap_key")
    updated_rows, areas = recalculate_rows(rows, raw_points, keys=keys, recalculate_cca=recalculate_cca)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", newline="", dir=output_path.parent, delete=False) as temporary:
        writer = csv.DictWriter(
            temporary, fieldnames=fieldnames, extrasaction="raise", lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(updated_rows)
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, output_path)
    return len(updated_rows), len(areas)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ratios", type=Path, default=DEFAULT_RATIOS)
    parser.add_argument("--points", type=Path, default=DEFAULT_POINTS)
    parser.add_argument("--output", type=Path, default=DEFAULT_RATIOS)
    parser.add_argument("--heatmap-key", action="append", default=[], help="Optional exact session key; repeatable.")
    parser.add_argument("--activity-only", action="store_true", help="Update only static activity-spread/count columns; preserve CCA.")
    args = parser.parse_args()
    rows, updated = backfill(
        args.ratios, args.points, args.output,
        keys=set(args.heatmap_key) if args.heatmap_key else None,
        recalculate_cca=not args.activity_only,
    )
    print(f"standardized CCA backfill: rows={rows} updated={updated} output={args.output}")


if __name__ == "__main__":
    main()
