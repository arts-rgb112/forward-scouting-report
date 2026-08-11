from fastapi.testclient import TestClient

from api_server.main import app, cors_origin_regex, cors_origins
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


def test_cors_preflight_allows_immutable_vercel_preview_domain_only():
    preview = "https://forward-scouting-report-6dn7-pr-158-messiflick.vercel.app"
    response = client.options("/api/v2/leaderboards", headers={"Origin": preview, "Access-Control-Request-Method": "GET"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == preview
    assert cors_origin_regex().startswith("^https://forward-scouting-report-6dn7-")
    hostile = client.options("/api/v2/leaderboards", headers={"Origin": "https://forward-scouting-report-6dn7-pr-158-attacker.vercel.app", "Access-Control-Request-Method": "GET"})
    assert hostile.status_code == 400


def test_cors_environment_is_an_exact_comma_separated_allowlist(monkeypatch):
    monkeypatch.setenv("MESSI_CORS_ORIGINS", "https://dashboard.example.test/, https://preview.example.test")
    assert cors_origins() == ["https://dashboard.example.test", "https://preview.example.test"]


def test_watchlist_post_cors_is_limited_to_the_fixed_production_origin():
    origin = "https://forward-scouting-report-6dn7-tau.vercel.app"
    allowed = client.options("/api/v2/watchlist/resolve", headers={
        "Origin": origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
    })
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == origin
    assert "POST" in allowed.headers["access-control-allow-methods"]
    assert allowed.headers.get("access-control-allow-credentials") is None

    preview = "https://forward-scouting-report-6dn7-pr-160-messiflick.vercel.app"
    denied = client.options("/api/v2/watchlist/resolve", headers={
        "Origin": preview,
        "Access-Control-Request-Method": "POST",
    })
    assert denied.status_code == 403
    assert "access-control-allow-origin" not in denied.headers


def test_unsupported_season_is_explicit_not_found():
    response = client.get("/api/v1/players", params={"season": "2010/2011"})
    assert response.status_code == 404


def test_v2_options_advertise_real_capabilities_and_unavailable_competitions():
    response = client.get("/api/v2/leaderboard-options")
    assert response.status_code == 200
    payload = response.json()
    assert "2025/2026" in payload["seasons"]
    assert {scope["value"] for scope in payload["scopes"]} == {3, 5, 7}
    assert payload["competitions"]["ucl"]["available"] is True
    assert payload["competitions"]["uecl"]["available"] is False
    assert payload["competitions"]["uecl"]["reason"]


def test_v2_europe_leaderboard_and_contextual_player_detail_contract():
    response = client.get("/api/v2/leaderboards", params={"season": "2025/2026", "mode": "europe", "competition": "ucl", "limit": 3})
    assert response.status_code == 200
    payload = response.json()
    assert payload["meta"]["schemaVersion"] == "2.0.0"
    assert payload["meta"]["mode"] == "europe"
    assert payload["meta"]["competition"] == "ucl"
    assert payload["meta"]["scope"] is None
    assert payload["meta"]["returned"] == len(payload["data"]) == 3
    player_id = payload["data"][0]["id"]
    legacy_detail = client.get(f"/api/v2/players/{player_id}", params={"season": "2025/2026", "mode": "europe", "competition": "ucl"})
    assert legacy_detail.status_code == 200
    assert "analysis" not in legacy_detail.json()["data"]
    assert "idNamespace" not in legacy_detail.json()["data"]
    detail = client.get(f"/api/v2/players/{player_id}", params={"season": "2025/2026", "mode": "europe", "competition": "ucl", "includeAnalysis": "true"})
    assert detail.status_code == 200
    assert detail.json()["data"]["id"] == player_id
    assert detail.json()["data"]["idNamespace"] == "fotmob"
    analysis = detail.json()["data"]["analysis"]
    assert set(analysis) == {"score", "volumeRadar", "ratioRadar", "rawMetrics", "spatial"}
    assert len(analysis["volumeRadar"]["axes"]) == len(analysis["ratioRadar"]["axes"]) == 6
    assert all(0 <= axis["score"] <= 100 for axis in analysis["ratioRadar"]["axes"])


def test_v2_unavailable_competition_is_not_silently_rendered_as_empty():
    response = client.get("/api/v2/leaderboards", params={"season": "2025/2026", "mode": "europe", "competition": "uecl"})
    assert response.status_code == 404


def test_v21_server_pagination_filters_and_sorts_without_changing_v20_contract():
    legacy = client.get("/api/v2/leaderboards", params={"season": "2025/2026", "limit": 2})
    assert legacy.status_code == 200
    assert legacy.json()["meta"]["schemaVersion"] == "2.0.0"
    response = client.get("/api/v2/leaderboards", params={
        "season": "2025/2026", "page": 2, "pageSize": 7,
        "sort": "score", "order": "desc", "role": "Type A", "q": "a",
    })
    assert response.status_code == 200
    payload = response.json()
    meta = payload["meta"]
    assert meta["schemaVersion"] == "2.1.0"
    assert {"page", "pageSize", "totalPages", "hasNextPage"}.issubset(meta)
    assert meta["page"] == 2 and meta["pageSize"] == 7
    assert meta["returned"] == len(payload["data"]) <= 7
    assert all(player["archetype"] == "Type A" for player in payload["data"])
    assert [player["score"] for player in payload["data"]] == sorted((player["score"] for player in payload["data"]), reverse=True)


def test_detail_and_compare_are_available_for_league_ucl_and_uel_contexts():
    contexts = (
        {"mode": "league", "scope": 7, "competition": "all"},
        {"mode": "europe", "scope": 7, "competition": "ucl"},
        {"mode": "europe", "scope": 7, "competition": "uel"},
    )
    for context in contexts:
        leaderboard = client.get("/api/v2/leaderboards", params={"season": "2025/2026", "limit": 2, **context})
        assert leaderboard.status_code == 200
        player_ids = [row["id"] for row in leaderboard.json()["data"]]
        detail = client.get(f"/api/v2/players/{player_ids[0]}", params={"season": "2025/2026", "includeAnalysis": "true", **context})
        assert detail.status_code == 200
        assert detail.json()["data"]["analysis"]["spatial"]["source"] == "messi-static-cohort"
        comparison = client.get("/api/v2/compare", params={"players": ",".join(map(str, player_ids)), "season": "2025/2026", **context})
        assert comparison.status_code == 200
        assert [row["id"] for row in comparison.json()["data"]] == player_ids
        assert {row["idNamespace"] for row in comparison.json()["data"]} == {"fotmob"}


def test_watchlist_resolve_keeps_order_and_isolates_invalid_contexts():
    ucl_2526 = {player.id for player in service.build_v2_players("2025/2026", "europe", 7, "ucl")}
    ucl_2425 = {player.id for player in service.build_v2_players("2024/2025", "europe", 7, "ucl")}
    player_id = next(iter(ucl_2526 & ucl_2425))
    origin = "https://forward-scouting-report-6dn7-tau.vercel.app"
    response = client.post("/api/v2/watchlist/resolve", headers={"Origin": origin}, json={"entries": [
        {
            "key": f"fotmob:{player_id}|season:2025/2026|mode:europe|scope:null|competition:ucl", "player": {"idNamespace": "fotmob", "playerId": player_id},
            "context": {"season": "2025/2026", "mode": "europe", "scope": None, "competition": "ucl"},
        },
        {
            "key": "bad-context", "player": {"idNamespace": "fotmob", "playerId": player_id},
            "context": {"season": "2025/2026", "mode": "league", "scope": None, "competition": None},
        },
        {
            "key": f"fotmob:{player_id}|season:2024/2025|mode:europe|scope:null|competition:ucl", "player": {"idNamespace": "fotmob", "playerId": player_id},
            "context": {"season": "2024/2025", "mode": "europe", "scope": None, "competition": "ucl"},
        },
    ]})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    results = response.json()["results"]
    assert [item["key"] for item in results] == [
        f"fotmob:{player_id}|season:2025/2026|mode:europe|scope:null|competition:ucl",
        "bad-context",
        f"fotmob:{player_id}|season:2024/2025|mode:europe|scope:null|competition:ucl",
    ]
    assert [item["status"] for item in results] == ["resolved", "invalid_context", "resolved"]
    assert results[0]["player"]["idNamespace"] == "fotmob"
    assert results[0]["player"]["playerId"] == player_id
    assert results[0]["context"] != results[2]["context"]


def test_watchlist_resolution_rejects_hostile_origins_and_large_bodies():
    payload = {"entries": []}
    hostile = client.post("/api/v2/watchlist/resolve", headers={"Origin": "https://attacker.invalid"}, json=payload)
    assert hostile.status_code == 403
    assert "access-control-allow-origin" not in hostile.headers
    origin = "https://forward-scouting-report-6dn7-tau.vercel.app"
    oversized = client.post("/api/v2/watchlist/resolve", headers={"Origin": origin, "Content-Type": "application/json"}, content=b"x" * (64 * 1024 + 1))
    assert oversized.status_code == 413


def test_openapi_advertises_the_v1_response_contract():
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()["components"]["schemas"]
    assert {"position", "archetype", "tier"}.issubset(schema["PlayerResponse"]["properties"])
    assert schema["PlayerResponse"]["properties"]["id"]["exclusiveMinimum"] == 0
    assert schema["DatasetMeta"]["properties"]["schemaVersion"]["const"] == "1.0.0"
    assert schema["LeaderboardMeta"]["properties"]["schemaVersion"]["const"] == "2.0.0"
    paths = response.json()["paths"]
    leaderboard_schema = paths["/api/v2/leaderboards"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert {item["$ref"].rsplit("/", 1)[-1] for item in leaderboard_schema["anyOf"]} == {"LeaderboardEnvelope", "LeaderboardPageEnvelope"}
    assert "/api/v2/compare" in paths
    assert "/api/v2/watchlist/resolve" in paths
    assert "PlayerAnalysis" in schema and "LeaderboardPageMeta" in schema


def test_tier_boundaries():
    assert tier_from_rank(1, 100).model_dump() == {"code": "diamond", "level": 1, "label": "Diamond"}
    assert tier_from_rank(13, 100).code == "gold"
    assert tier_from_rank(98, 100).code == "iron"
