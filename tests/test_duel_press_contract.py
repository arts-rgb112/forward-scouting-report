from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from api_server import service
from api_server.main import app
from api_server.schemas import (
    DuelPressLeaderboardEnvelope,
    DuelPressPlayerEnvelope,
    DuelPressPlayerResponse,
    DuelPressRawMetrics,
    DuelPressRequestContext,
)


FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "duel_press_v1"


def load_fixture(name: str) -> object:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_handoff_fixtures_validate_and_invalid_discriminator_fails() -> None:
    DuelPressLeaderboardEnvelope.model_validate(load_fixture("valid_leaderboard.json"))
    DuelPressPlayerEnvelope.model_validate(load_fixture("valid_player_detail.json"))
    DuelPressRawMetrics.model_validate(load_fixture("null_raw_metrics.json"))
    observed = DuelPressRawMetrics.model_validate(load_fixture("observed_zero.json"))
    assert observed.recoveries == 0
    assert observed.finalThirdPossessionsWon == 0

    variants = load_fixture("source_variants.json")
    for raw in variants.values():
        DuelPressRawMetrics.model_validate(raw)

    with pytest.raises(ValidationError) as error:
        DuelPressPlayerEnvelope.model_validate(load_fixture("invalid_discriminator.json"))
    assert any(item["loc"] == ("metricTaxonomyVersion",) for item in error.value.errors())


@pytest.mark.parametrize(
    "payload",
    [
        {
            "recoveries": 0,
            "recoveriesPer90": 0,
            "recoveriesSource": None,
            "finalThirdPossessionsWon": None,
            "finalThirdPossessionsWonPer90": None,
            "finalThirdPossessionsWonSource": None,
        },
        {
            "recoveries": None,
            "recoveriesPer90": None,
            "recoveriesSource": "player_season_total",
            "finalThirdPossessionsWon": None,
            "finalThirdPossessionsWonPer90": None,
            "finalThirdPossessionsWonSource": None,
        },
        {
            "recoveries": 10,
            "recoveriesPer90": None,
            "recoveriesSource": "league_per90_fallback",
            "finalThirdPossessionsWon": None,
            "finalThirdPossessionsWonPer90": None,
            "finalThirdPossessionsWonSource": None,
        },
    ],
)
def test_raw_metric_source_total_per90_invariant_rejects_malformed_pairs(payload: dict) -> None:
    with pytest.raises(ValidationError):
        DuelPressRawMetrics.model_validate(payload)


def test_discriminator_is_at_the_same_root_location_and_detail_echoes_context() -> None:
    client = TestClient(app)
    leaderboard = client.get(
        "/api/v2/leaderboards/duel-press",
        params={"season": "2025/2026", "mode": "league", "scope": 8, "pageSize": 50},
    )
    assert leaderboard.status_code == 200
    leaderboard_payload = leaderboard.json()
    player_id = leaderboard_payload["data"][0]["id"]

    detail = client.get(
        f"/api/v2/players/{player_id}/duel-press",
        params={"season": "2025/2026", "mode": "league", "scope": 8},
    )
    assert detail.status_code == 200
    detail_payload = detail.json()
    assert leaderboard_payload["metricTaxonomyVersion"] == "duel-press-v1"
    assert detail_payload["metricTaxonomyVersion"] == "duel-press-v1"
    assert "metricTaxonomyVersion" not in leaderboard_payload["meta"]
    assert "metricTaxonomyVersion" not in leaderboard_payload["data"][0]
    assert detail_payload["context"] == {
        "playerId": player_id,
        "idNamespace": "fotmob",
        "season": "2025/2026",
        "mode": "league",
        "scope": 8,
        "competition": None,
    }
    assert detail_payload["data"]["id"] == player_id
    assert detail_payload["data"]["idNamespace"] == "fotmob"


def test_europe_detail_context_is_isolated_from_domestic_scope() -> None:
    client = TestClient(app)
    response = client.get(
        "/api/v2/players/194165/duel-press",
        params={
            "season": "2025/2026", "mode": "europe", "scope": 8,
            "competition": "ucl",
        },
    )
    assert response.status_code == 200
    assert response.json()["context"] == {
        "playerId": 194165,
        "idNamespace": "fotmob",
        "season": "2025/2026",
        "mode": "europe",
        "scope": None,
        "competition": "ucl",
    }


def test_fixed_pagination_empty_and_out_of_range_rules() -> None:
    client = TestClient(app)
    invalid_size = client.get(
        "/api/v2/leaderboards/duel-press", params={"pageSize": 49},
    )
    assert invalid_size.status_code == 422

    empty = client.get(
        "/api/v2/leaderboards/duel-press",
        params={"pageSize": 50, "q": "__no_such_player_contract_fixture__"},
    )
    assert empty.status_code == 200
    assert empty.json()["data"] == []
    assert empty.json()["meta"] | {
        "returned": 0, "totalItems": 0, "totalPages": 0, "hasNextPage": False,
    } == empty.json()["meta"]

    overflow = client.get(
        "/api/v2/leaderboards/duel-press",
        params={"page": 9999, "pageSize": 50},
    )
    assert overflow.status_code == 200
    assert overflow.json()["data"] == []
    assert overflow.json()["meta"]["page"] == 9999
    assert overflow.json()["meta"]["returned"] == 0
    assert overflow.json()["meta"]["hasNextPage"] is False


def test_invalid_sort_and_mode_competition_mismatch_are_422() -> None:
    client = TestClient(app)
    invalid_sort = client.get(
        "/api/v2/leaderboards/duel-press",
        params={"pageSize": 50, "sort": "aerial"},
    )
    assert invalid_sort.status_code == 422
    assert invalid_sort.json()["detail"][0]["loc"] == ["query", "sort"]

    mismatch = client.get(
        "/api/v2/leaderboards/duel-press",
        params={"pageSize": 50, "mode": "league", "competition": "ucl"},
    )
    assert mismatch.status_code == 422
    assert mismatch.json() == {"detail": "competition must be 'all' when mode is 'league'"}


def test_tied_primary_values_use_rank_then_id_for_both_orders(monkeypatch) -> None:
    base = DuelPressLeaderboardEnvelope.model_validate(
        load_fixture("valid_leaderboard.json")
    ).data[0]
    rows = (
        base.model_copy(update={"id": 30, "rank": 1, "score": 50.0}),
        base.model_copy(update={"id": 20, "rank": 2, "score": 50.0}),
        base.model_copy(update={"id": 10, "rank": 1, "score": 50.0}),
    )
    monkeypatch.setattr(service, "build_duel_press_players", lambda *args: rows)

    for order in ("asc", "desc"):
        envelope = service.duel_press_leaderboard_envelope(
            "2025/2026", "league", 8, "all", page=1, page_size=50,
            role=None, position=None, query=None, sort="score", order=order,
        )
        assert [player.id for player in envelope.data] == [10, 30, 20]


def test_openapi_fixes_page_size_nullability_context_and_error_responses() -> None:
    schema = TestClient(app).get("/openapi.json").json()
    leaderboard_get = schema["paths"]["/api/v2/leaderboards/duel-press"]["get"]
    detail_get = schema["paths"]["/api/v2/players/{playerId}/duel-press"]["get"]
    for operation in (leaderboard_get, detail_get):
        assert {"200", "404", "422"}.issubset(operation["responses"])

    page_size = next(
        parameter for parameter in leaderboard_get["parameters"]
        if parameter["name"] == "pageSize"
    )
    assert page_size["schema"]["minimum"] == 50
    assert page_size["schema"]["maximum"] == 50

    raw = schema["components"]["schemas"]["DuelPressRawMetrics"]
    assert raw["additionalProperties"] is False
    assert {"number", "null"} == {
        item["type"] for item in raw["properties"]["recoveries"]["anyOf"]
    }
    context = schema["components"]["schemas"]["DuelPressRequestContext"]
    assert set(context["required"]) == {
        "playerId", "season", "mode",
    }


@pytest.mark.parametrize(
    "origin",
    [
        "https://forward-scouting-report-6dn7-tau.vercel.app",
        "https://forward-scouting-report-6dn7-feature-42-messiflick.vercel.app",
    ],
)
def test_companion_preflight_allows_production_and_preview_origins(origin: str) -> None:
    response = TestClient(app).options(
        "/api/v2/leaderboards/duel-press",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers.get("access-control-allow-credentials") is None


def test_companion_preflight_rejects_hostile_origin() -> None:
    response = TestClient(app).options(
        "/api/v2/leaderboards/duel-press",
        headers={
            "Origin": "https://hostile.example",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_five_seasons_and_all_domestic_scopes_are_advertised() -> None:
    options = TestClient(app).get("/api/v2/leaderboard-options")
    assert options.status_code == 200
    payload = options.json()
    assert payload["seasons"] == [
        "2025/2026", "2024/2025", "2023/2024", "2022/2023", "2021/2022",
    ]
    assert [item["value"] for item in payload["scopes"]] == [3, 5, 7, 8]
    scope8 = next(item for item in payload["scopes"] if item["value"] == 8)
    assert 40 in scope8["leagueIds"]
