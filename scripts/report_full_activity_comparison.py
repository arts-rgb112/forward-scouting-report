"""Reproducible §5 before/after report for the full Tier 3 activity source."""

from __future__ import annotations

import json
import statistics

from api_server.service import _benchmark_position_key, _v2_frame
from tactical_ratio import get_full_activity_context, get_heatmap_points, get_tactical_session_row


LANES = ("L5", "L4", "L3L", "L3R", "L2", "L1")


def _tail(value: float, values: list[float]) -> dict[str, float]:
    denominator = len(values) - 1
    return {
        "topPct": round(sum(item > value for item in values) * 100.0 / denominator, 4),
        "bottomPct": round(sum(item < value for item in values) * 100.0 / denominator, 4),
    }


def _legacy_spread_x(row: dict[str, object]) -> float:
    """The released max-180 source has no stored spread column in this checkout."""
    points = get_heatmap_points(str(row["fotmob_player_id"]), str(row["heatmap_key"]))
    return round(statistics.pstdev(float(point[0]) for point in points), 4)


def main() -> None:
    records, _, _, _ = _v2_frame("2025/2026", "league", 7, "all")
    full_rows = []
    legacy_rows = []
    for record in records:
        if _benchmark_position_key(record.get("position")) != "striker":
            continue
        player_id = int(record["player_id"])
        legacy = get_tactical_session_row(player_id, str(record.get("league_name") or ""), "2025/2026")
        if legacy is None:
            continue
        legacy_rows.append((player_id, legacy))
        aggregate = get_full_activity_context(str(legacy.get("heatmap_key") or ""))
        if aggregate is not None:
            full_rows.append((player_id, legacy, aggregate))
    kane_legacy = next(row for player_id, row in legacy_rows if player_id == 194165)
    _, _, kane_full = next(row for row in full_rows if row[0] == 194165)
    full_medians = {
        "inBoxRatio": statistics.median(row[2]["inBoxRatio"] for row in full_rows),
        "activitySpreadX": statistics.median(row[2]["activitySpreadX"] for row in full_rows),
        "lanes": {lane: statistics.median(row[2]["lanes"][lane]["activityPct"] for row in full_rows) for lane in LANES},
    }
    selected_lane = max(
        LANES,
        key=lambda lane: abs(kane_full["lanes"][lane]["activityPct"] - full_medians["lanes"][lane]),
    )
    result = {
        "context": "2025/2026 league scope7 Striker",
        "legacyPopulation": len(legacy_rows),
        "fullPopulation": len(full_rows),
        "legacyMedians": {
            "inBoxRatio": statistics.median(row["in_box_ratio"] for _, row in legacy_rows),
            "laneL4": statistics.median(row["lane_4_ratio"] for _, row in legacy_rows),
            "activitySpreadX": statistics.median(_legacy_spread_x(row) for _, row in legacy_rows),
        },
        "fullMedians": {"inBoxRatio": full_medians["inBoxRatio"], "selectedLane": selected_lane, "lanePct": full_medians["lanes"][selected_lane], "activitySpreadX": full_medians["activitySpreadX"]},
        "kane": {
            "legacy": {"inBoxRatio": kane_legacy["in_box_ratio"], "laneL4": kane_legacy["lane_4_ratio"], "activitySpreadX": _legacy_spread_x(kane_legacy)},
            "full": {"inBoxRatio": kane_full["inBoxRatio"], "selectedLane": selected_lane, "lanePct": kane_full["lanes"][selected_lane]["activityPct"], "activitySpreadX": kane_full["activitySpreadX"], "lanes": kane_full["lanes"]},
            "legacyTails": {
                "inBoxRatio": _tail(kane_legacy["in_box_ratio"], [row["in_box_ratio"] for _, row in legacy_rows]),
                "laneL4": _tail(kane_legacy["lane_4_ratio"], [row["lane_4_ratio"] for _, row in legacy_rows]),
                "activitySpreadX": _tail(_legacy_spread_x(kane_legacy), [_legacy_spread_x(row) for _, row in legacy_rows]),
            },
            "fullTails": {
                "inBoxRatio": _tail(kane_full["inBoxRatio"], [row[2]["inBoxRatio"] for row in full_rows]),
                "selectedLane": _tail(kane_full["lanes"][selected_lane]["activityPct"], [row[2]["lanes"][selected_lane]["activityPct"] for row in full_rows]),
                "activitySpreadX": _tail(kane_full["activitySpreadX"], [row[2]["activitySpreadX"] for row in full_rows]),
            },
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
