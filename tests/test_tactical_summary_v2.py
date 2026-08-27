from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api_server import service
from api_server.main import app
from api_server.schemas import TacticalSummaryV2Envelope


CLIENT = TestClient(app)
FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "tactical_summary_v2"


def _core_payload() -> dict[str, object]:
    return {
        "definitionVersion": "fixed-n60-r20-v2", "targetDensityPct": 50,
        "achievedDensityPct": 45.0, "coreAreaPct": 22.0,
        "densityThreshold": 0.2, "thresholdOfPeak": 0.3,
        "gridColumns": 32, "gridRows": 22, "formulaVersion": "fixed-n60-r20-v2",
        "ccaAreaPct": 22.0, "standardizedTarget": 22.0,
        "quantizationDelta": 0.0, "containedMassPct": 45.0,
        "validPointCount": 180, "lowSample": False,
    }


def _fake_frame(position: str = "Striker") -> tuple[list[dict[str, object]], tuple[SimpleNamespace, ...], str, dict[int, dict[str, object]]]:
    records = [
        {"player_id": "1", "position": position, "league_name": "Premier League"},
        {"player_id": "2", "position": position, "league_name": "Premier League"},
        {"player_id": "3", "position": "forward", "league_name": "Premier League"},
    ]
    players = tuple(SimpleNamespace(id=index, position=record["position"]) for index, record in enumerate(records, start=1))
    return records, players, "snapshot", {}


def _static(record: dict[str, object], _season: str) -> dict[str, float]:
    player_id = str(record["player_id"])
    values = {
        "1": (20.0, 22.0, 10.0),
        "2": (10.0, 18.0, 8.0),
        "3": (99.0, 99.0, 99.0),
    }[player_id]
    return {
        "in_box_ratio": values[0], "cca_area_pct": values[1],
        "activity_spread_x": values[1], "activity_spread_y": values[2],
        "activity_valid_point_count": 180,
        **{f"lane_{lane}_ratio": values[0] + lane for lane in range(1, 6)},
    }


def _static_with_cca_gap(record: dict[str, object], season: str) -> dict[str, float]:
    """Player 2 keeps coordinate ranges while its independent CCA is absent."""
    result = _static(record, season)
    if str(record["player_id"]) == "2":
        result.pop("cca_area_pct")
    return result


def test_canonical_fixtures_are_strict_and_extra_fields_fail() -> None:
    for name in ("observed.json", "low_sample.json", "unavailable.json"):
        payload = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
        TacticalSummaryV2Envelope.model_validate(payload)
    payload["data"]["activityRange"]["unexpected"] = True
    with pytest.raises(ValidationError):
        TacticalSummaryV2Envelope.model_validate(payload)
    payload = json.loads((FIXTURES / "observed.json").read_text(encoding="utf-8"))
    payload["unexpected"] = True
    with pytest.raises(ValidationError):
        TacticalSummaryV2Envelope.model_validate(payload)


def test_same_context_position_cohort_never_merges_forward_or_coerces_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, int, str]] = []

    def frame(season: str, mode: str, scope: int, competition: str):
        calls.append((season, mode, scope, competition))
        return _fake_frame()

    monkeypatch.setattr(service, "_v2_frame", frame)
    monkeypatch.setattr(service, "_tactical_summary_v2_static_record", _static)
    monkeypatch.setattr(service, "get_tactical_ratio_for_session", lambda *_args: {"continuous_core": _core_payload()})
    service.build_tactical_summary_v2.cache_clear()
    result = service.build_tactical_summary_v2(1, "2025/2026", "league", 3, "all")
    service.build_tactical_summary_v2.cache_clear()

    assert result is not None
    assert calls == [("2025/2026", "league", 3, "all")]
    assert result.sourceContext.scope == 3
    assert result.cohortPopulation == 2
    assert result.activityRange.frontBackActivityRange.population == 2
    assert result.activityRange.frontBackActivityRange.baselineMedian == 20.0

    service.build_tactical_summary_v2.cache_clear()
    europe = service.build_tactical_summary_v2(1, "2025/2026", "europe", 8, "ucl")
    service.build_tactical_summary_v2.cache_clear()
    assert europe is not None
    assert calls[-1] == ("2025/2026", "europe", 8, "ucl")
    assert europe.sourceContext.scope is None and europe.sourceContext.competition == "ucl"
    assert europe.cohortKey.scope is None and europe.cohortKey.competition == "ucl"


def test_low_sample_preserves_values_and_invalid_position_is_unavailable_without_global_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(service, "_v2_frame", lambda *_args: _fake_frame())
    monkeypatch.setattr(service, "_tactical_summary_v2_static_record", _static)
    monkeypatch.setattr(service, "get_tactical_ratio_for_session", lambda *_args: {"continuous_core": _core_payload()})
    service.build_tactical_summary_v2.cache_clear()
    low = service.build_tactical_summary_v2(1, "2025/2026", "league", 8, "all")
    service.build_tactical_summary_v2.cache_clear()
    assert low is not None and low.lowSample is True
    assert low.activityRange.frontBackActivityRange.cohortState == "low_sample"
    assert low.activityRange.frontBackActivityRange.value == 22.0

    monkeypatch.setattr(service, "_v2_frame", lambda *_args: _fake_frame("Coach"))
    service.build_tactical_summary_v2.cache_clear()
    unavailable = service.build_tactical_summary_v2(1, "2025/2026", "league", 8, "all")
    service.build_tactical_summary_v2.cache_clear()
    assert unavailable is not None
    assert unavailable.cohortPopulation == 0
    assert unavailable.activityRange.frontBackActivityRange.cohortState == "unavailable"
    assert unavailable.activityRange.frontBackActivityRange.reason == "position_label_not_player_role"
    assert unavailable.activityRange.roleLabel == "unavailable"


def test_metric_specific_eligibility_keeps_activity_when_cca_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(service, "_v2_frame", lambda *_args: _fake_frame())
    monkeypatch.setattr(service, "_tactical_summary_v2_static_record", _static_with_cca_gap)
    monkeypatch.setattr(service, "get_tactical_ratio_for_session", lambda *_args: {"continuous_core": _core_payload()})
    service.build_tactical_summary_v2.cache_clear()
    result = service.build_tactical_summary_v2(1, "2025/2026", "league", 8, "all")
    service.build_tactical_summary_v2.cache_clear()

    assert result is not None
    front_back = result.activityRange.frontBackActivityRange
    assert front_back.population == 2
    assert front_back.provenance.framePopulation == 2
    assert front_back.provenance.excludedPopulation == 0
    assert front_back.provenance.exclusionReasonCounts == {}
    assert result.activityCore.population == 1
    assert result.activityCore.provenance.framePopulation == 2
    assert result.activityCore.provenance.excludedPopulation == 1
    assert result.activityCore.provenance.exclusionReasonCounts == {"metric_value_missing": 1}


def test_low_coordinate_activity_subject_is_visible_but_excluded_from_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    def static(record: dict[str, object], season: str) -> dict[str, float]:
        result = _static(record, season)
        if str(record["player_id"]) == "2":
            result["activity_valid_point_count"] = 59
        return result

    monkeypatch.setattr(service, "_v2_frame", lambda *_args: _fake_frame())
    monkeypatch.setattr(service, "_tactical_summary_v2_static_record", static)
    def core_for(player_id: int, *_args: object) -> dict[str, object]:
        core = _core_payload()
        if player_id == 2:
            core.update({"ccaAreaPct": 18.0, "coreAreaPct": 18.0, "standardizedTarget": 18.0})
        return {"continuous_core": core}
    monkeypatch.setattr(service, "get_tactical_ratio_for_session", core_for)
    service.build_tactical_summary_v2.cache_clear()
    subject = service.build_tactical_summary_v2(2, "2025/2026", "league", 8, "all")
    service.build_tactical_summary_v2.cache_clear()
    boundary = service.build_tactical_summary_v2(1, "2025/2026", "league", 8, "all")
    service.build_tactical_summary_v2.cache_clear()

    assert subject is not None and boundary is not None
    subject_range = subject.activityRange.frontBackActivityRange
    assert subject_range.value == 18.0
    assert subject_range.cohortState == "low_sample"
    assert subject_range.reason == "subject_valid_coordinates_below_minimum"
    assert subject_range.population == 1
    assert subject_range.provenance.minimumBaselineCoordinateCount == 60
    assert subject_range.provenance.subjectValidCoordinateCount == 59
    assert subject_range.provenance.exclusionReasonCounts == {"insufficient_valid_coordinates": 1}
    assert subject.activityCore.population == 2  # CCA remains independently eligible.
    assert boundary.activityRange.frontBackActivityRange.population == 1  # n=180 remains included.


def test_real_kane_lewis_potter_and_toornstra_axes_use_stored_coordinate_ranges() -> None:
    cases = (
        (194165, "2025/2026", "종적 왕복형", 22.6447, 21.3076),
        (1010426, "2025/2026", "전방위 활동형", 27.1375, 25.6623),
        (188557, "2023/2024", "전방위 활동형", 20.8514, 26.6107),
    )
    for player_id, season, role, x_value, y_value in cases:
        service.build_tactical_summary_v2.cache_clear()
        result = service.build_tactical_summary_v2(player_id, season, "league", 8, "all")
        assert result is not None
        ranges = result.activityRange
        assert ranges.roleLabel == role
        assert ranges.frontBackActivityRange.value == x_value
        assert ranges.leftRightActivityRange.value == y_value
        assert ranges.frontBackActivityRange.provenance.coordinateSystem == "normalized_pitch_0_100"
        assert "거리" in result.disclosure and "활동량" not in result.disclosure


def test_real_kane_scope_changes_population_and_percentile() -> None:
    service.build_tactical_summary_v2.cache_clear()
    scope7 = service.build_tactical_summary_v2(194165, "2025/2026", "league", 7, "all")
    service.build_tactical_summary_v2.cache_clear()
    scope8 = service.build_tactical_summary_v2(194165, "2025/2026", "league", 8, "all")
    service.build_tactical_summary_v2.cache_clear()

    assert scope7 is not None and scope8 is not None
    scope7_range = scope7.activityRange.frontBackActivityRange
    scope8_range = scope8.activityRange.frontBackActivityRange
    assert scope7_range.value == pytest.approx(22.6447, abs=0.01)
    assert scope7.activityRange.leftRightActivityRange.value == pytest.approx(21.3076, abs=0.01)
    assert scope7.activityRange.roleLabel == "종적 왕복형"
    assert scope7_range.population != scope8_range.population
    assert scope7_range.percentileScore != scope8_range.percentileScore


def test_v2_endpoint_openapi_context_validation_cors_and_v1_compatibility() -> None:
    params = {"season": "2025/2026", "mode": "league", "scope": "8", "competition": "all"}
    v1_before = CLIENT.get("/api/v2/players/194165/tactical-summary", params=params).json()
    response = CLIENT.get(
        "/api/v2/players/194165/tactical-summary-v2", params=params,
        headers={"Origin": "https://forward-scouting-report-6dn7-tau.vercel.app"},
    )
    v1_after = CLIENT.get("/api/v2/players/194165/tactical-summary", params=params).json()
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://forward-scouting-report-6dn7-tau.vercel.app"
    assert response.json()["tacticalSummaryVersion"] == "tactical-summary-v2"
    assert response.json()["data"]["continuousCoreProvenance"]["ccaAreaPct"] == response.json()["data"]["activityCore"]["value"]
    assert v1_after == v1_before
    hostile = CLIENT.get(
        "/api/v2/players/194165/tactical-summary-v2", params=params,
        headers={"Origin": "https://hostile.example"},
    )
    assert hostile.status_code == 200
    assert "access-control-allow-origin" not in hostile.headers
    europe = CLIENT.get(
        "/api/v2/players/194165/tactical-summary-v2",
        params={"season": "2025/2026", "mode": "europe", "scope": "8", "competition": "ucl"},
    )
    assert europe.status_code == 422
    schema = CLIENT.get("/openapi.json").json()
    assert "/api/v2/players/{playerId}/tactical-summary-v2" in schema["paths"]
    assert "TacticalSummaryV2Envelope" in schema["components"]["schemas"]
