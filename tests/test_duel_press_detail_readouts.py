"""Focused contract coverage for the additive duel-press detail readout."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from api_server import main as api_main
from api_server import service
from api_server.main import app
from api_server.schemas import (
    DuelPressDetailReadoutEnvelope, DuelPressDetailReadoutV2Envelope,
    DuelPressPlayerEnvelope, DuelPressV2LeaderboardPageEnvelope,
    DuelPressV2PlayerEnvelope,
)
from scripts.audit_duel_press_v2_sources import (
    COHORT_FIELDS, TACTICAL_FIELDS, _tactical_competition_name, _v2_context,
    build_audit_rows,
)


DUEL_FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "duel_press_v1"
DETAIL_FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "duel_press_detail_readouts"
V2_FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "duel_press_v2"


def _player():
    payload = json.loads((DUEL_FIXTURES / "valid_player_detail.json").read_text(encoding="utf-8"))
    return DuelPressPlayerEnvelope.model_validate(payload).data


def _record(player_id: int = 194165) -> dict[str, object]:
    record = json.loads((DETAIL_FIXTURES / "complete_static_record.json").read_text(encoding="utf-8"))
    record["player_id"] = player_id
    return record


def _detail(monkeypatch, *, mode: str = "league"):
    player = _player()
    record = _record(player.id)
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    return service.find_duel_press_detail_readouts(
        player.id, "2025/2026", mode, 8, "ucl" if mode == "europe" else "all",
    )


def _payload(monkeypatch) -> dict[str, object]:
    detail = _detail(monkeypatch)
    assert detail is not None
    return detail.model_dump(mode="json")


def _assert_invalid(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        DuelPressDetailReadoutEnvelope.model_validate(payload)


def _v2_fixture(name: str) -> dict[str, object]:
    return json.loads((V2_FIXTURES / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("fixture_name", [
    "complete_league.json", "complete_europe.json", "observed_zero.json",
    "unavailable.json", "partial_pair.json", "imputed_lower_better.json",
])
def test_full_v2_endpoint_fixtures_are_strictly_model_valid(fixture_name: str) -> None:
    """Frontend fixtures carry complete, strict payloads for all v2 routes."""
    fixture = _v2_fixture(fixture_name)
    responses = fixture["responses"]
    for field, model in (
        ("leaderboard", DuelPressV2LeaderboardPageEnvelope),
        ("player", DuelPressV2PlayerEnvelope),
        ("detail", DuelPressDetailReadoutV2Envelope),
    ):
        payload = responses[field]
        validated = model.model_validate(payload)
        assert validated.schemaVersion == "2.0.0"
        assert validated.model_dump(mode="json") == payload


def test_complete_detail_readout_has_six_ordered_categories_and_all_legacy_bars(monkeypatch) -> None:
    detail = _detail(monkeypatch)
    assert detail is not None
    assert detail.metricTaxonomyVersion == "duel-press-v1"
    assert detail.readoutVersion == "detail-readout-v1"
    assert [item.id for item in detail.categories] == [
        "outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress",
    ]
    all_readouts = {readout.id for category in detail.categories for readout in category.readouts}
    all_readouts.update(item.id for item in detail.contextIndicators)
    assert {
        "successfulDribblesPer90", "failedDribblesPer90", "dribbleMarginPer90",
        "groundWonPer90", "groundLostPer90", "duelMarginPer90",
        "aerialWonPer90", "aerialLostPer90", "aerialMarginPer90",
        "netProgressionPer90", "inBoxFinishingGoals", "outsideBoxShotQualityGoals",
        "shootingLuckOrGoalkeeperImpact",
    } <= all_readouts
    combined = next(item for item in detail.categories if item.id == "combinedDuel")
    assert {item.id for item in combined.readouts} >= {
        "groundDuelAttempts", "duelMarginPer90", "aerialDuelAttempts", "aerialMarginPer90",
    }
    assert [item.id for item in detail.contextIndicators] == [
        "netProgressionPer90", "shootingLuckOrGoalkeeperImpact",
    ]
    luck = detail.contextIndicators[1]
    assert luck.label == "득점 운 · 상대 선방"
    assert luck.formulaId == "goals-minus-xgot-v1"


def test_forward_press_preserves_fallback_source_and_total_derivation(monkeypatch) -> None:
    detail = _detail(monkeypatch)
    assert detail is not None
    pressing = next(item for item in detail.categories if item.id == "forwardPress")
    values = {item.id: item for item in pressing.readouts}
    assert values["recoveries"].source == "player_season_total"
    assert values["finalThirdPossessionsWon"].source == "league_per90_fallback"
    assert values["finalThirdPossessionsWon"].state == "server_derived"
    assert values["finalThirdPossessionsWon"].formulaId == "league-per90-total-v1"
    assert values["finalThirdPossessionsWonPer90"].state == "observed"


def test_observed_zero_unavailable_and_imputed_floor_are_distinct(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    record.update({
        "out_box_shots_raw": 0, "out_box_xg_raw": 0, "out_box_xgot_raw": 0,
        "out_box_shot_quality_goals_raw": 0, "dribbles_failed_per90_raw": None,
        "dribble_margin_per90_raw": None,
    })
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    detail = service.find_duel_press_detail_readouts(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None
    outside = next(item for item in detail.categories if item.id == "outsideShot")
    assert outside.readouts[0].value == 0
    assert outside.readouts[0].state == "observed"
    danger = next(item for item in detail.categories if item.id == "dangerZone")
    failed = next(item for item in danger.readouts if item.id == "failedDribblesPer90")
    assert failed.value is None
    assert failed.state == "unavailable"
    assert danger.scoreState == "imputed"
    assert danger.imputedComponents == ["dribble_margin_per90_raw"]


def test_europe_context_nulls_scope_and_keeps_competition(monkeypatch) -> None:
    detail = _detail(monkeypatch, mode="europe")
    assert detail is not None
    assert detail.context.model_dump() == {
        "playerId": 194165, "idNamespace": "fotmob", "season": "2025/2026",
        "mode": "europe", "scope": None, "competition": "ucl",
    }


def test_detail_envelope_rejects_wrong_version_extra_and_bad_null_state(monkeypatch) -> None:
    payload = _payload(monkeypatch)
    payload["readoutVersion"] = "detail-readout-v0"
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["metricTaxonomyVersion"] = "duel-press-v0"
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["extra"] = True
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["categories"][0]["readouts"][0]["value"] = None
    payload["categories"][0]["readouts"][0]["state"] = "observed"
    _assert_invalid(payload)


def test_contract_rejects_wrong_readout_ownership_order_direction_and_context_formula(monkeypatch) -> None:
    payload = _payload(monkeypatch)
    payload["categories"][0]["readouts"][0], payload["categories"][0]["readouts"][1] = (
        payload["categories"][0]["readouts"][1], payload["categories"][0]["readouts"][0],
    )
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["categories"][0]["readouts"][0] = payload["contextIndicators"][0]
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    combined = payload["categories"][3]["readouts"]
    combined[5], combined[6] = combined[6], combined[5]
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    failed = payload["categories"][2]["readouts"][1]
    failed["direction"] = "higher_is_better"
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["contextIndicators"].reverse()
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["contextIndicators"][0]["direction"] = "higher_is_better"
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["contextIndicators"][1]["formulaId"] = "goals-minus-xg-v1"
    _assert_invalid(payload)


def test_generic_readout_rejects_invalid_source_state_provenance(monkeypatch) -> None:
    payload = _payload(monkeypatch)
    outside_shots = payload["categories"][0]["readouts"][0]
    outside_shots["source"] = "server_derived"
    outside_shots["state"] = "observed"
    outside_shots["formulaId"] = None
    outside_shots["formulaVersion"] = None
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    outside_shots = payload["categories"][0]["readouts"][0]
    outside_shots["source"] = "player_season_total"
    outside_shots["state"] = "server_derived"
    outside_shots["formulaId"] = "invented-direct-formula-v1"
    outside_shots["formulaVersion"] = "legacy-bars-v1"
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    outside_shots = payload["categories"][0]["readouts"][0]
    outside_shots["source"] = "unavailable"
    outside_shots["state"] = "imputed"
    outside_shots["missingComponents"] = None
    _assert_invalid(payload)

    # V2-only provenance must remain rejected by the immutable v1 DTO.
    payload = _payload(monkeypatch)
    payload["categories"][0]["readouts"][0]["source"] = "provider_wins_attempts_derived_rate"
    _assert_invalid(payload)

    payload = _payload(monkeypatch)
    payload["categories"][0]["readouts"][0]["source"] = "zero_attempts_observed"
    _assert_invalid(payload)


@pytest.mark.parametrize(
    "mutation",
    [
        "half_unavailable",
        "source_mismatch",
        "player_total_derived",
        "fallback_total_observed",
        "fallback_per90_derived",
    ],
)
def test_forward_press_pair_rejects_invalid_source_state_combinations(monkeypatch, mutation: str) -> None:
    payload = _payload(monkeypatch)
    press = payload["categories"][5]["readouts"]
    recoveries, recoveries_per90 = press[0], press[1]
    final_total, final_per90 = press[2], press[3]
    if mutation == "half_unavailable":
        recoveries_per90.update({
            "value": None, "source": "unavailable", "state": "unavailable",
            "comparison": {
                "state": "unavailable", "median": None, "rank": None,
                "percentile": None, "population": 0,
            },
        })
    elif mutation == "source_mismatch":
        recoveries_per90["source"] = "league_per90_fallback"
    elif mutation == "player_total_derived":
        recoveries.update({
            "state": "server_derived", "formulaId": "league-per90-total-v1",
            "formulaVersion": "legacy-bars-v1",
        })
    elif mutation == "fallback_total_observed":
        final_total.update({
            "state": "observed", "formulaId": None, "formulaVersion": None,
        })
    else:
        final_per90.update({
            "state": "server_derived", "formulaId": "league-per90-total-v1",
            "formulaVersion": "legacy-bars-v1",
        })
    _assert_invalid(payload)


def test_forward_press_observed_zero_pair_is_valid(monkeypatch) -> None:
    payload = _payload(monkeypatch)
    press = payload["categories"][5]["readouts"]
    press[0]["value"] = 0
    press[1]["value"] = 0
    validated = DuelPressDetailReadoutEnvelope.model_validate(payload)
    assert validated.categories[5].readouts[0].value == 0
    assert validated.categories[5].readouts[1].value == 0


def test_lower_better_rank_is_server_authored_in_correct_direction() -> None:
    best = service._detail_comparison(1.0, [1.0, 2.0, 3.0], "lower_is_better")
    worst = service._detail_comparison(3.0, [1.0, 2.0, 3.0], "lower_is_better")
    assert (best.rank, best.percentile, best.median, best.population) == (1, 100.0, 2.0, 3)
    assert (worst.rank, worst.percentile) == (3, 0.0)


@pytest.mark.parametrize(
    ("params", "expected_scope", "expected_competition"),
    [
        ({"mode": "league", "scope": 8, "competition": "all"}, 8, None),
        ({"mode": "europe", "competition": "ucl"}, None, "ucl"),
    ],
)
def test_real_http_route_echoes_canonical_league_and_europe_contexts(
    monkeypatch, params: dict[str, object], expected_scope: int | None,
    expected_competition: str | None,
) -> None:
    detail = _detail(monkeypatch)
    assert detail is not None

    def resolve(player_id: int, season: str, mode: str, scope: int, competition: str):
        return detail.model_copy(update={
            "context": detail.context.model_copy(update={
                "playerId": player_id, "season": season, "mode": mode,
                "scope": scope if mode == "league" else None,
                "competition": competition if mode == "europe" else None,
            }),
        })

    monkeypatch.setattr(api_main, "find_duel_press_detail_readouts", resolve)
    response = TestClient(app).get(
        "/api/v2/players/194165/duel-press/detail-metrics",
        params={"season": "2025/2026", **params},
    )
    assert response.status_code == 200
    assert response.json()["context"] == {
        "playerId": 194165, "idNamespace": "fotmob", "season": "2025/2026",
        "mode": params["mode"], "scope": expected_scope,
        "competition": expected_competition,
    }


@pytest.mark.parametrize("origin", [
    "https://forward-scouting-report-6dn7-tau.vercel.app",
    "https://forward-scouting-report-6dn7-feature-42-messiflick.vercel.app",
])
def test_openapi_and_cors_expose_only_the_additive_get_contract(origin: str) -> None:
    client = TestClient(app)
    schema = client.get("/openapi.json").json()
    path = "/api/v2/players/{playerId}/duel-press/detail-metrics"
    assert set(schema["paths"][path]) == {"get"}
    assert {"200", "404", "422"}.issubset(schema["paths"][path]["get"]["responses"])
    envelope = schema["components"]["schemas"]["DuelPressDetailReadoutEnvelope"]
    assert envelope["additionalProperties"] is False
    assert schema["components"]["schemas"]["DuelPressDetailReadout"]["properties"]["source"]["enum"] == [
        "player_season_total", "league_per90_fallback", "tactical_ratio_static",
        "server_derived", "unavailable",
    ]
    assert schema["components"]["schemas"]["DetailV2Datum"]["properties"]["source"]["enum"] == [
        "player_season_total", "league_per90_fallback", "tactical_ratio_static",
        "provider_wins_attempts_derived_rate", "zero_attempts_observed",
        "server_derived", "unavailable",
    ]
    for model in (
        "DuelPressV2LeaderboardPageEnvelope", "DuelPressV2PlayerEnvelope",
        "DuelPressDetailReadoutV2Envelope",
    ):
        schema_version = schema["components"]["schemas"][model]["properties"]["schemaVersion"]
        assert schema_version["const"] == schema_version["default"] == "2.0.0"

    response = client.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


def test_v2_stat_pairs_are_server_owned_and_share_one_snapshot(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    profile = service.find_duel_press_v2_player(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None and profile is not None
    assert detail.metricTaxonomyVersion == "duel-press-v2"
    assert detail.schemaVersion == "2.0.0"
    assert detail.ratingVersion == "stat-pairs-v2"
    assert detail.ratingSnapshotId == profile.ratingSnapshotId
    outside = detail.categories[0].groups[0].metrics
    assert outside[0].total.value == 4
    assert outside[0].per90.state == "server_derived"
    assert outside[1].per90.direction == "higher_is_better"
    danger = detail.categories[2].groups[0].metrics
    assert danger[2].total.direction == "lower_is_better"
    assert danger[3].id == "netProgressionPer90"
    combined = detail.categories[3].groups
    assert [metric.id for metric in combined[0].metrics] == [
        "combinedDuelAttempts", "combinedDuelWins", "combinedDuelLosses",
        "combinedDuelWinRate", "combinedDuelSuccessMarginPer90",
    ]
    assert combined[1].metrics[2].id == "groundDuelLosses"
    assert combined[1].metrics[4].id == "groundDuelSuccessMarginPer90"
    assert combined[2].metrics[2].id == "aerialDuelLosses"
    assert combined[2].metrics[4].id == "aerialDuelSuccessMarginPer90"
    assert combined[1].metrics[3].value.comparison.median is not None
    assert combined[2].metrics[3].value.comparison.median is not None
    assert all(category.percentileScore == 99 for category in detail.categories)
    assert detail.contextIndicators[0].aggregate is False
    assert detail.contextIndicators[0].metric.value.direction == "higher_is_better"
    assert detail.contextIndicators[1].metric.value.direction == "higher_is_better"
    assert {item.id for item in detail.contextIndicators[1].tooltipFacts} == {"goals", "xgot"}
    fixture = _v2_fixture("complete_league.json")["payload"]
    assert detail.metricTaxonomyVersion == fixture["metricTaxonomyVersion"]
    assert [item.id for item in detail.categories] == fixture["categoryOrder"]
    assert [item.id for item in detail.contextIndicators] == fixture["contextIndicatorOrder"]


def test_v2_provider_attempt_columns_do_not_change_legacy_v1_scores_ranks_or_detail(monkeypatch) -> None:
    """Provider-only v2 inputs must not alter any v1 calculation or DTO."""
    player = _player()
    frame = {"record": _record(player.id)}
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [frame["record"]])

    legacy_before = service.duel_press_leaderboard_envelope(
        "2025/2026", "league", 8, "all", page=1, page_size=50,
        role=None, position=None, age_band="all", minutes_band="all",
        query=None, sort="rank", order="asc",
    )
    detail_before = service.find_duel_press_detail_readouts(player.id, "2025/2026", "league", 8, "all")
    assert detail_before is not None

    # These exact count fields belong to the v2-only ingestion frame.  They
    # deliberately disagree with the legacy rate-derived totals.
    frame["record"] = {
        **frame["record"],
        "ground_duel_attempts_provider_raw": 70,
        "aerial_duel_attempts_provider_raw": 50,
    }
    legacy_after = service.duel_press_leaderboard_envelope(
        "2025/2026", "league", 8, "all", page=1, page_size=50,
        role=None, position=None, age_band="all", minutes_band="all",
        query=None, sort="rank", order="asc",
    )
    detail_after = service.find_duel_press_detail_readouts(player.id, "2025/2026", "league", 8, "all")
    assert detail_after is not None
    assert legacy_after.model_dump(mode="json") == legacy_before.model_dump(mode="json")
    assert detail_after.model_dump(mode="json") == detail_before.model_dump(mode="json")

    service._v2_frame_cached.cache_clear()
    v2 = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    assert v2 is not None
    combined = next(item for item in v2.categories if item.id == "combinedDuel")
    assert combined.groups[1].metrics[0].total.value == 70
    assert combined.groups[2].metrics[0].total.value == 50


def test_v2_rate_zero_is_unavailable_not_zero_and_marks_rating_imputed(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    record["dribble_success_rate_raw"] = 0
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None
    danger = detail.categories[2]
    assert danger.scoreState == "imputed"
    imputed_fixture = _v2_fixture("imputed_lower_better.json")["imputed"]
    assert danger.id == imputed_fixture["category"]
    assert danger.scoreState == imputed_fixture["scoreState"]
    failed = danger.groups[0].metrics[2]
    assert failed.total.value is None
    assert failed.total.state == "unavailable"
    assert failed.total.percentileScore is None
    assert failed.pairState == "unavailable"
    assert failed.pairReason == "source_unavailable"
    fixture = _v2_fixture("unavailable.json")["payload"]
    assert failed.total.state == fixture["state"]
    assert failed.total.value == fixture["value"]


def test_v2_total_without_minutes_is_an_explicit_partial_pair(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    record["minutes_played"] = 0
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None
    attempts = detail.categories[0].groups[0].metrics[0]
    assert attempts.total.value == 4
    assert attempts.per90.value is None
    assert attempts.pairState == "partial"
    assert attempts.pairReason == "minutes_unavailable_or_nonpositive"
    fixture = _v2_fixture("partial_pair.json")["payload"]
    assert attempts.pairState == fixture["pairState"]
    assert attempts.pairReason == fixture["pairReason"]


def test_v2_observed_zero_and_fallback_press_provenance(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    record["out_box_shots_raw"] = 0
    record["out_box_xg_raw"] = 0
    record["out_box_xgot_raw"] = 0
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None
    shots = detail.categories[0].groups[0].metrics[0]
    assert shots.total.value == 0
    assert shots.total.state == "observed"
    zero_fixture = _v2_fixture("observed_zero.json")["payload"]
    assert shots.total.state == zero_fixture["state"]
    assert shots.total.value == zero_fixture["value"]
    press = detail.categories[5].groups[0].metrics[1]
    assert press.total.state == "server_derived"
    assert press.total.formulaId == "league-per90-total-v2"
    assert press.per90.source == "league_per90_fallback"


def test_v2_europe_context_and_schema_rejects_malformed_snapshot(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "europe", 8, "ucl")
    assert detail is not None
    assert detail.context.scope is None
    assert detail.context.competition == "ucl"
    fixture_context = _v2_fixture("complete_europe.json")["payload"]["context"]
    assert detail.context.mode == fixture_context["mode"]
    assert detail.context.scope == fixture_context["scope"]
    payload = detail.model_dump(mode="json")
    payload["ratingSnapshotId"] = "bad"
    with pytest.raises(ValidationError):
        DuelPressDetailReadoutV2Envelope.model_validate(payload)


def test_v2_board_keeps_page_filter_sort_metadata_and_snapshot(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    board = service.duel_press_v2_leaderboard_envelope(
        "2025/2026", "league", 8, "all", page=1, page_size=50,
        role=None, position=None, age_band="all", minutes_band="all",
        query=None, sort="combinedDuel", order="desc",
    )
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None
    assert board.meta.pageSize == 50
    assert board.meta.applied.sort == "combinedDuel"
    assert board.data[0].stats.combinedDuel.percentileScore == detail.categories[3].percentileScore
    # Board rows remain score-only; raw total/per90 drill-down is owned by the
    # separately cached detail endpoint and must not be rebuilt fifty times.
    assert "groups" not in board.data[0].stats.combinedDuel.model_dump()
    assert board.ratingSnapshotId == detail.ratingSnapshotId


def test_v2_board_descending_ties_keep_rank_then_id(monkeypatch) -> None:
    player = _player()
    peer = player.model_copy(update={"id": player.id + 1, "name": "Peer"})
    record = _record(player.id)
    peer_record = dict(record)
    peer_record["player_id"] = peer.id
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player, peer))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record, peer_record])
    service._v2_frame_cached.cache_clear()
    asc = service.duel_press_v2_leaderboard_envelope("2025/2026", "league", 8, "all", page=1, page_size=50, role=None, position=None, age_band="all", minutes_band="all", query=None, sort="rank", order="asc")
    desc = service.duel_press_v2_leaderboard_envelope("2025/2026", "league", 8, "all", page=1, page_size=50, role=None, position=None, age_band="all", minutes_band="all", query=None, sort="rank", order="desc")
    assert [item.id for item in asc.data] == [player.id, peer.id]
    assert [item.id for item in desc.data] == [player.id, peer.id]


def test_v2_http_trio_context_status_and_cors(monkeypatch) -> None:
    detail = _detail(monkeypatch)
    assert detail is not None
    record = _record(detail.player.id)
    player = _player()
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    v2_detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    v2_player = service.find_duel_press_v2_player(player.id, "2025/2026", "league", 8, "all")
    v2_board = service.duel_press_v2_leaderboard_envelope("2025/2026", "league", 8, "all", page=1, page_size=50, role=None, position=None, age_band="all", minutes_band="all", query=None, sort="rank", order="asc")
    assert v2_detail is not None and v2_player is not None
    monkeypatch.setattr(api_main, "find_duel_press_detail_readouts_v2", lambda *args: v2_detail)
    monkeypatch.setattr(api_main, "find_duel_press_v2_player", lambda *args: v2_player)
    monkeypatch.setattr(api_main, "duel_press_v2_leaderboard_envelope", lambda *args, **kwargs: v2_board)
    client = TestClient(app)
    params = {"season": "2025/2026", "mode": "league", "scope": 8, "competition": "all"}
    board = client.get("/api/v2/leaderboards/duel-press-v2", params=params)
    profile = client.get(f"/api/v2/players/{player.id}/duel-press-v2", params=params)
    readout = client.get(f"/api/v2/players/{player.id}/duel-press-v2/detail-metrics", params=params)
    assert [response.status_code for response in (board, profile, readout)] == [200, 200, 200]
    assert board.json()["ratingSnapshotId"] == profile.json()["ratingSnapshotId"] == readout.json()["ratingSnapshotId"]
    assert board.json()["context"] == {"season": "2025/2026", "mode": "league", "scope": 8, "competition": None}
    assert client.get(f"/api/v2/players/{player.id}/duel-press-v2", params={**params, "competition": "ucl"}).status_code == 422
    preflight = client.options("/api/v2/leaderboards/duel-press-v2", headers={"Origin": "https://forward-scouting-report-6dn7-tau.vercel.app", "Access-Control-Request-Method": "GET"})
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "https://forward-scouting-report-6dn7-tau.vercel.app"


def test_v2_lower_is_better_score_is_inverted_and_zero_to_99() -> None:
    best = service._v2_display_comparison(1.0, [1.0, 2.0, 3.0], "lower_is_better")
    worst = service._v2_display_comparison(3.0, [1.0, 2.0, 3.0], "lower_is_better")
    fixture = _v2_fixture("imputed_lower_better.json")["lowerIsBetter"]
    assert (best.rank, best.percentileScore) == (fixture["best"]["rank"], fixture["best"]["percentileScore"])
    assert (worst.rank, worst.percentileScore) == (fixture["worst"]["rank"], fixture["worst"]["percentileScore"])


def test_v2_openapi_exposes_separate_strict_endpoint_trio() -> None:
    schema = TestClient(app).get("/openapi.json").json()
    assert "/api/v2/leaderboards/duel-press-v2" in schema["paths"]
    assert "/api/v2/players/{playerId}/duel-press-v2" in schema["paths"]
    assert "/api/v2/players/{playerId}/duel-press-v2/detail-metrics" in schema["paths"]
    assert schema["components"]["schemas"]["DuelPressDetailReadoutV2Envelope"]["additionalProperties"] is False


def test_yamal_2025_2026_static_source_absence_is_audited_and_visible_in_v2() -> None:
    """Representative guard: never conceal a missing source with a rerating."""
    fixture = _v2_fixture("yamal_2025_2026_source_absence.json")
    expected = fixture["v2Expectation"]
    static = fixture["staticSource"]
    context = fixture["context"]
    rows = build_audit_rows(
        Path(__file__).parents[1] / "data" / "spear_cohort.csv",
        Path(__file__).parents[1] / "data" / "tactical_3zone_ratio.csv",
        timestamp="2026-08-22T00:00:00+00:00",
        scope=int(context["scope"]),
    )
    audit = next(row for row in rows if (
        row["playerId"] == str(context["playerId"])
        and row["season"] == context["season"]
        and row["mode"] == context["mode"]
        and row["scope"] == str(context["scope"])
        and row["competition"] == ""
    ))
    assert audit["missingFields"].split(";") == static["missingFields"]
    assert audit["providerLookupResult"] == static["providerLookupResult"]

    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(
        int(context["playerId"]), str(context["season"]), str(context["mode"]),
        int(context["scope"]), "all",
    )
    profile = service.find_duel_press_v2_player(
        int(context["playerId"]), str(context["season"]), str(context["mode"]),
        int(context["scope"]), "all",
    )
    assert detail is not None and profile is not None
    category = next(item for item in detail.categories if item.id == expected["category"])
    assert category.scoreState == expected["scoreState"]
    assert category.imputedComponents == expected["imputedComponents"]
    aerial_metrics = category.groups[2].metrics
    assert [item.id for item in aerial_metrics[:3]] == expected["unavailableMetrics"]
    assert all(item.pairState == "unavailable" for item in aerial_metrics[:3])
    assert aerial_metrics[3].id == "aerialDuelWinRate"
    assert aerial_metrics[3].value is not None and aerial_metrics[3].value.state == "unavailable"
    assert aerial_metrics[4].id == "aerialDuelSuccessMarginPer90"
    assert aerial_metrics[4].value is not None and aerial_metrics[4].value.state == "unavailable"
    assert profile.data.stats.combinedDuel.scoreState == expected["scoreState"]


def test_v2_derives_aerial_rate_only_from_exact_provider_wins_and_attempts(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    fixture = _v2_fixture("derivable_aerial_rate.json")
    record.update(fixture["rawInputs"])
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None
    aerial = next(item for item in detail.categories if item.id == "combinedDuel").groups[2].metrics
    totals = fixture["expectedAerialTotals"]
    assert aerial[0].total is not None and aerial[0].total.value == totals["attempts"]
    assert aerial[1].total is not None and aerial[1].total.value == totals["wins"]
    assert aerial[2].total is not None and aerial[2].total.value == totals["losses"]
    rate = aerial[3]
    expected_rate = fixture["expectedRate"]
    assert rate.id == "aerialDuelWinRate"
    assert rate.value is not None
    assert {
        "value": rate.value.value,
        "state": rate.value.state,
        "source": rate.value.source,
        "formulaId": rate.value.formulaId,
        "formulaVersion": rate.value.formulaVersion,
    } == expected_rate


def test_v2_explicit_zero_attempt_duels_are_observed_but_losses_use_server_floor(monkeypatch) -> None:
    player = _player()
    record = _record(player.id)
    fixture = _v2_fixture("observed_zero_attempt_duels.json")
    record.update(fixture["rawInputs"])
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: (player,))
    monkeypatch.setattr(service, "_detail_frame_records", lambda *args: [record])
    service._v2_frame_cached.cache_clear()
    detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", "league", 8, "all")
    assert detail is not None
    expected = fixture["expected"]
    combined = next(item for item in detail.categories if item.id == "combinedDuel")
    for group in combined.groups[1:]:
        attempts, wins, losses, rate, margin = group.metrics
        assert attempts.total is not None and attempts.total.value == expected["value"]
        assert attempts.per90 is not None and attempts.per90.value == expected["value"]
        assert wins.total is not None and wins.total.value == expected["value"]
        assert wins.total.state == expected["state"]
        assert wins.total.source == expected["source"]
        assert wins.total.formulaId == expected["formulaId"]
        assert losses.total is not None and losses.total.value == expected["value"]
        assert losses.total.comparison.state == expected["comparisonState"]
        assert losses.total.percentileScore == expected["lossPercentileScore"]
        assert losses.per90 is not None and losses.per90.comparison.state == expected["comparisonState"]
        assert losses.per90.percentileScore == expected["lossPercentileScore"]
        assert rate.value is not None and rate.value.value == expected["value"]
        assert rate.value.state == expected["state"]
        assert rate.value.source == expected["source"]
        assert rate.value.formulaId == expected["formulaId"]
        assert margin.value is not None and margin.value.value == expected["value"]
        assert margin.value.comparison.state == expected["comparisonState"]
        assert margin.value.percentileScore == expected["lossPercentileScore"]


def test_v2_source_audit_distinguishes_derivable_rate_from_missing_wins_or_attempts(tmp_path) -> None:
    cohort_path = tmp_path / "cohort.csv"
    tactical_path = tmp_path / "tactical.csv"
    cohort_fields = [
        "player_id", "player_name", "season_name", "league_name", *COHORT_FIELDS,
        "aerial_duel_attempts_raw", "aerial_duels_won_percentage",
    ]
    cohort_row = {field: "1" for field in cohort_fields}
    cohort_row.update({
        "player_id": "1467236", "player_name": "Lamine Yamal", "season_name": "2025/2026",
        "league_name": "LaLiga", "aerial_duels_won": "12", "aerial_duel_attempts_raw": "20",
        "aerial_duels_won_percentage": "",
    })
    with cohort_path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=cohort_fields)
        writer.writeheader(); writer.writerow(cohort_row)
    with tactical_path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["fotmob_player_id", "competition_name", "season_name", *TACTICAL_FIELDS])
        writer.writeheader(); writer.writerow({
            "fotmob_player_id": "1467236", "competition_name": "LaLiga", "season_name": "2025/2026",
            "cca_area_pct": "10", "danger_zone_density": "20",
        })
    rows = build_audit_rows(cohort_path, tactical_path, timestamp="2026-08-22T00:00:00+00:00")
    assert rows == [{
        "playerId": "1467236", "name": "Lamine Yamal", "season": "2025/2026",
        "mode": "league", "scope": "8", "competition": "", "missingFields": "",
        "derivableFields": "aerial_duel_win_rate_raw",
        "requiredProviderInputs": "verified_sportsapi_player_id;exact_tournament_id;exact_season_id;aerial_duels_won; aerial_duel_attempts;count_units",
        "providerLookupResult": "not_attempted_no_verified_sportsapi_raw_duel_schema",
        "reason": "rate_derivable_from_wins_attempts", "timestamp": "2026-08-22T00:00:00+00:00",
    }]


@pytest.mark.parametrize(
    ("alias", "competition", "code"),
    [
        ("Champions League", "UEFA Champions League", "ucl"),
        ("UEFA Europa League", "UEFA Europa League", "uel"),
        ("Conference League", "UEFA Europa Conference League", "uecl"),
    ],
)
def test_v2_source_audit_maps_all_europe_aliases_to_public_context(alias: str, competition: str, code: str) -> None:
    assert _v2_context(alias, 8) == ("europe", "", code)
    assert _tactical_competition_name(alias) == competition
