"""Build the compact, count-weighted Tier 3 activity aggregate.

This is deliberately separate from ``build_tactical_ratios.py``.  It reads the
ignored raw SportsAPI heatmaps and writes a new, versioned display artifact; it
never rewrites score inputs (``tactical_3zone_ratio.csv`` or
``tactical_heatmap_points.json``).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW_ROOT = DATA / "harvest" / "heatmaps"
DEFAULT_OUTPUT = DATA / "tactical_full_activity_aggregate.json"

VERSION = "sportsapi-heatmap-points-count-weighted-full-v1"
LANES = (("L1", 0.0, 21.82), ("L2", 21.82, 37.0), ("L3R", 37.0, 50.0),
         ("L3L", 50.0, 63.0), ("L4", 63.0, 78.18), ("L5", 78.18, 100.0))
DEPTHS = (0.0, 16.67, 33.33, 50.0, 66.67, 83.33, 100.0)


def _slug(value: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")


def _bucket(value: float, boundaries: tuple[float, ...] | list[float]) -> int | None:
    if not math.isfinite(value) or value < boundaries[0] or value > boundaries[-1]:
        return None
    for index, upper in enumerate(boundaries[1:]):
        if value < upper or index == len(boundaries) - 2:
            return index
    return None


def _rounded_percentages(counts: dict[str, int], total: int, order: tuple[str, ...]) -> dict[str, float]:
    if total <= 0:
        return {key: 0.0 for key in order}
    raw = {key: counts[key] * 100.0 / total for key in order}
    result = {key: round(raw[key], 4) for key in order}
    residual = round(100.0 - sum(result.values()), 4)
    if residual:
        winner = max(order, key=lambda key: (counts[key], -order.index(key)))
        result[winner] = round(result[winner] + residual, 4)
    return result


def _context(row: dict[str, str]) -> tuple[str, Path]:
    key = row["heatmap_key"].strip()
    path = RAW_ROOT / _slug(row["competition_name"]) / row["season_id"].strip() / f"{row['sportsapi_player_id'].strip()}.json"
    return key, path


def aggregate_payload(payload: object) -> dict[str, Any]:
    points = payload.get("data", {}).get("points", []) if isinstance(payload, dict) else []
    lane_counts = {lane: 0 for lane, _, _ in LANES}
    grid_counts = {f"D{depth + 1}L{lane + 1}": 0 for depth in range(6) for lane in range(5)}
    raw_cells = 0
    valid = 0
    in_box = 0
    center_boundary = 0
    invalid = Counter()
    weighted_x = weighted_y = weighted_x2 = weighted_y2 = 0.0
    for point in points if isinstance(points, list) else []:
        raw_cells += 1
        if not isinstance(point, dict):
            invalid["point_not_object"] += 1
            continue
        try:
            x, y = float(point.get("x")), float(point.get("y"))
            count = int(point.get("count"))
        except (TypeError, ValueError):
            invalid["invalid_coordinate_or_count"] += 1
            continue
        if count <= 0:
            invalid["non_positive_count"] += 1
            continue
        lane = _bucket(y, tuple((0.0, 21.82, 37.0, 50.0, 63.0, 78.18, 100.0)))
        depth = _bucket(x, DEPTHS)
        if lane is None or depth is None:
            invalid["outside_normalized_pitch"] += count
            continue
        lane_counts[LANES[lane][0]] += count
        if y == 50.0:
            center_boundary += count
        # The existing 30-cell display stays five-lane: the new centre split
        # maps both L3R and L3L back to its original centre lane.
        five_lane = lane if lane < 3 else lane - 1
        grid_counts[f"D{depth + 1}L{five_lane + 1}"] += count
        valid += count
        if x >= 83.0 and 21.1 <= y <= 78.9:
            in_box += count
        weighted_x += x * count
        weighted_y += y * count
        weighted_x2 += x * x * count
        weighted_y2 += y * y * count
    lane_order = tuple(lane for lane, _, _ in LANES)
    lane_pct = _rounded_percentages(lane_counts, valid, lane_order)
    grid_order = tuple(grid_counts)
    grid_pct = _rounded_percentages(grid_counts, valid, grid_order)
    def spread(sum_value: float, sum_square: float) -> float | None:
        if not valid:
            return None
        return round(math.sqrt(max(0.0, sum_square / valid - (sum_value / valid) ** 2)), 4)
    return {
        "rawCellRecordCount": raw_cells,
        "activitySourceRecordCount": sum(int(point.get("count", 0)) for point in points if isinstance(point, dict) and isinstance(point.get("count"), int)),
        "activityValidPointCount": valid,
        "activityInvalidPointCount": sum(invalid.values()),
        "invalidPointReasons": dict(sorted(invalid.items())),
        "inBoxActivityPoints": in_box,
        "centerBoundaryActivityPointCount": center_boundary,
        "inBoxRatio": round(in_box * 100.0 / valid, 4) if valid else None,
        "lanes": {lane: {"activityPoints": lane_counts[lane], "activityPct": lane_pct[lane]} for lane in lane_order},
        "positionalGrid": {cell: {"activityPoints": grid_counts[cell], "activityPct": grid_pct[cell]} for cell in grid_order},
        "activitySpreadX": spread(weighted_x, weighted_x2),
        "activitySpreadY": spread(weighted_y, weighted_y2),
    }


def build(output: Path = DEFAULT_OUTPUT) -> dict[str, Any]:
    contexts: dict[str, dict[str, Any]] = {}
    unavailable = 0
    with (DATA / "tactical_3zone_ratio.csv").open(encoding="utf-8", newline="") as source:
        for row in csv.DictReader(source):
            key, path = _context(row)
            if key in contexts:
                continue
            if not path.exists():
                unavailable += 1
                continue
            try:
                contexts[key] = aggregate_payload(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError, json.JSONDecodeError):
                unavailable += 1
    result = {
        "schemaVersion": "1.0.0",
        "activitySourceDefinitionVersion": VERSION,
        "coordinateVersion": "fotmob-normalized-pitch-0-to-100-v1",
        "countWeighting": "sportsapi-data-points-count-expanded-v1",
        "laneDefinitionVersion": "six-lane-shooting-corridor-v1",
        "contextCount": len(contexts),
        "unavailableContextCount": unavailable,
        "contexts": contexts,
    }
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    summary = build(args.output)
    print(json.dumps({key: summary[key] for key in ("contextCount", "unavailableContextCount", "activitySourceDefinitionVersion")}, ensure_ascii=False))
