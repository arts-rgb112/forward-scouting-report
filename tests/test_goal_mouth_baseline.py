from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api_server import service
from api_server.main import app
from api_server.schemas import GoalMouthBaselineEnvelope


CLIENT = TestClient(app, raise_server_exceptions=False)
FIXTURE = json.loads((
    Path(__file__).resolve().parents[1] / "docs" / "fixtures" / "goal_mouth_baseline_v1" / "source_cases.json"
).read_text(encoding="utf-8"))


def _raw(*, outcome: str = "goal", end_y: float = 50, end_z: float = 1.22) -> dict[str, object]:
    return {
        "x": 90, "y": 50, "outcome": outcome, "xg": 0.2, "xgot": 0.4,
        "trajectory": {
            "schemaVersion": "shotmap-trajectory-v1", "endpointKind": "goal_mouth",
            "endX": 100, "endY": end_y, "endZMeters": end_z, "source": "fotmob",
        },
    }


def _baseline_from_rows(rows: list[object]):
    service._build_goal_mouth_baseline_cached.cache_clear()
    try:
        with (
            patch("api_server.service.goal_mouth_baseline_snapshot_revision", return_value=(("one.json", 1, 1),)),
            patch("api_server.service._goal_mouth_baseline_shards", return_value=(Path("one.json"),)),
            patch("api_server.service.Path.read_text", return_value=json.dumps({"key": rows})),
        ):
            return service.build_goal_mouth_baseline()
    finally:
        service._build_goal_mouth_baseline_cached.cache_clear()


def test_endpoint_contract_openapi_query_rejection_cache_and_cors() -> None:
    response = CLIENT.get("/api/v2/goal-mouth-baseline")
    assert response.status_code == 200
    assert response.json()["data"]["placementSummary"] is None
    assert response.json()["data"]["hexFrequency"] is None
    assert response.headers["cache-control"] == "public, max-age=300, stale-while-revalidate=3600"
    assert CLIENT.get("/api/v2/goal-mouth-baseline?unexpected=1").status_code == 422
    schema = CLIENT.get("/openapi.json").json()
    operation = schema["paths"]["/api/v2/goal-mouth-baseline"]["get"]
    assert {item["name"] for item in operation["parameters"]} == {
        "playerId", "season", "mode", "scope", "competition", "includePenalties",
    }
    assert schema["components"]["schemas"]["GoalMouthBaselineEnvelope"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["GoalMouthBaselineCell"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["GoalMouthBaselineData"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["GoalMouthBaselineGrid"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["GoalMouthBaselineProvenance"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["GoalMouthBaselineConfidenceInterval"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["GoalMouthPlacementSummary"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["PitchHexFrequency"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["PitchHexFrequencyCell"]["additionalProperties"] is False
    preview = "https://forward-scouting-report-6dn7-pr-299-messiflick.vercel.app"
    allowed = CLIENT.options("/api/v2/goal-mouth-baseline", headers={
        "Origin": preview, "Access-Control-Request-Method": "GET",
    })
    assert allowed.status_code == 200 and allowed.headers["access-control-allow-origin"] == preview
    hostile = CLIENT.get("/api/v2/goal-mouth-baseline", headers={"Origin": "https://hostile.example"})
    assert hostile.status_code == 200 and "access-control-allow-origin" not in hostile.headers
    hostile_preflight = CLIENT.options("/api/v2/goal-mouth-baseline", headers={
        "Origin": "https://forward-scouting-report-6dn7-pr-299-lookalike.vercel.app",
        "Access-Control-Request-Method": "GET",
    })
    assert hostile_preflight.status_code == 400
    assert "access-control-allow-origin" not in hostile_preflight.headers


def test_player_context_additive_summary_hex_frequency_and_penalty_toggle() -> None:
    query = (
        "playerId=194165&season=2025%2F2026&mode=league&scope=7"
        "&competition=all&includePenalties=true"
    )
    included = CLIENT.get(f"/api/v2/goal-mouth-baseline?{query}")
    assert included.status_code == 200
    included_data = included.json()["data"]
    assert included_data["placementSummary"] == {
        "onFrameShots": 67,
        "placementExpectedGoals": 23.5516,
        "actualGoals": 36,
        "delta": 12.4484,
        "excludesPenalties": False,
    }
    frequency = included_data["hexFrequency"]
    assert frequency["definitionVersion"] == "hex-r2-crop-v2"
    assert frequency["excludesPenalties"] is True
    assert frequency["outOfCropShots"] == 1
    assert sum(cell["shots"] for cell in frequency["cells"]) == 107
    assert all(cell["shots"] > 0 for cell in frequency["cells"])

    excluded = CLIENT.get(f"/api/v2/goal-mouth-baseline?{query[:-4]}false")
    assert excluded.status_code == 200
    excluded_data = excluded.json()["data"]
    assert excluded_data["placementSummary"] == {
        "onFrameShots": 57,
        "placementExpectedGoals": 18.7977,
        "actualGoals": 26,
        "delta": 7.2023,
        "excludesPenalties": True,
    }
    assert excluded_data["hexFrequency"] == frequency


def test_player_context_query_is_complete_and_strict() -> None:
    assert CLIENT.get("/api/v2/goal-mouth-baseline?playerId=194165").status_code == 422
    assert CLIENT.get("/api/v2/goal-mouth-baseline?includePenalties=false").status_code == 422
    assert CLIENT.get(
        "/api/v2/goal-mouth-baseline?playerId=194165&season=2025%2F2026"
        "&mode=league&competition=all"
    ).status_code == 422


def test_fixed_grid_row_major_bounds_and_strict_model() -> None:
    payload = _baseline_from_rows([])
    cells = payload.data.cells
    assert len(cells) == 50
    assert [(cell.row, cell.column) for cell in cells] == [
        (row, column) for row in range(1, 6) for column in range(1, 11)
    ]
    assert (cells[0].cellId, cells[0].yMin, cells[0].yMax, cells[0].zMin, cells[0].zMax) == (
        "row1_column1", 0.0, 0.1, 0.0, 0.2,
    )
    assert (cells[-1].cellId, cells[-1].yMin, cells[-1].yMax, cells[-1].zMin, cells[-1].zMax) == (
        "row5_column10", 0.9, 1.0, 0.8, 1.0,
    )
    with pytest.raises(ValidationError):
        GoalMouthBaselineEnvelope.model_validate({"data": {"available": False, "extra": True}})


def test_edges_observed_zero_unavailable_and_exclusions_without_clamping() -> None:
    left_bottom = _raw(end_y=50 - service.GOAL_MOUTH_WIDTH_PITCH_PCT / 2, end_z=0)
    right_top = _raw(outcome="on_target", end_y=50 + service.GOAL_MOUTH_WIDTH_PITCH_PCT / 2, end_z=2.44)
    off_frame = _raw(end_y=50 + service.GOAL_MOUTH_WIDTH_PITCH_PCT / 2 + 0.001)
    blocked = {"x": 90, "y": 50, "outcome": "blocked", "xg": 0.2, "xgot": 0.4}
    missing = {"x": 90, "y": 50, "outcome": "goal", "xg": 0.2, "xgot": 0.4}
    payload = _baseline_from_rows([left_bottom] * 500 + [right_top] * 500 + [off_frame, blocked, missing])
    first, last = payload.data.cells[0], payload.data.cells[-1]
    assert (first.state, first.shots, first.goals, first.goalRatePct, first.reason, first.lowSample) == (
        "observed", 500, 500, 100.0, None, False,
    )
    assert (last.state, last.shots, last.goals, last.goalRatePct, last.lowSample) == (
        "observed", 500, 0, 0.0, False,
    )
    assert last.confidenceIntervalPct is not None
    assert all(cell.state == "low_sample" for cell in payload.data.cells[1:-1])
    assert all(cell.reason == "insufficient_baseline_sample" for cell in payload.data.cells[1:-1])
    assert payload.data.provenance.totalShots == 1000
    assert payload.data.provenance.totalGoals == 500
    # A defensive finite check remains necessary even though the strict source
    # DTO normally rejects non-finite values before this transform runs.
    with patch(
        "api_server.service._final_third_endpoint",
        return_value=(True, float("nan"), 0.5, None, False),
    ):
        nonfinite = _baseline_from_rows([_raw()])
    assert nonfinite.data.provenance.totalShots == 0


def test_source_audit_is_closed_to_five_shards_and_matches_fixture() -> None:
    service._build_goal_mouth_baseline_cached.cache_clear()
    try:
        with patch("api_server.service.get_shotmap_snapshot", side_effect=AssertionError("baseline must not use merged snapshot loader")):
            payload = service.build_goal_mouth_baseline()
    finally:
        service._build_goal_mouth_baseline_cached.cache_clear()
    expected = FIXTURE["audit"]
    assert payload.data.available is True
    assert payload.data.provenance.totalShots == expected["eligibleShots"]
    assert payload.data.provenance.totalGoals == expected["goals"]
    assert payload.data.provenance.totalShots == sum(cell.shots or 0 for cell in payload.data.cells)
    assert payload.data.provenance.totalGoals == sum(cell.goals or 0 for cell in payload.data.cells)
    assert len(service._goal_mouth_baseline_shards()) == 5
    assert [path.name for path in service._goal_mouth_baseline_shards()] == [
        f"tactical_shotmap_points_{season.replace('/', '_')}.json"
        for season in service.GOAL_MOUTH_BASELINE_SEASONS
    ]
    assert [cell.cellId for cell in payload.data.cells if cell.state == "unavailable"] == expected["unavailableCells"]
    assert sum(cell.state == "observed" for cell in payload.data.cells) == expected["observedCells"]
    assert [cell.cellId for cell in payload.data.cells if cell.state == "low_sample"] == expected["lowSampleCells"]
    assert all(
        cell.state == "observed" and not cell.lowSample and cell.shots is not None
        and cell.shots >= service.GOAL_MOUTH_BASELINE_MINIMUM_CELL_SAMPLE
        and cell.reason is None and cell.confidenceIntervalPct is not None
        for cell in payload.data.cells
    )


def test_cache_revision_missing_shard_and_invalid_record_contract() -> None:
    revision = (("one.json", 1, 1),)
    service._build_goal_mouth_baseline_cached.cache_clear()
    try:
        with patch("api_server.service._goal_mouth_baseline_shards", return_value=(Path("one.json"),)), patch(
            "api_server.service.Path.read_text", return_value=json.dumps({"key": []})
        ) as read_text:
            service._build_goal_mouth_baseline_cached(revision)
            service._build_goal_mouth_baseline_cached(revision)
            service._build_goal_mouth_baseline_cached((("one.json", 2, 1),))
            assert read_text.call_count == 2
        missing = service._build_goal_mouth_baseline_cached(None)
        assert missing.data.available is False and missing.data.reason == "required_static_snapshot_missing"
        assert all(
            cell.shots is None and cell.confidenceIntervalPct is None and not cell.lowSample
            and cell.reason == missing.data.reason
            for cell in missing.data.cells
        )
        with patch("api_server.service._goal_mouth_baseline_shards", return_value=(Path("one.json"),)), patch(
            "api_server.service.Path.read_text", return_value=json.dumps({"key": [{"bad": True}]})
        ):
            with pytest.raises(service.ShotmapContractViolation):
                service._build_goal_mouth_baseline_cached((("one.json", 3, 1),))
    finally:
        service._build_goal_mouth_baseline_cached.cache_clear()


def test_snapshot_stat_permission_error_is_not_reported_as_unavailable() -> None:
    service._build_goal_mouth_baseline_cached.cache_clear()
    try:
        with patch("api_server.service.Path.stat", side_effect=PermissionError("denied")):
            with pytest.raises(service.ShotmapContractViolation):
                service.build_goal_mouth_baseline()
    finally:
        service._build_goal_mouth_baseline_cached.cache_clear()


def test_low_sample_preserves_observed_counts_rate_and_confidence_interval() -> None:
    payload = _baseline_from_rows([_raw()] * 149)
    cell = next(item for item in payload.data.cells if item.shots == 149)
    assert (cell.cellId, cell.state, cell.lowSample, cell.shots, cell.goals, cell.goalRatePct) == (
        "row3_column6", "low_sample", True, 149, 149, 100.0,
    )
    assert cell.reason == "insufficient_baseline_sample"
    assert cell.confidenceIntervalPct is not None
    assert cell.confidenceIntervalPct.method == "wilson-score-v1"
    assert 0 <= cell.confidenceIntervalPct.lower <= cell.confidenceIntervalPct.upper <= 100


def test_zero_shot_cell_is_low_sample_not_unavailable() -> None:
    payload = _baseline_from_rows([])
    cell = payload.data.cells[0]
    assert (cell.state, cell.lowSample, cell.shots, cell.goals, cell.goalRatePct, cell.confidenceIntervalPct) == (
        "low_sample", True, 0, 0, None, None,
    )
    assert cell.reason == "insufficient_baseline_sample"


def test_wilson_confidence_interval_known_values() -> None:
    rate = service._goal_mouth_baseline_confidence_interval(92, 149)
    zero = service._goal_mouth_baseline_confidence_interval(0, 149)
    assert rate is not None
    assert rate.lower == pytest.approx(53.739121471172304)
    assert rate.upper == pytest.approx(69.1604244177872)
    assert zero is not None
    assert zero.lower == pytest.approx(0.0, abs=1e-12)
    assert zero.upper == pytest.approx(2.513361787000954)


def test_strict_model_rejects_shifted_geometry_and_tampered_totals() -> None:
    valid = _baseline_from_rows([_raw()] * 150).model_dump(mode="json")
    valid["data"]["cells"][0]["yMax"] = 0.11
    with pytest.raises(ValidationError):
        GoalMouthBaselineEnvelope.model_validate(valid)
    valid = _baseline_from_rows([_raw()] * 150).model_dump(mode="json")
    valid["data"]["provenance"]["totalGoals"] = 151
    with pytest.raises(ValidationError):
        GoalMouthBaselineEnvelope.model_validate(valid)
