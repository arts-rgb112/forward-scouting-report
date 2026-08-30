from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from api_server.main import app
from api_server.schemas import BenchmarkRadarV2Envelope
from api_server import service


CLIENT = TestClient(app)
AXES = ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"]
FIXTURE = Path(__file__).parents[1] / "docs" / "fixtures" / "benchmark_radar_v2" / "source_cases.json"


def _league_params(season: str = "2025/2026") -> dict[str, object]:
    return {"season": season, "mode": "league", "scope": 8, "competition": "all"}


@pytest.fixture(autouse=True)
def _clear_static_frame_caches() -> None:
    """This endpoint must never inherit a monkeypatched detail-frame cache."""
    service._v2_frame_cached.cache_clear()
    service.build_benchmark_radar_v2.cache_clear()
    yield
    service._v2_frame_cached.cache_clear()
    service.build_benchmark_radar_v2.cache_clear()


def test_benchmark_radar_v2_is_strict_and_preserves_exact_v2_axis_order() -> None:
    response = CLIENT.get("/api/v2/players/194165/benchmark-radar-v2", params=_league_params())
    assert response.status_code == 200
    envelope = BenchmarkRadarV2Envelope.model_validate(response.json())
    assert envelope.benchmarkTaxonomyVersion == "benchmark-radar-v2"
    assert envelope.data.sourceContext.model_dump() == {
        "playerId": 194165, "idNamespace": "fotmob", "season": "2025/2026",
        "mode": "league", "scope": 8, "competition": None,
    }
    assert envelope.data.benchmarkContext.model_dump() == {
        "season": "2025/2026", "mode": "league", "scope": 8,
        "competition": None, "label": "8-league avg",
    }
    assert [axis.id for axis in envelope.data.volume.axes] == AXES
    assert [axis.id for axis in envelope.data.ratio.axes] == AXES
    assert envelope.data.volume.axes[4].radarOnlyRepresentation is True
    assert envelope.data.volume.axes[5].radarOnlyRepresentation is True
    assert all(axis.player.score <= 99 for axis in (*envelope.data.volume.axes, *envelope.data.ratio.axes))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture["axisOrder"] == AXES
    assert [component.id for component in envelope.data.volume.axes[5].components] == fixture["league"]["requiredComponents"]["volume.forwardPress"]


def test_benchmark_radar_v2_uses_v2_component_states_and_lower_better_direction() -> None:
    payload = CLIENT.get("/api/v2/players/194165/benchmark-radar-v2", params=_league_params()).json()
    envelope = BenchmarkRadarV2Envelope.model_validate(payload)
    danger = envelope.data.ratio.axes[2]
    failed = next(component for component in danger.components if component.id == "dribbles_failed_raw")
    assert failed.direction == "lower_is_better"
    assert failed.unit == "per90"
    duel = envelope.data.ratio.axes[3]
    assert [component.id for component in duel.components] == [
        "combined_duel_win_rate", "combined_duel_margin_per90",
        "ground_duel_win_rate", "aerial_duel_win_rate",
    ]
    press = envelope.data.volume.axes[5]
    assert [component.id for component in press.components] == ["recoveries", "final_third_possessions_won"]
    assert all(component.source in {"player_season_total", "league_per90_fallback", "unavailable"} for component in press.components)
    # The old /90 readout remains an explicit benchmark-only diagnostic.  It
    # must not be silently replaced with unified final-third/recovery ratio.
    ratio_press = envelope.data.ratio.axes[5]
    assert [component.id for component in ratio_press.components] == ["recoveries_per90", "final_third_possessions_won_per90"]


def test_benchmark_radar_v2_low_sample_position_is_never_replaced_by_global_average() -> None:
    # The 2025/26 static domestic frame has one exact raw `forward` label.
    response = CLIENT.get("/api/v2/players/967093/benchmark-radar-v2", params=_league_params())
    assert response.status_code == 200
    data = BenchmarkRadarV2Envelope.model_validate(response.json()).data
    assert data.positionReference.rawPosition == "forward"
    assert data.positionReference.population == 1
    assert data.positionReference.state == "low_sample"
    for axis in (*data.volume.axes, *data.ratio.axes):
        assert axis.positionAverage.state == "low_sample"
        assert axis.positionAverage.population == 1
        assert axis.positionAverage.reason == "position_population_below_minimum"
        assert axis.positionAverage.score is not None
        assert axis.globalAverage.population > axis.positionAverage.population


def test_benchmark_radar_v2_coach_stays_in_global_frame_but_has_no_position_reference() -> None:
    # 2023/24 contains a historical player season whose current FotMob label is Coach.
    response = CLIENT.get("/api/v2/players/179772/benchmark-radar-v2", params=_league_params("2023/2024"))
    assert response.status_code == 200
    data = BenchmarkRadarV2Envelope.model_validate(response.json()).data
    assert data.positionReference.rawPosition == "Coach"
    assert data.positionReference.state == "unavailable"
    assert data.positionReference.reason == "position_label_not_player_role"
    for axis in (*data.volume.axes, *data.ratio.axes):
        assert axis.globalAverage.population > 0
        assert axis.positionAverage.state == "unavailable"
        assert axis.positionAverage.score is None
        assert axis.positionAverage.reason == "position_label_not_player_role"


def test_benchmark_radar_v2_europe_context_omits_scope_and_rejects_explicit_scope() -> None:
    # A v2 Europe player/context is selected dynamically so the test remains static-frame driven.
    records, players, _snapshot, _ratings = service._v2_frame("2025/2026", "europe", 8, "ucl")
    assert records and players
    player_id = players[0].id
    ok = CLIENT.get(
        f"/api/v2/players/{player_id}/benchmark-radar-v2",
        params={"season": "2025/2026", "mode": "europe", "competition": "ucl"},
    )
    assert ok.status_code == 200
    assert BenchmarkRadarV2Envelope.model_validate(ok.json()).data.sourceContext.scope is None
    invalid = CLIENT.get(
        f"/api/v2/players/{player_id}/benchmark-radar-v2",
        params={"season": "2025/2026", "mode": "europe", "scope": 8, "competition": "ucl"},
    )
    assert invalid.status_code == 422


def test_benchmark_radar_v2_openapi_and_v1_benchmark_paths_remain_present() -> None:
    schema = CLIENT.get("/openapi.json").json()
    assert "/api/v2/players/{playerId}/benchmark-radar-v2" in schema["paths"]
    assert "/api/v2/players/{playerId}/volume-benchmark" in schema["paths"]
    assert "/api/v2/players/{playerId}/ratio-benchmark" in schema["paths"]
    assert schema["components"]["schemas"]["BenchmarkRadarV2Envelope"]["additionalProperties"] is False
