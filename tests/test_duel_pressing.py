from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from api_server.main import app
from metrics import DecisionMetrics, extract_multi_season_metrics


def test_player_stats_parse_pressing_totals_and_per90() -> None:
    payload = {
        "base": {"primaryPosition": {"key": "forward", "label": "Forward"}},
        "season_records": [{
            "season": "2025/2026",
            "league_id": 47,
            "league_name": "Premier League",
            "stats": {
                "groups": [{
                    "items": [
                        {"title": "Goals", "statValue": "4"},
                        {"title": "Expected goals (xG)", "statValue": "3.2"},
                        {"title": "Minutes played", "statValue": "900"},
                        {"title": "Recoveries", "statValue": "80"},
                        {"title": "Possession won final 3rd", "statValue": "12"},
                    ],
                }],
                "shotmap": [],
            },
        }],
    }

    metric = extract_multi_season_metrics(payload)["25/26_47"]

    assert metric.recoveries == 80
    assert metric.recoveries_per90 == pytest.approx(8.0)
    assert metric.recoveries_source == "player_season_total"
    assert metric.final_third_possessions_won == 12
    assert metric.final_third_possessions_won_per90 == pytest.approx(1.2)
    assert metric.final_third_possessions_won_source == "player_season_total"


def test_per90_is_unavailable_without_minutes_and_zero_is_observed() -> None:
    missing_minutes = DecisionMetrics(recoveries=10, final_third_possessions_won=2)
    assert missing_minutes.recoveries_per90 is None
    assert missing_minutes.final_third_possessions_won_per90 is None

    observed_zero = DecisionMetrics(
        minutes_played=900, recoveries=0, final_third_possessions_won=0,
    )
    assert observed_zero.recoveries_per90 == 0
    assert observed_zero.final_third_possessions_won_per90 == 0
    assert observed_zero.forward_press_concentration is None


def test_score_ratio_properties_keep_directional_denominators_strict() -> None:
    metric = DecisionMetrics(
        minutes_played=900,
        recoveries=20,
        final_third_possessions_won=5,
        out_box_goals=2,
        out_box_shots=10,
    )
    assert metric.forward_press_concentration == pytest.approx(0.25)
    assert metric.out_box_goal_conversion == pytest.approx(0.2)
    assert DecisionMetrics(recoveries=0, final_third_possessions_won=0).forward_press_concentration is None
    assert DecisionMetrics(out_box_goals=0, out_box_shots=0).out_box_goal_conversion is None


def test_net_progression_excludes_ground_and_aerial_duel_events() -> None:
    base = DecisionMetrics(
        minutes_played=900,
        dribbles_succeeded=10,
        dribbles_success_rate=50,
        fouls_won=2,
        penalties_awarded=1,
        dispossessed=3,
        duels_won=5,
        duels_won_percentage=50,
        aerial_duels_won=4,
        aerial_duels_won_percentage=50,
    )
    altered_duels = DecisionMetrics(
        **{**base.__dict__, "duels_won": 20, "aerial_duels_won": 16}
    )
    assert base.net_progression_per90 == pytest.approx(0.0)
    assert altered_duels.net_progression_per90 == pytest.approx(base.net_progression_per90)


def test_opt_in_contract_keeps_legacy_endpoint_unchanged() -> None:
    client = TestClient(app)
    legacy = client.get(
        "/api/v2/leaderboards",
        params={"season": "2025/2026", "scope": 8, "page": 1, "pageSize": 1},
    )
    pressing = client.get(
        "/api/v2/leaderboards/duel-press",
        params={"season": "2025/2026", "scope": 8, "page": 1, "pageSize": 50},
    )

    assert legacy.status_code == 200
    assert pressing.status_code == 200
    assert set(legacy.json()["data"][0]["stats"]) == {
        "outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel",
        "spaceControl",
    }
    payload = pressing.json()
    assert payload["metricTaxonomyVersion"] == "duel-press-v1"
    assert "metricTaxonomyVersion" not in payload["meta"]
    assert set(payload["data"][0]["stats"]) == {
        "outsideShot", "boxThreat", "dangerZone", "combinedDuel",
        "spaceControl", "forwardPress",
    }
    assert set(payload["data"][0]["components"]) == {
        "combinedDuelVolume", "combinedDuelEfficiency", "recoveries",
        "finalThirdPossessionsWon",
    }
    player = payload["data"][0]
    assert player["idNamespace"] == "fotmob"
    assert "metricTaxonomyVersion" not in player
    assert player["stats"]["combinedDuel"] == pytest.approx(
        0.5 * player["components"]["combinedDuelVolume"]
        + 0.5 * player["components"]["combinedDuelEfficiency"],
        abs=0.02,
    )
    # The forward-press ratio half is now final-third recoveries / all
    # recoveries, not the former final-third-possession-won per-90 component.
    # That per-90 component remains public for the legacy readout, while the
    # score is calculated from the strict directional denominator server-side.
    assert 0.0 <= player["stats"]["forwardPress"] <= 100.0
    assert player["stats"]["forwardPress"] != pytest.approx(
        0.5 * player["components"]["recoveries"]
        + 0.5 * player["components"]["finalThirdPossessionsWon"],
        abs=0.02,
    )
    assert player["score"] == pytest.approx(
        0.30 * player["stats"]["boxThreat"]
        + 0.20 * player["stats"]["outsideShot"]
        + 0.15 * player["stats"]["dangerZone"]
        + 0.15 * player["stats"]["spaceControl"]
        + 0.10 * player["stats"]["combinedDuel"]
        + 0.10 * player["stats"]["forwardPress"],
        abs=0.02,
    )


def test_opt_in_openapi_documents_both_endpoints() -> None:
    schema = TestClient(app).get("/openapi.json").json()
    assert "/api/v2/leaderboards/duel-press" in schema["paths"]
    assert "/api/v2/players/{playerId}/duel-press" in schema["paths"]
    player_schema = schema["components"]["schemas"]["DuelPressPlayerStats"]
    assert set(player_schema["required"]) == {
        "outsideShot", "boxThreat", "dangerZone", "combinedDuel",
        "spaceControl", "forwardPress",
    }
    leaderboard_schema = schema["components"]["schemas"]["DuelPressLeaderboardEnvelope"]
    detail_schema = schema["components"]["schemas"]["DuelPressPlayerEnvelope"]
    assert "metricTaxonomyVersion" in leaderboard_schema["properties"]
    assert "metricTaxonomyVersion" in detail_schema["properties"]
    assert "context" in detail_schema["required"]
