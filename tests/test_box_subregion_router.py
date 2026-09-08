import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api_server.box_subregion_contract import build_box_subregion_envelope
from api_server.box_subregion_router import create_box_subregion_router
from api_server.box_subregion_sources import aggregate_selected_box_sources


def client_for(provider):
    app = FastAPI()
    app.include_router(create_box_subregion_router(provider, lambda: ["2025/2026"]))
    return TestClient(app)


def observed(context):
    source = aggregate_selected_box_sources(
        [{"fotmobPlayerId": context.playerId, "sportsapiPlayerId": 110, "tournamentId": 35, "seasonId": 77333, "season": context.season}], {}, {},
    )
    return build_box_subregion_envelope(context, source)


def test_known_unavailable_is_200_and_unknown_player_is_404():
    client = client_for(lambda context: observed(context) if context.playerId == 10 else None)
    response = client.get("/api/v2/players/10/box-subregion-stats")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["completeness"] == "unavailable"
    assert response.json()["context"] == {"playerId": 10, "season": "2025/2026", "mode": "league", "scope": 8, "competition": None}
    assert client.get("/api/v2/players/11/box-subregion-stats").status_code == 404


@pytest.mark.parametrize("query,status", [
    ("?unknown=1", 422), ("?scope=8&scope=8", 422),
    ("?mode=europe&scope=8", 422), ("?mode=league&competition=ucl", 422),
    ("?season=2024/2025", 404), ("?season=invalid", 422),
    ("?scope=4", 422), ("?mode=other", 422),
])
def test_invalid_context_rejected_before_provider(query, status):
    calls = []
    client = client_for(lambda context: calls.append(context))
    assert client.get("/api/v2/players/10/box-subregion-stats" + query).status_code == status
    assert calls == []


def test_europe_context_and_positive_player():
    client = client_for(observed)
    response = client.get("/api/v2/players/10/box-subregion-stats?mode=europe&competition=ucl")
    assert response.status_code == 200
    assert response.json()["context"]["scope"] is None
    assert response.json()["context"]["competition"] == "ucl"
    assert client.get("/api/v2/players/0/box-subregion-stats").status_code == 422


@pytest.mark.parametrize("error_type", [ValueError, KeyError, OSError, RuntimeError])
def test_provider_corruption_is_not_unavailable_and_does_not_leak_details(error_type):
    def invalid(context):
        raise error_type("private local source path")
    response = client_for(invalid).get("/api/v2/players/10/box-subregion-stats")
    assert response.status_code == 500
    assert "private" not in response.text


def test_invalid_canonical_season_is_422_even_if_provider_advertises_it():
    app = FastAPI()
    calls = []
    app.include_router(create_box_subregion_router(lambda context: calls.append(context), lambda: ["2025/2028"]))
    response = TestClient(app).get("/api/v2/players/10/box-subregion-stats?season=2025/2028")
    assert response.status_code == 422
    assert calls == []


def test_cross_context_provider_response_is_rejected():
    def wrong(context):
        envelope = observed(context)
        envelope.context.season = "2024/2025"
        return envelope
    assert client_for(wrong).get("/api/v2/players/10/box-subregion-stats").status_code == 500


def test_openapi_route_is_additive_and_factory_has_no_mount_side_effect():
    app = FastAPI()
    assert "/api/v2/players/{playerId}/box-subregion-stats" not in app.openapi()["paths"]
    schema = client_for(observed).get("/openapi.json").json()
    route = schema["paths"]["/api/v2/players/{playerId}/box-subregion-stats"]["get"]
    assert route["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith("BoxSubregionEnvelope")
