import json
from pathlib import Path

from fastapi.testclient import TestClient

from api_server.main import app, cors_origin_regex, cors_origins
from api_server import service
from api_server.profiles import age_on, player_age
from api_server.service import dataset_generated_at, tier_from_rank


client = TestClient(app)


def test_age_is_calculated_as_of_the_reference_date():
    from datetime import date

    assert age_on(date(2000, 12, 31), date(2026, 8, 10)) == 25
    assert age_on(date(2000, 8, 10), date(2026, 8, 10)) == 26


def test_placeholder_birth_date_is_not_exposed_as_an_invalid_age():
    # Regression: Daniel Mosquera's provider placeholder 0001-01-01 once
    # produced age 2025 and made every 2024/2025 leaderboard request fail.
    assert player_age(1130732) is None


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
    assert set(player["tier"]) == {"code", "level", "label", "taxonomyVersion"}
    assert player["tier"]["taxonomyVersion"] == "crystal-v2"
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


def test_2024_2025_leaderboards_are_servable_for_both_v1_and_v21():
    v1 = client.get("/api/v1/players", params={"season": "2024/2025", "scope": 7, "limit": 50})
    assert v1.status_code == 200
    assert v1.json()["meta"]["returned"] == len(v1.json()["data"])
    assert all(15 <= player["age"] <= 60 for player in v1.json()["data"])

    v21 = client.get("/api/v2/leaderboards", params={
        "season": "2024/2025", "mode": "league", "scope": 7, "competition": "all",
        "page": 1, "pageSize": 50, "sort": "score", "order": "desc",
    })
    assert v21.status_code == 200
    assert v21.json()["meta"]["season"] == "2024/2025"
    assert v21.json()["meta"]["returned"] == len(v21.json()["data"])


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
    spatial = analysis["spatial"]
    assert len(spatial["depthRatios"]) == 6
    assert len(spatial["positionalGrid"]) == 30
    assert {(cell["depth"], cell["lane"]) for cell in spatial["positionalGrid"]} == {
        (depth, lane) for depth in range(1, 7) for lane in range(1, 6)
    }
    core = spatial["trueCore"]
    assert core["available"] is True
    assert core["targetDensityPct"] == 50
    assert core["zoneCount"] == len(core["zoneIds"]) == len(core["zones"])
    assert core["achievedDensityPct"] >= 50
    assert all(zone["densityPct"] > 0 for zone in core["zones"])
    continuous = spatial["continuousCore"]
    assert continuous["available"] is True
    assert continuous["definitionVersion"] == "continuous-hdr-50-v1"
    assert continuous["targetDensityPct"] == 50
    assert continuous["achievedDensityPct"] >= 50
    assert continuous["coreAreaPct"] == spatial["ccaAreaPct"]
    assert continuous["coreAreaPct"] <= core["coreAreaPct"]
    assert spatial["shotmapPointCount"] == len(spatial["shotmapPoints"])


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
        assert comparison.json()["meta"]["tierTaxonomyVersion"] == "crystal-v2"
        assert {row["tier"]["taxonomyVersion"] for row in comparison.json()["data"]} == {"crystal-v2"}


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
    assert results[0]["player"]["tier"]["taxonomyVersion"] == "crystal-v2"
    assert results[0]["context"] != results[2]["context"]


def test_son_data_quality_exposes_recovered_spatial_data_without_changing_player_dto():
    response = client.get("/api/v2/players/212867/data-quality", params={
        "season": "2023/2024", "mode": "league", "scope": 7,
        "competition": "all",
    })
    assert response.status_code == 200
    quality = response.json()["data"]["dataQuality"]
    assert quality == {
        "qualityVersion": "messi-quality-v1",
        "spatialAvailable": True,
        "messiScoreComplete": True,
        "reason": "complete",
        "imputedMetrics": [],
        "imputedComponents": [],
        "observedWeightPct": 100.0,
        "fallbackComponentScore": 20,
    }


def test_watchlist_data_quality_batches_contexts_under_the_same_security_gate():
    origin = "https://forward-scouting-report-6dn7-tau.vercel.app"
    key = "fotmob:212867|season:2023/2024|mode:league|scope:7|competition:null"
    payload = {"entries": [{
        "key": key,
        "player": {"idNamespace": "fotmob", "playerId": 212867},
        "context": {
            "season": "2023/2024", "mode": "league", "scope": 7,
            "competition": None,
        },
    }]}
    response = client.post(
        "/api/v2/watchlist/data-quality", headers={"Origin": origin}, json=payload,
    )
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["key"] == key and result["status"] == "resolved"
    assert result["playerId"] == 212867
    assert result["dataQuality"]["observedWeightPct"] == 100.0

    hostile = client.post(
        "/api/v2/watchlist/data-quality",
        headers={"Origin": "https://attacker.invalid"}, json=payload,
    )
    assert hostile.status_code == 403
    assert "access-control-allow-origin" not in hostile.headers


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
    assert schema["PlayerTier"]["properties"]["code"]["enum"] == ["diamond", "emerald", "platinum", "gold", "silver", "bronze"]
    assert schema["PlayerTier"]["properties"]["taxonomyVersion"]["const"] == "crystal-v2"
    assert schema["LeaderboardMeta"]["properties"]["tierTaxonomyVersion"]["const"] == "crystal-v2"
    assert schema["CompareMeta"]["properties"]["tierTaxonomyVersion"]["const"] == "crystal-v2"
    assert schema["PlayerTier"]["examples"][0]["taxonomyVersion"] == "crystal-v2"
    paths = response.json()["paths"]
    leaderboard_schema = paths["/api/v2/leaderboards"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert {item["$ref"].rsplit("/", 1)[-1] for item in leaderboard_schema["anyOf"]} == {"LeaderboardEnvelope", "LeaderboardPageEnvelope"}
    assert "/api/v2/compare" in paths
    assert "/api/v2/watchlist/resolve" in paths
    assert "/api/v2/watchlist/data-quality" in paths
    assert "/api/v2/players/{player_id}/data-quality" in paths
    assert "/api/v2/players/{player_id}/tactical-quadrant" in paths
    assert schema["MessiDataQuality"]["properties"]["qualityVersion"]["const"] == "messi-quality-v1"
    assert "PlayerAnalysis" in schema and "LeaderboardPageMeta" in schema


def test_tactical_quadrant_uses_detail_context_and_exposes_selected_player():
    leaderboard = client.get(
        "/api/v2/leaderboards",
        params={"season": "2023/2024", "mode": "league", "scope": 7, "limit": 10},
    )
    assert leaderboard.status_code == 200
    player_id = leaderboard.json()["data"][0]["id"]
    response = client.get(
        f"/api/v2/players/{player_id}/tactical-quadrant",
        params={"season": "2023/2024", "mode": "league", "scope": 7, "competition": "all"},
    )
    assert response.status_code == 200
    quadrant = response.json()["data"]
    assert quadrant["playerId"] == player_id
    assert quadrant["season"] == "2023/2024"
    assert quadrant["scope"] == 7 and quadrant["competition"] is None
    assert quadrant["xAxis"] == "netProgressionPer90"
    assert quadrant["yAxis"] == "inBoxXgotMinusXg"
    assert quadrant["cohortPopulation"] == len(quadrant["points"])
    if quadrant["available"]:
        assert quadrant["reason"] == "complete"
        assert quadrant["selectedPoint"]["playerId"] == player_id
        assert sum(point["selected"] for point in quadrant["points"]) == 1
        assert quadrant["xMedian"] is not None and quadrant["yMedian"] is not None


def test_crystal_v2_tier_preserves_percentile_positions_and_level_math():
    # These ranks hit the same pre-existing percentile bands; only the
    # taxonomy names have changed.
    assert tier_from_rank(1, 100).model_dump() == {
        "code": "diamond", "level": 1, "label": "Diamond", "taxonomyVersion": "crystal-v2",
    }
    assert tier_from_rank(6, 100).model_dump() == {
        "code": "emerald", "level": 1, "label": "Emerald", "taxonomyVersion": "crystal-v2",
    }
    assert tier_from_rank(13, 100).model_dump() == {
        "code": "platinum", "level": 1, "label": "Platinum", "taxonomyVersion": "crystal-v2",
    }
    assert tier_from_rank(98, 100).model_dump() == {
        "code": "bronze", "level": 2, "label": "Bronze", "taxonomyVersion": "crystal-v2",
    }


def test_v2_tier_version_is_consistent_across_leaderboard_and_player_detail():
    leaderboard = client.get("/api/v2/leaderboards", params={"season": "2025/2026", "limit": 2})
    assert leaderboard.status_code == 200
    payload = leaderboard.json()
    assert payload["meta"]["tierTaxonomyVersion"] == "crystal-v2"
    assert {player["tier"]["taxonomyVersion"] for player in payload["data"]} == {"crystal-v2"}

    player_id = payload["data"][0]["id"]
    detail = client.get(f"/api/v2/players/{player_id}", params={"season": "2025/2026", "includeAnalysis": "true"})
    assert detail.status_code == 200
    assert detail.json()["data"]["tier"]["taxonomyVersion"] == "crystal-v2"


def test_versionless_legacy_v1_tier_fixture_is_preserved_for_client_fallbacks():
    fixture = Path(__file__).parent / "fixtures" / "legacy-v1-tier.json"
    legacy = json.loads(fixture.read_text(encoding="utf-8"))
    assert legacy == {
        "code": "platinum",
        "label": "Platinum",
        "level": 2,
    }
    assert "taxonomyVersion" not in legacy
