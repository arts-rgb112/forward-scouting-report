from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from api_server.main import app
from api_server.schemas import VolumeBenchmarkAxis, VolumeBenchmarkData, VolumeBenchmarkEnvelope


CLIENT = TestClient(app)
PRODUCTION_ORIGIN = "https://forward-scouting-report-6dn7-tau.vercel.app"
PREVIEW_ORIGIN = "https://forward-scouting-report-6dn7-feature-42-messiflick.vercel.app"
AXIS_IDS = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"]
FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "volume_benchmark_v1"


def benchmark_params(**overrides: str) -> dict[str, str]:
    return {
        "season": "2025/2026", "mode": "league", "scope": "8",
        "competition": "all", "benchmarkScope": "8", **overrides,
    }


def test_strict_fixtures_cover_success_unavailable_and_zero_vs_null() -> None:
    for name in ("success.json", "unavailable.json", "observed_zero.json"):
        VolumeBenchmarkEnvelope.model_validate(json.loads((FIXTURES / name).read_text(encoding="utf-8")))


def test_scope_8_volume_benchmark_has_six_actual_average_axes() -> None:
    response = CLIENT.get(
        "/api/v2/players/194165/volume-benchmark",
        params=benchmark_params(), headers={"Origin": PRODUCTION_ORIGIN},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == "1.0.0"
    data = payload["data"]
    assert data["sourceContext"] == {"mode": "league", "scope": 8, "competition": None}
    assert data["benchmark"] == {"label": "8-league avg", "mode": "league", "scope": 8}
    assert data["available"] is True
    assert [axis["id"] for axis in data["axes"]] == AXIS_IDS
    for axis in data["axes"]:
        assert 0 <= axis["playerScore"] <= 100
        assert 0 <= axis["averageScore"] <= 100
        assert axis["population"] > 0
        assert axis["playerRank"] is not None
        assert axis["playerRank"] <= axis["population"]
        assert axis["imputed"] is False
    assert any(axis["averageScore"] != 50 for axis in data["axes"])
    assert response.headers["access-control-allow-origin"] == PRODUCTION_ORIGIN


def test_scope_8_player_detail_analysis_remains_a_strict_200_envelope() -> None:
    response = CLIENT.get(
        "/api/v2/players/194165",
        params={
            "season": "2025/2026", "mode": "league", "scope": "8",
            "competition": "all", "includeAnalysis": "true",
        },
        headers={"Origin": PREVIEW_ORIGIN},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["id"] == 194165
    assert set(data["analysis"]) == {"score", "volumeRadar", "ratioRadar", "rawMetrics", "spatial"}
    assert response.headers["access-control-allow-origin"] == PREVIEW_ORIGIN


def test_europe_context_echoes_its_competition_but_uses_eight_league_benchmark() -> None:
    params = benchmark_params(mode="europe", competition="ucl")
    params.pop("scope")
    response = CLIENT.get(
        "/api/v2/players/194165/volume-benchmark",
        params=params,
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["sourceContext"] == {"mode": "europe", "scope": None, "competition": "ucl"}
    assert data["benchmark"]["scope"] == 8
    assert [axis["id"] for axis in data["axes"]] == AXIS_IDS


def test_invalid_scope_and_benchmark_scope_are_422() -> None:
    invalid_benchmark = CLIENT.get(
        "/api/v2/players/194165/volume-benchmark",
        params=benchmark_params(benchmarkScope="7"),
    )
    assert invalid_benchmark.status_code == 422

    missing_benchmark = CLIENT.get(
        "/api/v2/players/194165/volume-benchmark",
        params={key: value for key, value in benchmark_params().items() if key != "benchmarkScope"},
    )
    assert missing_benchmark.status_code == 422

    europe_with_scope = CLIENT.get(
        "/api/v2/players/194165/volume-benchmark",
        params=benchmark_params(mode="europe", scope="8", competition="ucl"),
    )
    assert europe_with_scope.status_code == 422


def test_hostile_origin_has_no_cors_header_and_preview_is_allowed() -> None:
    hostile = CLIENT.get(
        "/api/v2/players/194165/volume-benchmark",
        params=benchmark_params(), headers={"Origin": "https://hostile.example"},
    )
    assert hostile.status_code == 200
    assert "access-control-allow-origin" not in hostile.headers

    preview = CLIENT.options(
        "/api/v2/players/194165/volume-benchmark",
        headers={
            "Origin": PREVIEW_ORIGIN,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert preview.status_code == 200
    assert preview.headers["access-control-allow-origin"] == PREVIEW_ORIGIN


def test_observed_zero_and_imputed_null_are_distinct() -> None:
    observed_zero = VolumeBenchmarkAxis(
        id="outsideShot", label="Outside-box shot attempts", playerScore=0,
        averageScore=50, playerRawValue=0, averageRawValue=1, playerRank=10,
        population=10, tier="D", imputed=False,
    )
    missing = VolumeBenchmarkAxis(
        id="boxThreat", label="Box hits", playerScore=20, averageScore=50,
        playerRawValue=None, averageRawValue=1, playerRank=None, population=10,
        tier="D", imputed=True,
    )
    assert observed_zero.playerRawValue == 0 and observed_zero.imputed is False
    assert missing.playerRawValue is None and missing.imputed is True


def test_unavailable_contract_has_empty_axes() -> None:
    unavailable = VolumeBenchmarkData.model_validate({
        "playerId": 1, "season": "2025/2026",
        "sourceContext": {"mode": "europe", "scope": None, "competition": "ucl"},
        "benchmark": {"label": "8-league avg", "mode": "league", "scope": 8},
        "available": False, "reason": "benchmark_source_unavailable", "axes": [],
    })
    assert unavailable.axes == []


def test_available_reason_and_unavailable_reason_cannot_be_mixed() -> None:
    base = {
        "playerId": 1,
        "idNamespace": "fotmob",
        "season": "2025/2026",
        "sourceContext": {"mode": "europe", "scope": None, "competition": "ucl"},
        "benchmark": {"label": "8-league avg", "mode": "league", "scope": 8},
    }
    with pytest.raises(ValidationError):
        VolumeBenchmarkData.model_validate({
            **base, "available": False, "reason": "complete", "axes": [],
        })
    with pytest.raises(ValidationError):
        VolumeBenchmarkData.model_validate({
            **base, "available": True, "reason": "benchmark_source_unavailable", "axes": [],
        })
