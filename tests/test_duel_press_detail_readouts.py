"""Focused contract coverage for the additive duel-press detail readout."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

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
    detail = _detail(monkeypatch)
    assert detail is not None
    payload = detail.model_dump(mode="json")
    payload["readoutVersion"] = "detail-readout-v0"
    with pytest.raises(ValidationError):
        DuelPressDetailReadoutEnvelope.model_validate(payload)

    payload = detail.model_dump(mode="json")
    payload["extra"] = True
    with pytest.raises(ValidationError):
        DuelPressDetailReadoutEnvelope.model_validate(payload)

    payload = detail.model_dump(mode="json")
    payload["categories"][0]["readouts"][0]["value"] = None
    payload["categories"][0]["readouts"][0]["state"] = "observed"
    with pytest.raises(ValidationError):
        DuelPressDetailReadoutEnvelope.model_validate(payload)


def test_openapi_and_cors_expose_only_the_additive_get_contract() -> None:
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
            "Origin": "https://forward-scouting-report-6dn7-tau.vercel.app",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://forward-scouting-report-6dn7-tau.vercel.app"
