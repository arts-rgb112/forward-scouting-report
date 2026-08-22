from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api_server.main import app
from api_server import service
from api_server.schemas import (
    FinalThirdEffectiveShotEnvelope, FinalThirdGoalMouthEnvelope, FinalThirdShot,
    FinalThirdShotEnvelope,
)
from scripts.audit_shotmap_coverage import audit_trajectories
from scripts.build_shotmap_points import normalize_shotmap


CLIENT = TestClient(app, raise_server_exceptions=False)


def _goal(*, x: float = 90, y: float = 50, xg: float | None = 0.2, xgot: float | None = 0.5) -> dict[str, object]:
    return {
        "x": x, "y": y, "outcome": "goal", "xg": xg, "xgot": xgot,
        "trajectory": {
            "schemaVersion": "shotmap-trajectory-v1", "endpointKind": "goal_mouth",
            "endX": 100, "endY": 50, "endZMeters": 1.22, "source": "fotmob",
        },
    }


def _blocked(*, xgot: float | None = None) -> dict[str, object]:
    return {"x": 70, "y": 10, "outcome": "blocked", "xg": 0, "xgot": xgot}


def _build(
    rows: list[dict[str, object]], *, mode: str = "league",
    competition: str = "all", league_name: str = "Premier League",
    heatmap_key: str = "194165:17:1",
    conversion_version: str = "goals-v1",
):
    player = SimpleNamespace(league=SimpleNamespace(name=league_name))
    service._build_final_third_shot_map_cached.cache_clear()
    try:
        with (
            patch("api_server.service.find_v2_player", return_value=player),
            patch("api_server.service.get_tactical_session_row", return_value={"heatmap_key": heatmap_key}),
            patch("api_server.service.get_shotmap_snapshot", return_value=(True, rows)),
        ):
            return service._build_final_third_shot_map_cached(
                194165, "2025/2026", mode, 8, competition, (1, 1), conversion_version,
            )
    finally:
        service._build_final_third_shot_map_cached.cache_clear()


def test_final_third_aggregates_fixed_zones_zero_null_quality_and_missing_xgot() -> None:
    payload = _build([_goal(), {**_goal(), "outcome": "on_target", "xgot": None}, _blocked()])
    assert payload is not None
    data = payload.data
    assert [zone.zoneId for zone in data.zones] == [
        *(f"depth6_lane{lane}" for lane in range(1, 6)),
        *(f"depth5_lane{lane}" for lane in range(1, 6)),
    ]
    central = next(zone for zone in data.zones if zone.zoneId == "depth6_lane3")
    assert (central.shotsTotal, central.goals, central.conversionRatePct) == (2, 1, 50)
    assert (central.qualityScore, central.qualityEligibleShots) == (0.3, 1)
    assert central.fieldStates.qualityScore.state == "partial"
    zero = next(zone for zone in data.zones if zone.zoneId == "depth6_lane1")
    assert (zero.shotsTotal, zero.goals, zero.conversionRatePct, zero.qualityScore, zero.qualityEligibleShots) == (0, 0, None, None, 0)
    assert zero.fieldStates.conversionRatePct.reason == "no_attempts_in_zone"
    assert zero.fieldStates.conversionRatePct.formulaVersion is None
    assert data.completeness == "partial"
    assert any(issue.zoneId == "depth6_lane3" and issue.field == "qualityScore" for issue in data.partialCoverage)


def test_effective_conversion_v2_counts_mutually_exclusive_goal_and_on_target_statuses() -> None:
    fixture = json.loads((
        Path(__file__).resolve().parents[1]
        / "docs" / "fixtures" / "final_third_shot_map_effective_v2" / "source_cases.json"
    ).read_text(encoding="utf-8"))
    payload = _build(fixture["rows"], conversion_version=fixture["conversionVersion"])
    assert isinstance(payload, FinalThirdEffectiveShotEnvelope)
    assert payload.schemaVersion == "2.0.0"
    assert payload.chartTaxonomyVersion == "final-third-shot-map-effective-v2"
    assert payload.data.conversionDefinition == fixture["conversionDefinition"]
    central = next(zone for zone in payload.data.zones if zone.zoneId == "depth6_lane3")
    # Four source events in the zone: one goal and one distinct on-target
    # outcome. They are exclusive canonical statuses, so the numerator is 2.
    expected = fixture["expect"]
    assert (central.shotsTotal, central.goals, central.effectiveShotCount, central.conversionRatePct) == (
        expected["shotsTotal"], expected["goals"], expected["effectiveShotCount"], expected["conversionRatePct"],
    )
    zero = next(zone for zone in payload.data.zones if zone.zoneId == "depth6_lane1")
    assert (zero.shotsTotal, zero.effectiveShotCount, zero.conversionRatePct) == (
        expected["zeroZone"]["shotsTotal"], expected["zeroZone"]["effectiveShotCount"], expected["zeroZone"]["conversionRatePct"],
    )
    assert zero.fieldStates.conversionRatePct.formulaVersion == (
        "effective-on-target-plus-goal-divided-by-shots-v2"
    )
    assert central.fieldStates.conversionRatePct.formulaVersion == (
        "effective-on-target-plus-goal-divided-by-shots-v2"
    )
    assert central.fieldStates.effectiveShotCount.formulaVersion == "status-goal-or-on-target-v2"


def test_goal_mouth_v3_returns_server_owned_front_two_xgot_minus_xg_caption() -> None:
    v3_fixture = json.loads((
        Path(__file__).resolve().parents[1]
        / "docs" / "fixtures" / "final_third_goal_mouth_v3" / "source_cases.json"
    ).read_text(encoding="utf-8"))
    fixture = json.loads((
        Path(__file__).resolve().parents[1]
        / "docs" / "fixtures" / "final_third_shot_map_effective_v2" / "source_cases.json"
    ).read_text(encoding="utf-8"))
    payload = _build(fixture["rows"], conversion_version=v3_fixture["conversionVersion"])
    assert isinstance(payload, FinalThirdGoalMouthEnvelope)
    assert payload.schemaVersion == "3.0.0"
    assert payload.chartTaxonomyVersion == "final-third-shot-map-goal-mouth-v3"
    quality = payload.data.shootingQuality
    expected = v3_fixture["shootingQuality"]["observed"]
    assert (quality.totalShotCount, quality.eligibleShotCount) == (
        expected["totalShotCount"], expected["eligibleShotCount"],
    )
    assert (quality.xgTotal, quality.xgotTotal, quality.xgotMinusXg) == (
        expected["xgTotal"], expected["xgotTotal"], expected["xgotMinusXg"],
    )
    assert (quality.state, quality.reason, quality.source) == (
        "observed", None, "player_season_shot_events",
    )


def test_goal_mouth_v3_keeps_missing_quality_partial_or_unavailable_without_zero_fill() -> None:
    partial = _build([_goal(), {**_goal(), "outcome": "on_target", "xgot": None}, _blocked()], conversion_version="goal-mouth-v3")
    assert isinstance(partial, FinalThirdGoalMouthEnvelope)
    quality = partial.data.shootingQuality
    assert (quality.totalShotCount, quality.eligibleShotCount) == (3, 1)
    assert (quality.xgTotal, quality.xgotTotal, quality.xgotMinusXg) == (0.2, 0.5, 0.3)
    assert quality.state == "partial"
    assert quality.reason == "xgot_or_xg_unavailable_for_2_front_two_shots"

    unavailable = _build([_blocked(xgot=None)], conversion_version="goal-mouth-v3")
    assert isinstance(unavailable, FinalThirdGoalMouthEnvelope)
    no_quality = unavailable.data.shootingQuality
    assert (no_quality.totalShotCount, no_quality.eligibleShotCount) == (1, 0)
    assert (no_quality.xgTotal, no_quality.xgotTotal, no_quality.xgotMinusXg) == (None, None, None)
    assert no_quality.state == "unavailable"


def test_canonical_source_fixture_exercises_math_and_endpoint_contract() -> None:
    fixture = json.loads((
        Path(__file__).resolve().parents[1]
        / "docs" / "fixtures" / "final_third_shot_map_v1" / "source_cases.json"
    ).read_text(encoding="utf-8"))
    payload = _build(fixture["rows"])
    assert payload is not None
    expected = fixture["expect"]
    assert [zone.zoneId for zone in payload.data.zones] == expected["zoneOrder"]
    central = next(zone for zone in payload.data.zones if zone.zoneId == "depth6_lane3")
    assert central.shotsTotal == expected["depth6_lane3"]["shotsTotal"]
    assert central.qualityScore == expected["depth6_lane3"]["qualityScore"]
    assert payload.data.shots[1].endpointReason == expected["blocked"]["endpointReason"]


def test_blocked_source_event_is_counted_but_never_goal_mouth_plotted() -> None:
    # A blocked event has no goal-mouth endpoint by definition, but that
    # expected absence is not a partial source failure when xG/xGOT itself is
    # complete.  The default helper deliberately leaves xGOT unavailable for
    # the separate quality-coverage test above.
    payload = _build([_blocked(xgot=0)])
    assert payload is not None
    shot = payload.data.shots[0]
    assert shot.status == "blocked" and shot.xg == 0
    assert shot.endpointAvailable is False
    assert (shot.goalMouthY, shot.goalMouthZ) == (None, None)
    assert shot.endpointReason == "blocked_has_no_goal_mouth_endpoint"
    assert payload.data.endpointUnavailableCount == 1
    zone = next(zone for zone in payload.data.zones if zone.zoneId == "depth5_lane1")
    assert (zone.shotsTotal, zone.goals, zone.conversionRatePct) == (1, 0, 0)
    assert payload.data.completeness == "complete"


def test_nonblocked_missing_endpoint_is_partial_not_inferred() -> None:
    source = _goal()
    source.pop("trajectory")
    payload = _build([source])
    assert payload is not None
    shot = payload.data.shots[0]
    assert shot.endpointAvailable is False
    assert (shot.goalMouthY, shot.goalMouthZ) == (None, None)
    assert shot.endpointReason == "goal_mouth_endpoint_unavailable_in_source"
    assert payload.data.completeness == "partial"
    assert payload.data.partialCoverage[0].shotId == shot.shotId


def test_provider_id_is_preserved_and_legacy_snapshot_identity_is_not_provider_id() -> None:
    provider = _goal()
    provider["sourceEventId"] = "fotmob-event-42"
    payload = _build([provider, _blocked()])
    assert payload is not None
    assert payload.data.shots[0].shotId == "fotmob-event-42"
    assert payload.data.shots[0].shotIdSource == "provider_event"
    assert payload.data.shots[1].shotIdSource == "snapshot_record"
    assert payload.data.shots[1].shotId.startswith("snapshot_record:194165:17:1:")


def test_new_etl_keeps_only_explicit_provider_source_identity() -> None:
    normalized = normalize_shotmap([{
        "id": 99, "x": 95, "y": 34, "eventType": "Goal",
        "expectedGoals": 0, "expectedGoalsOnTarget": 0,
        "goalCrossedY": 34, "goalCrossedZ": 0,
    }, {
        "x": 95, "y": 34, "eventType": "Goal",
        "goalCrossedY": 34, "goalCrossedZ": 0,
    }])
    assert normalized[0]["sourceEventId"] == "99"
    assert "sourceEventId" not in normalized[1]


def test_future_snapshot_identity_metadata_does_not_change_legacy_spatial_dto() -> None:
    source = _goal()
    source["sourceEventId"] = "provider-event-legacy-safe"
    with (
        patch("api_server.service.get_heatmap_points", return_value=[]),
        patch("api_server.service.get_shotmap_snapshot", return_value=(True, [source])),
    ):
        spatial = service._spatial_analysis(1, {"heatmap_key": "194165:17:1"})
    assert spatial.shotmapPointCount == 1
    assert "sourceEventId" not in spatial.shotmapPoints[0].model_dump()


def test_final_third_strict_model_rejects_extra_fields_and_inferred_endpoint() -> None:
    with pytest.raises(ValidationError):
        FinalThirdShot.model_validate({
            "shotId": "x", "zoneId": "depth6_lane3", "pitchX": 90, "pitchY": 50,
            "xg": 0, "xgot": None, "status": "blocked", "endpointAvailable": False,
            "goalMouthY": 0, "goalMouthZ": None,
            "endpointReason": "blocked_has_no_goal_mouth_endpoint", "extra": True,
        })


def test_endpoint_context_front2_only_and_cors_boundaries() -> None:
    base = "/api/v2/players/194165/final-third-shot-map"
    front3 = CLIENT.get(base, params={"season": "2025/2026", "mode": "league", "scope": 8, "competition": "all", "depthBand": "front3"})
    assert front3.status_code == 422
    invalid_league_competition = CLIENT.get(base, params={"season": "2025/2026", "mode": "league", "scope": 8, "competition": "ucl"})
    assert invalid_league_competition.status_code == 422
    europe_with_scope = CLIENT.get(base, params={"season": "2025/2026", "mode": "europe", "scope": 8, "competition": "ucl"})
    assert europe_with_scope.status_code == 422
    europe_without_scope = CLIENT.get(base, params={"season": "2025/2026", "mode": "europe", "competition": "ucl"})
    assert europe_without_scope.status_code == 200
    assert FinalThirdShotEnvelope.model_validate(europe_without_scope.json()).context.scope is None
    response = CLIENT.get(base, params={"season": "2025/2026", "mode": "league", "scope": 8, "competition": "all"})
    assert response.status_code == 200
    payload = FinalThirdShotEnvelope.model_validate(response.json())
    assert payload.context.competition is None and payload.context.scope == 8
    assert "effectiveShotCount" not in response.json()["data"]["zones"][0]
    effective = CLIENT.get(base, params={
        "season": "2025/2026", "mode": "league", "scope": 8,
        "competition": "all", "conversionVersion": "effective-shot-v2",
    })
    assert effective.status_code == 200
    effective_payload = FinalThirdEffectiveShotEnvelope.model_validate(effective.json())
    assert effective_payload.data.conversionDefinition == "effective-on-target-plus-goal-divided-by-shots-v2"
    assert all(zone.effectiveShotCount is not None for zone in effective_payload.data.zones)
    goal_mouth = CLIENT.get(base, params={
        "season": "2025/2026", "mode": "league", "scope": 8,
        "competition": "all", "conversionVersion": "goal-mouth-v3",
    })
    assert goal_mouth.status_code == 200
    goal_mouth_payload = FinalThirdGoalMouthEnvelope.model_validate(goal_mouth.json())
    assert goal_mouth_payload.data.shootingQuality.formulaVersion == "sum-xgot-minus-sum-xg-v1"
    invalid_conversion = CLIENT.get(base, params={
        "season": "2025/2026", "mode": "league", "scope": 8,
        "competition": "all", "conversionVersion": "client-derived-v0",
    })
    assert invalid_conversion.status_code == 422
    assert response.headers["cache-control"].startswith("public")
    hostile = CLIENT.get(base, params={"season": "2025/2026", "mode": "league", "scope": 8, "competition": "all"}, headers={"Origin": "https://hostile.example"})
    assert hostile.status_code == 200
    assert "access-control-allow-origin" not in hostile.headers
    preview = "https://forward-scouting-report-6dn7-pr-199-messiflick.vercel.app"
    allowed = CLIENT.options(base, headers={"Origin": preview, "Access-Control-Request-Method": "GET"})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == preview


def test_europe_context_uses_exact_competition_snapshot_not_domestic_fallback() -> None:
    payload = _build(
        [_goal()], mode="europe", competition="ucl",
        league_name="Champions League", heatmap_key="194165:7:76953",
    )
    assert payload is not None
    assert payload.context.scope is None and payload.context.competition == "ucl"
    assert payload.data.available is True
    assert payload.data.shots[0].zoneId == "depth6_lane3"


def test_europe_all_unions_exact_uefa_snapshots_and_marks_missing_source_partial() -> None:
    player = SimpleNamespace(league=SimpleNamespace(name="Champions League"))
    sessions = {
        "Champions League": {"heatmap_key": "194165:7:76953"},
        "Europa League": {"heatmap_key": "194165:679:76984"},
        "Europa Conference League": None,
    }
    rows = {
        "194165:7:76953": [_goal(x=90, y=50)],
        "194165:679:76984": [{**_goal(x=80, y=50), "outcome": "on_target"}],
    }

    def source_snapshot(key: str | None, _season: str):
        return (key in rows, rows.get(key or "", []))

    service._build_final_third_shot_map_cached.cache_clear()
    try:
        with (
            patch("api_server.service.find_v2_player", return_value=player),
            patch("api_server.service.get_tactical_session_row", side_effect=lambda _id, name, _season: sessions[name]),
            patch("api_server.service.get_shotmap_snapshot", side_effect=source_snapshot),
        ):
            payload = service._build_final_third_shot_map_cached(
                194165, "2025/2026", "europe", 8, "all", (1, 1),
            )
    finally:
        service._build_final_third_shot_map_cached.cache_clear()
    assert payload is not None
    assert payload.context.scope is None and payload.context.competition == "all"
    assert payload.data.available is True and payload.data.completeness == "complete"
    assert len(payload.data.shots) == 2
    assert {shot.pitchX for shot in payload.data.shots} == {80, 90}

    # A selected tournament with a missing snapshot makes an all-cups union
    # partial rather than falling back to its first available competition.
    sessions["Europa Conference League"] = {"heatmap_key": "194165:17015:76960"}
    service._build_final_third_shot_map_cached.cache_clear()
    try:
        with (
            patch("api_server.service.find_v2_player", return_value=player),
            patch("api_server.service.get_tactical_session_row", side_effect=lambda _id, name, _season: sessions[name]),
            patch("api_server.service.get_shotmap_snapshot", side_effect=source_snapshot),
        ):
            partial = service._build_final_third_shot_map_cached(
                194165, "2025/2026", "europe", 8, "all", (1, 1),
            )
    finally:
        service._build_final_third_shot_map_cached.cache_clear()
    assert partial is not None and partial.data.available is True
    assert partial.data.completeness == "partial"
    assert len(partial.data.partialCoverage) == 30
    assert {issue.field for issue in partial.data.partialCoverage} == {
        "volume", "conversionRatePct", "qualityScore",
    }
    assert all(
        zone.state == "partial"
        and zone.fieldStates.volume.state == "partial"
        and zone.fieldStates.conversionRatePct.state == "partial"
        and zone.fieldStates.qualityScore.state == "partial"
        and zone.reason and zone.reason.startswith("competition_snapshot_unavailable:")
        for zone in partial.data.zones
    )


def test_europe_context_without_its_own_snapshot_stays_unavailable() -> None:
    player = SimpleNamespace(league=SimpleNamespace(name="Champions League"))
    service._build_final_third_shot_map_cached.cache_clear()
    try:
        with (
            patch("api_server.service.find_v2_player", return_value=player),
            patch("api_server.service.get_tactical_session_row", return_value={"heatmap_key": "194165:7:76953"}),
            patch("api_server.service.get_shotmap_snapshot", return_value=(False, [])),
        ):
            payload = service._build_final_third_shot_map_cached(194165, "2025/2026", "europe", 8, "ucl", (1, 1))
    finally:
        service._build_final_third_shot_map_cached.cache_clear()
    assert payload is not None
    assert payload.context.scope is None and payload.context.competition == "ucl"
    assert payload.data.available is False
    assert payload.data.completeness == "unavailable"
    assert payload.data.reason == service.FINAL_THIRD_COMPETITION_UNAVAILABLE_REASON
    assert all(zone.shotsTotal is None for zone in payload.data.zones)


def test_effective_conversion_v2_preserves_unavailable_source_not_zero() -> None:
    player = SimpleNamespace(league=SimpleNamespace(name="Champions League"))
    service._build_final_third_shot_map_cached.cache_clear()
    try:
        with (
            patch("api_server.service.find_v2_player", return_value=player),
            patch("api_server.service.get_tactical_session_row", return_value={"heatmap_key": "194165:7:76953"}),
            patch("api_server.service.get_shotmap_snapshot", return_value=(False, [])),
        ):
            payload = service._build_final_third_shot_map_cached(
                194165, "2025/2026", "europe", 8, "ucl", (1, 1), "effective-shot-v2",
            )
    finally:
        service._build_final_third_shot_map_cached.cache_clear()
    assert isinstance(payload, FinalThirdEffectiveShotEnvelope)
    assert payload.data.available is False
    assert all(
        zone.shotsTotal is None
        and zone.effectiveShotCount is None
        and zone.fieldStates.effectiveShotCount.state == "unavailable"
        for zone in payload.data.zones
    )


def test_openapi_exposes_strict_final_third_contract() -> None:
    schema = CLIENT.get("/openapi.json").json()
    contract = schema["components"]["schemas"]["FinalThirdShotEnvelope"]
    effective_contract = schema["components"]["schemas"]["FinalThirdEffectiveShotEnvelope"]
    goal_mouth_contract = schema["components"]["schemas"]["FinalThirdGoalMouthEnvelope"]
    assert contract["additionalProperties"] is False
    assert effective_contract["additionalProperties"] is False
    assert goal_mouth_contract["additionalProperties"] is False
    assert "/api/v2/players/{player_id}/final-third-shot-map" in schema["paths"]
    assert schema["components"]["schemas"]["FinalThirdShot"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["FinalThirdEffectiveShotZone"]["additionalProperties"] is False
    assert schema["components"]["schemas"]["FinalThirdEffectiveShotZoneFieldStates"]["additionalProperties"] is False
    parameters = schema["paths"]["/api/v2/players/{player_id}/final-third-shot-map"]["get"]["parameters"]
    conversion = next(parameter for parameter in parameters if parameter["name"] == "conversionVersion")
    assert conversion["schema"]["enum"] == ["goals-v1", "effective-shot-v2", "goal-mouth-v3"]


def test_trajectory_audit_accepts_additive_source_event_identity() -> None:
    record = _goal()
    record["sourceEventId"] = "fotmob-event-99"
    with patch(
        "scripts.audit_shotmap_coverage.load_shotmap_points",
        return_value={"audit-final-third-key": [record]},
    ):
        total, enriched, invalid, kinds, missing = audit_trajectories()
    assert (total, enriched, invalid) == (1, 1, 0)
    assert kinds["goal_mouth"] == 1
    assert not missing
