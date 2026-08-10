from fastapi.testclient import TestClient

from api_server.main import app, cors_origins
from api_server import service
from api_server.profiles import age_on
from api_server.service import dataset_generated_at, tier_from_rank


client = TestClient(app)


def test_age_is_calculated_as_of_the_reference_date():
    from datetime import date

    assert age_on(date(2000, 12, 31), date(2026, 8, 10)) == 25
    assert age_on(date(2000, 8, 10), date(2026, 8, 10)) == 26


def test_health_uses_2025_2026_real_cohort():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["season"] == "2025/2026"
    assert response.json()["players"] > 100


def test_players_implements_frontend_v1_contract_with_real_sector_scores():
    response = client.get("/api/v1/players", params={"season": "2025/2026", "scope": 7, "limit": 3})
    assert response.status_code == 200
    payload = response.json()
    assert payload["meta"]["population"] > 100
    assert payload["meta"]["returned"] == len(payload["data"]) == 3
    assert set(payload["meta"]) == {"schemaVersion", "season", "scope", "population", "returned", "generatedAt", "source"}
    assert payload["meta"]["schemaVersion"] == "1.0.0"
    assert payload["meta"]["generatedAt"] == dataset_generated_at().isoformat().replace("+00:00", "Z")
    player = payload["data"][0]
    assert set(player) == {"id", "rank", "name", "position", "archetype", "age", "minutes", "tier", "score", "face", "nation", "league", "club", "stats"}
    assert player["archetype"] in {"Type A", "Type B"}
    assert isinstance(player["age"], int)
    assert str(player["face"]).startswith("https://images.fotmob.com/image_resources/playerimages/")
    assert player["nation"] is None
    assert set(player["tier"]) == {"code", "level", "label"}
    assert 1 <= player["tier"]["level"] <= 5
    assert set(player["league"]) == set(player["club"]) == {"id", "name", "icon"}
    assert str(player["league"]["icon"]).startswith("https://images.fotmob.com/image_resources/logo/leaguelogo/")
    assert str(player["club"]["icon"]).startswith("https://images.fotmob.com/image_resources/logo/teamlogo/")
    assert set(player["stats"]) == {"outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"}
    assert player["id"] > 0


def test_invalid_source_player_id_is_dropped_not_coerced_to_zero(monkeypatch):
    import pandas as pd

    frame = pd.DataFrame([{
        "player_id": "not-a-source-id", "rank": 1, "player_name": "Invalid", "position": "CF", "role": "Type A",
        "minutes_played": 100, "score": 90, "league_id": 47, "league_name": "Premier League", "team_id": 1, "team_name": "Club",
        "outside_shot_score": 90, "deep_box_score": 90, "danger_zone_score": 90, "aerial_score": 90, "ground_duel_score": 90, "space_control_score": 90,
    }])
    service.build_players.cache_clear()
    monkeypatch.setattr(service, "get_spear_leaderboard", lambda *_args: frame)
    try:
        assert service.build_players("2025/2026", 7) == ()
    finally:
        service.build_players.cache_clear()


def test_cors_preflight_allows_local_frontend():
    response = client.options("/api/v1/players", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_cors_preflight_denies_hostile_origin():
    response = client.options("/api/v1/players", headers={"Origin": "https://attacker.invalid", "Access-Control-Request-Method": "GET"})
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_cors_environment_is_an_exact_comma_separated_allowlist(monkeypatch):
    monkeypatch.setenv("MESSI_CORS_ORIGINS", "https://dashboard.example.test/, https://preview.example.test")
    assert cors_origins() == ["https://dashboard.example.test", "https://preview.example.test"]


def test_unsupported_season_is_explicit_not_found():
    response = client.get("/api/v1/players", params={"season": "2010/2011"})
    assert response.status_code == 404


def test_openapi_advertises_the_v1_response_contract():
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()["components"]["schemas"]
    assert {"position", "archetype", "tier"}.issubset(schema["PlayerResponse"]["properties"])
    assert schema["PlayerResponse"]["properties"]["id"]["exclusiveMinimum"] == 0
    assert schema["DatasetMeta"]["properties"]["schemaVersion"]["const"] == "1.0.0"


def test_tier_boundaries():
    assert tier_from_rank(1, 100).model_dump() == {"code": "diamond", "level": 1, "label": "Diamond"}
    assert tier_from_rank(13, 100).code == "gold"
    assert tier_from_rank(98, 100).code == "iron"
