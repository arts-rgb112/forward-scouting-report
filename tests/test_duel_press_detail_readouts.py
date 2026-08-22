"""Focused contract coverage for the additive duel-press detail readout."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from api_server import main as api_main
from api_server import service
from api_server.main import app
from api_server.schemas import DuelPressDetailReadoutEnvelope, DuelPressPlayerEnvelope


DUEL_FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "duel_press_v1"
DETAIL_FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "duel_press_detail_readouts"


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

    response = client.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
