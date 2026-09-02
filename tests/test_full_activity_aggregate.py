"""Regression tests for the display-only count-weighted Tier 3 aggregate."""

from __future__ import annotations

import importlib.util
from pathlib import Path


_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_full_activity_aggregate.py"
_SPEC = importlib.util.spec_from_file_location("full_activity_aggregate", _SCRIPT)
assert _SPEC and _SPEC.loader
aggregate = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(aggregate)


def test_count_weighted_aggregate_keeps_both_centre_half_lanes() -> None:
    result = aggregate.aggregate_payload({
        "data": {"points": [
            {"x": 90, "y": 49.9, "count": 2},
            {"x": 90, "y": 50.0, "count": 3},
            {"x": 70, "y": 70.0, "count": 5},
        ]},
    })

    assert result["activityValidPointCount"] == 10
    assert result["lanes"]["L3R"] == {"activityPoints": 2, "activityPct": 20.0}
    assert result["lanes"]["L3L"] == {"activityPoints": 3, "activityPct": 30.0}
    assert result["centerBoundaryActivityPointCount"] == 3
    # The legacy five-lane grid is represented only inside this new artifact;
    # its centre receives both six-lane halves and no scorer file is written.
    assert result["positionalGrid"]["D6L3"]["activityPoints"] == 5
    assert sum(item["activityPoints"] for item in result["lanes"].values()) == 10
    histogram = result["activityHeatmap"]
    assert histogram["definitionVersion"] == "full-tier3-count-weighted-histogram-32x22-v1"
    assert len(histogram["cellCounts"]) == 704
    assert sum(histogram["cellCounts"]) == 10


def test_invalid_records_are_excluded_without_turning_zero_into_missing() -> None:
    result = aggregate.aggregate_payload({
        "data": {"points": [
            {"x": 10, "y": 10, "count": 0},
            {"x": "bad", "y": 10, "count": 1},
            {"x": 10, "y": 10, "count": 4},
        ]},
    })

    assert result["activityValidPointCount"] == 4
    assert result["activityInvalidPointCount"] == 2
    assert result["invalidPointReasons"] == {
        "invalid_coordinate_or_count": 1,
        "non_positive_count": 1,
    }
    assert sum(result["activityHeatmap"]["cellCounts"]) == 4
