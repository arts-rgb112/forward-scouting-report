import pytest

from api_server.main import app
from api_server import service
from fastapi.testclient import TestClient
from spatial_duels import (
    DuelEvent, calculate_spatial_duels, duel_zone_weight, gated_cohort_scores,
    percentile_scores, positional_cell,
)


client = TestClient(app)


def test_duels_use_shared_30_zone_grid_and_danger_weights():
    assert positional_cell(5, 10) == (1, 1)
    assert positional_cell(75, 30) == (5, 2)
    assert positional_cell(90, 50) == (6, 3)
    assert duel_zone_weight(90, 50) == (1, 3.0)
    assert duel_zone_weight(75, 30) == (2, 1.5)
    assert duel_zone_weight(50, 50) == (3, 1.0)


def test_weighted_wins_per90_and_box_submetrics_are_exact():
    result = calculate_spatial_duels([
        DuelEvent("ground", True, 90, 50),
        DuelEvent("ground", True, 75, 30),
        DuelEvent("ground", False, 90, 50),
        DuelEvent("aerial", True, 50, 50),
        DuelEvent("aerial", True, 95, 60),
    ], 180)
    assert result.ground_weighted_wins == 4.5
    assert result.ground_weighted_wins_per90 == 2.25
    assert result.aerial_weighted_wins == 4.0
    assert result.aerial_weighted_wins_per90 == 2.0
    assert result.ground_box_wins == result.aerial_box_wins == 1
    assert result.box_duels_won == 2
    assert result.ground_wins_by_cell["d6l3"] == 1


def test_invalid_or_partial_coordinates_are_not_silently_dropped():
    with pytest.raises(ValueError):
        calculate_spatial_duels([DuelEvent("ground", True, 101, 50)], 90)
    with pytest.raises(ValueError):
        calculate_spatial_duels([], 0)


def test_percentile_score_uses_current_leaderboard_scale():
    assert percentile_scores({"a": 3.0, "b": 2.0, "c": 1.0}) == {
        "a": 66.67, "b": 33.33, "c": 0.0,
    }


def test_cohort_scores_require_complete_player_coverage():
    first = calculate_spatial_duels([DuelEvent("ground", True, 90, 50)], 90)
    second = calculate_spatial_duels([DuelEvent("aerial", True, 75, 30)], 90)
    assert gated_cohort_scores({"1": first}, ["1", "2"]) is None
    scores = gated_cohort_scores({"1": first, "2": second}, ["1", "2"])
    assert scores is not None
    assert scores["1"]["ground"] > scores["2"]["ground"]
    assert scores["2"]["aerial"] > scores["1"]["aerial"]


def test_api_reports_unavailable_without_fabricating_duel_coordinates():
    player = service.build_v2_players("2025/2026", "league", 7, "all")[0]
    response = client.get(
        f"/api/v2/players/{player.id}/duel-spatial",
        params={"season": "2025/2026", "mode": "league", "scope": 7},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["available"] is False
    assert data["appliedToMessiRating"] is False
    assert data["reason"] == "event_coordinates_unavailable"
    assert data["groundWeightedWinsPer90"] is None
    assert data["aerialWeightedWinsPer90"] is None
    assert data["boxDuelsWon"] is None
    assert data["gridVersion"] == "positional-6x5-v1"
