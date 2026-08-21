from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api_server.main import app
from api_server import service
from api_server.schemas import (
    RatioBenchmarkData,
    RatioBenchmarkEnvelope,
    TacticalSummaryData,
    TacticalSummaryEnvelope,
)


CLIENT = TestClient(app)
PRODUCTION_ORIGIN = "https://forward-scouting-report-6dn7-tau.vercel.app"
PREVIEW_ORIGIN = "https://forward-scouting-report-6dn7-feature-42-messiflick.vercel.app"
AXIS_IDS = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"]
LINE_IDS = ["positioning", "movement", "activity"]
FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures"


def params(**overrides: str) -> dict[str, str]:
    return {
        "season": "2025/2026", "mode": "league", "scope": "8",
        "competition": "all", **overrides,
    }


def ratio_params(**overrides: str) -> dict[str, str]:
    return {**params(), "benchmarkScope": "8", **overrides}


def test_authoritative_fixtures_validate_full_strict_envelopes() -> None:
    for name in ("complete.json", "partial_source_imputed.json", "unavailable.json"):
        TacticalSummaryEnvelope.model_validate(json.loads(
            (FIXTURES / "tactical_summary_v1" / name).read_text(encoding="utf-8")
        ))
    for name in ("success.json", "unavailable.json", "observed_zero_imputed.json"):
        RatioBenchmarkEnvelope.model_validate(json.loads(
            (FIXTURES / "ratio_benchmark_v1" / name).read_text(encoding="utf-8")
        ))


def test_tactical_summary_returns_exact_ordered_backend_lines() -> None:
    response = CLIENT.get(
        "/api/v2/players/194165/tactical-summary",
        params=params(), headers={"Origin": PRODUCTION_ORIGIN},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == "1.0.0"
    data = payload["data"]
    assert data["sourceContext"] == {"mode": "league", "scope": 8, "competition": None}
    if data["available"]:
        assert [line["id"] for line in data["lines"]] == LINE_IDS
        assert len(data["lines"]) == 3
        assert data["reason"] in {"complete", "partial_source_imputed"}
        assert all(line["text"] for line in data["lines"])
        assert any(line["imputed"] for line in data["lines"]) is (data["reason"] == "partial_source_imputed")
    else:
        assert data["reason"] == "summary_source_unavailable" and data["lines"] == []
    assert response.headers["access-control-allow-origin"] == PRODUCTION_ORIGIN


def test_ratio_benchmark_has_six_actual_eight_league_axes() -> None:
    response = CLIENT.get(
        "/api/v2/players/194165/ratio-benchmark",
        params=ratio_params(), headers={"Origin": PREVIEW_ORIGIN},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["sourceContext"] == {"mode": "league", "scope": 8, "competition": None}
    assert data["benchmark"] == {"label": "8-league avg", "mode": "league", "scope": 8, "kind": "ratio"}
    if data["available"]:
        assert [axis["id"] for axis in data["axes"]] == AXIS_IDS
        assert all(0 <= axis["playerScore"] <= 100 and 0 <= axis["averageScore"] <= 100 for axis in data["axes"])
        assert all(axis["playerRank"] is None or axis["playerRank"] <= axis["population"] for axis in data["axes"])
        assert any(axis["averageScore"] != 50 for axis in data["axes"])
    else:
        assert data["reason"] == "benchmark_source_unavailable" and data["axes"] == []
    assert response.headers["access-control-allow-origin"] == PREVIEW_ORIGIN


def test_ratio_benchmark_requires_scope_8_and_europe_omits_scope() -> None:
    base = "/api/v2/players/194165/ratio-benchmark"
    omitted = CLIENT.get(base, params=params())
    assert omitted.status_code == 422
    invalid = CLIENT.get(base, params=ratio_params(benchmarkScope="7"))
    assert invalid.status_code == 422
    europe_params = ratio_params(mode="europe", competition="ucl")
    europe_params.pop("scope")
    europe = CLIENT.get(base, params=europe_params)
    assert europe.status_code == 200
    assert europe.json()["data"]["sourceContext"] == {"mode": "europe", "scope": None, "competition": "ucl"}
    invalid_scope = CLIENT.get(base, params=ratio_params(mode="europe", competition="ucl"))
    assert invalid_scope.status_code == 422


def test_all_league_scopes_echo_the_selected_context() -> None:
    for scope in ("3", "5", "7", "8"):
        leaderboard = CLIENT.get("/api/v2/leaderboards", params=params(scope=scope, pageSize="1"))
        assert leaderboard.status_code == 200
        player_id = leaderboard.json()["data"][0]["id"]
        response = CLIENT.get(
            f"/api/v2/players/{player_id}/tactical-summary", params=params(scope=scope),
        )
        assert response.status_code == 200
        assert response.json()["data"]["sourceContext"] == {
            "mode": "league", "scope": int(scope), "competition": None,
        }
        ratio = CLIENT.get(
            f"/api/v2/players/{player_id}/ratio-benchmark", params=ratio_params(scope=scope),
        )
        assert ratio.status_code == 200
        assert ratio.json()["data"]["sourceContext"] == {
            "mode": "league", "scope": int(scope), "competition": None,
        }


def test_missing_tactical_session_is_explicitly_unavailable() -> None:
    with patch("api_server.service.get_tactical_ratio_for_session", return_value=None):
        service.build_tactical_summary.cache_clear()
        summary = service.build_tactical_summary(194165, "2025/2026", "league", 8, "all")
    service.build_tactical_summary.cache_clear()
    assert summary is not None
    assert summary.available is False
    assert summary.reason == "summary_source_unavailable"
    assert summary.lines == []


def test_malformed_state_order_and_extra_fields_are_rejected() -> None:
    tactical = {
        "playerId": 1, "idNamespace": "fotmob", "season": "2025/2026",
        "sourceContext": {"mode": "league", "scope": 8, "competition": None},
        "available": True, "reason": "complete",
        "lines": [
            {"id": "movement", "text": "x", "imputed": False},
            {"id": "positioning", "text": "x", "imputed": False},
            {"id": "activity", "text": "x", "imputed": False},
        ],
    }
    with pytest.raises(ValidationError):
        TacticalSummaryData.model_validate(tactical)
    tactical["lines"] = []
    tactical["available"] = False
    with pytest.raises(ValidationError):
        TacticalSummaryData.model_validate(tactical)

    ratio = json.loads((FIXTURES / "ratio_benchmark_v1" / "success.json").read_text(encoding="utf-8"))["data"]
    ratio["axes"][0]["unexpected"] = True
    with pytest.raises(ValidationError):
        RatioBenchmarkData.model_validate(ratio)


def test_hostile_and_lookalike_origins_receive_no_cors_headers() -> None:
    for origin in ("https://hostile.example", "https://forward-scouting-report-6dn7-x-messiflick.vercel.app.evil.example"):
        response = CLIENT.get(
            "/api/v2/players/194165/tactical-summary",
            params=params(), headers={"Origin": origin},
        )
        assert response.status_code == 200
        assert "access-control-allow-origin" not in response.headers


def test_openapi_documents_new_additive_companions() -> None:
    schema = CLIENT.get("/openapi.json").json()
    paths = schema["paths"]
    assert "/api/v2/players/{playerId}/tactical-summary" in paths
    assert "/api/v2/players/{playerId}/ratio-benchmark" in paths
    components = schema["components"]["schemas"]
    assert "TacticalSummaryEnvelope" in components
    assert "RatioBenchmarkEnvelope" in components
    TacticalSummaryEnvelope.model_validate(components["TacticalSummaryEnvelope"]["examples"][0])
    RatioBenchmarkEnvelope.model_validate(components["RatioBenchmarkEnvelope"]["examples"][0])
