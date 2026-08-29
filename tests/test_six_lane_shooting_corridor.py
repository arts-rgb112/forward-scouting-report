"""Strict regression for the additive full-source six-lane corridor API."""

from __future__ import annotations

import json
from pathlib import Path

from api_server.schemas import SixLaneShootingCorridorEnvelope
from api_server.service import build_six_lane_shooting_corridor


def test_kane_scope7_corridor_uses_full_count_weighted_activity() -> None:
    envelope = build_six_lane_shooting_corridor(
        194165, "2025/2026", "league", 7, "all",
    )

    assert envelope is not None
    assert envelope.data.available is True
    assert envelope.data.completeness == "complete"
    assert [lane.id for lane in envelope.data.lanes] == [
        "L5", "L4", "L3L", "L3R", "L2", "L1",
    ]
    assert [lane.activityPct for lane in envelope.data.lanes] == [
        15.7031, 24.1256, 20.5567, 17.8444, 14.7038, 7.0664,
    ]
    assert envelope.data.totals.model_dump() == {
        "sourceShots": 119, "allocatedShots": 108, "goals": 26,
        "xg": 17.9806, "xgEligibleShots": 108,
        "activityPoints": 1401, "activityPct": 100.0,
    }
    assert envelope.data.penaltyShotsExcluded == 11
    assert envelope.data.provenance.activitySourceDefinitionVersion == "sportsapi-heatmap-points-count-weighted-full-v1"
    assert envelope.data.provenance.activitySourceRecordCount == 1401
    assert envelope.data.provenance.nonPenaltyCenterBoundaryShotCount == 1
    assert envelope.data.provenance.centerBoundaryActivityPointCount == 35


def test_kane_full_activity_fixture_is_strict_contract() -> None:
    fixture = Path(__file__).parents[1] / "docs" / "fixtures" / "six_lane_shooting_corridor_v1" / "kane_2025_2026_league_scope7.json"
    envelope = SixLaneShootingCorridorEnvelope.model_validate(json.loads(fixture.read_text(encoding="utf-8")))
    assert envelope.data.totals.activityPoints == 1401
