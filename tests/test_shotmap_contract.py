from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api_server.main import app
from api_server.schemas import SpatialAnalysis
from api_server import service


client = TestClient(app, raise_server_exceptions=False)


def spatial_payload(**shotmap: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "available": True,
        "heatmapPointCount": 0,
        "heatmapPoints": [],
        "shotmapPointCount": 0,
        "shotmapPoints": [],
        "shotmapSnapshotAvailable": False,
        "trueCore": {
            "available": False,
            "achievedDensityPct": 0,
            "zoneIds": [],
            "zoneCount": 0,
            "coreAreaPct": 0,
            "zones": [],
        },
        "continuousCore": {
            "available": False,
            "achievedDensityPct": 0,
            "coreAreaPct": 0,
            "densityThreshold": 0,
            "thresholdOfPeak": 0,
        },
    }
    payload.update(shotmap)
    return payload


def detail_context() -> tuple[int, dict[str, object]]:
    context: dict[str, object] = {
        "season": "2025/2026", "mode": "league", "scope": 8,
        "competition": "all",
    }
    leaderboard = client.get(
        "/api/v2/leaderboards", params={**context, "limit": 2},
    )
    assert leaderboard.status_code == 200
    return leaderboard.json()["data"][0]["id"], context


def test_valid_populated_shotmap_contract() -> None:
    model = SpatialAnalysis.model_validate(spatial_payload(
        shotmapSnapshotAvailable=True,
        shotmapPointCount=1,
        shotmapPoints=[{
            "x": 90.0, "y": 50.0, "outcome": "goal", "xg": 0.4, "xgot": 0.8,
        }],
    ))

    assert model.shotmapPointCount == len(model.shotmapPoints) == 1
    assert model.shotmapSnapshotAvailable is True


def test_valid_unavailable_shotmap_contract() -> None:
    model = SpatialAnalysis.model_validate(spatial_payload())

    assert model.shotmapSnapshotAvailable is False
    assert model.shotmapPointCount == 0 and model.shotmapPoints == []


def test_valid_available_empty_shotmap_contract() -> None:
    model = SpatialAnalysis.model_validate(spatial_payload(
        shotmapSnapshotAvailable=True,
    ))

    assert model.shotmapSnapshotAvailable is True
    assert model.shotmapPointCount == 0 and model.shotmapPoints == []


@pytest.mark.parametrize(
    ("snapshot", "expected_available", "expected_count"),
    [
        ((False, []), False, 0),
        ((True, []), True, 0),
        ((True, [{
            "x": 90.0, "y": 50.0, "outcome": "on_target", "xg": 0.2, "xgot": 0.5,
        }]), True, 1),
    ],
)
def test_service_preserves_each_valid_shotmap_state(
    snapshot: tuple[bool, list[dict[str, object]]],
    expected_available: bool,
    expected_count: int,
) -> None:
    with (
        patch("api_server.service.get_heatmap_points", return_value=[]),
        patch("api_server.service.get_shotmap_snapshot", return_value=snapshot),
    ):
        spatial = service._spatial_analysis(1, {"heatmap_key": "1:38:10"})

    assert spatial.shotmapSnapshotAvailable is expected_available
    assert spatial.shotmapPointCount == len(spatial.shotmapPoints) == expected_count


@pytest.mark.parametrize(
    "override",
    [
        {"shotmapSnapshotAvailable": True, "shotmapPointCount": 0, "shotmapPoints": [{
            "x": 90.0, "y": 50.0, "outcome": "goal",
        }]},
        {"shotmapSnapshotAvailable": False, "shotmapPointCount": 1, "shotmapPoints": [{
            "x": 90.0, "y": 50.0, "outcome": "goal",
        }]},
    ],
)
def test_malformed_shotmap_contract_is_rejected(override: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        SpatialAnalysis.model_validate(spatial_payload(**override))


def test_malformed_source_record_returns_explicit_detail_and_compare_errors() -> None:
    player_id, context = detail_context()
    leaderboard = client.get(
        "/api/v2/leaderboards", params={**context, "limit": 2},
    ).json()["data"]
    player_ids = [row["id"] for row in leaderboard]
    malformed_source = [{"x": "not-a-coordinate", "outcome": "goal"}]

    service.build_player_detail.cache_clear()
    try:
        with patch(
            "api_server.service.get_shotmap_snapshot",
            return_value=(True, malformed_source),
        ):
            detail = client.get(
                f"/api/v2/players/{player_id}",
                params={**context, "includeAnalysis": "true"},
            )
            comparison = client.get(
                "/api/v2/compare",
                params={**context, "players": ",".join(map(str, player_ids))},
            )
    finally:
        service.build_player_detail.cache_clear()

    for response in (detail, comparison):
        assert response.status_code == 500
        assert response.json()["detail"]["code"] == "shotmap_contract_violation"
        assert "invalid record" in response.json()["detail"]["message"]


def test_openapi_documents_shotmap_states_and_service_error() -> None:
    schema = client.get("/openapi.json").json()
    spatial = schema["components"]["schemas"]["SpatialAnalysis"]["properties"]

    assert "verified zero-shot" in spatial["shotmapSnapshotAvailable"]["description"]
    assert "Exact number" in spatial["shotmapPointCount"]["description"]
    assert "ShotmapServiceErrorEnvelope" in schema["components"]["schemas"]
    for path in ("/api/v2/players/{player_id}", "/api/v2/compare"):
        error_schema = schema["paths"][path]["get"]["responses"]["500"]["content"]["application/json"]["schema"]
        assert error_schema["$ref"].endswith("/ShotmapServiceErrorEnvelope")
