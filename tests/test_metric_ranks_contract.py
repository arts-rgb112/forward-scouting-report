from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from api_server import service
from api_server.main import app
from api_server.schemas import MetricRanksEnvelope, MetricRanksRequest


FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "metric_ranks_v1"
PRODUCTION_ORIGIN = "https://forward-scouting-report-6dn7-tau.vercel.app"
CUSTOM_DOMAIN_ORIGIN = "https://messi.my"
PREVIEW_ORIGIN = "https://forward-scouting-report-6dn7-feature-42-messiflick.vercel.app"


def fixture(name: str) -> object:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def entry(key: str, player_id: int = 194165, **context: object) -> dict[str, object]:
    return {
        "key": key,
        "player": {"idNamespace": "fotmob", "playerId": player_id},
        "metricTaxonomyVersion": "duel-press-v1",
        "context": {
            "season": "2025/2026", "mode": "league", "scope": 8,
            "competition": "all", **context,
        },
    }


def post(entries: list[dict[str, object]], origin: str = PRODUCTION_ORIGIN):
    return TestClient(app).post(
        "/api/v2/metric-ranks", headers={"Origin": origin}, json={"entries": entries},
    )


def test_contract_fixtures_are_strict_and_allow_null_metric_ranks() -> None:
    MetricRanksEnvelope.model_validate(fixture("valid_response.json"))
    null_fixture = MetricRanksEnvelope.model_validate(fixture("null_metric.json"))
    assert null_fixture.results[0].metrics is not None
    assert null_fixture.results[0].metrics.outsideShot.rank is None

    with pytest.raises(ValidationError):
        MetricRanksEnvelope.model_validate(fixture("invalid_extra_field.json"))


def test_resolved_metrics_echo_context_and_use_exactly_six_fields() -> None:
    submitted = [
        entry("kane-league"),
        entry(
            "kane-ucl", mode="europe", scope=None, competition="ucl",
        ),
    ]
    response = post(submitted)
    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == "1.0.0"
    assert [result["key"] for result in payload["results"]] == ["kane-league", "kane-ucl"]
    for expected, result in zip(submitted, payload["results"], strict=True):
        assert result["player"] == expected["player"]
        assert result["context"] == expected["context"]
        assert result["metricTaxonomyVersion"] == "duel-press-v1"
        assert result["status"] == "resolved"
        assert set(result["metrics"]) == {
            "outsideShot", "boxThreat", "dangerZone", "combinedDuel",
            "spaceControl", "forwardPress",
        }
        for metric in result["metrics"].values():
            assert metric["population"] >= 0
            assert 1 <= metric["rank"] <= metric["population"]


def test_unavailable_and_invalid_context_are_isolated_with_null_metrics() -> None:
    response = post([
        entry("available"),
        entry("missing-player", player_id=999999999),
        entry("unsupported-season", season="2020/2021"),
    ])
    assert response.status_code == 200
    results = response.json()["results"]
    assert [result["status"] for result in results] == [
        "resolved", "unavailable", "invalid_context",
    ]
    assert results[1]["metrics"] is None
    assert results[2]["metrics"] is None
    assert results[2]["context"]["season"] == "2020/2021"


def test_duplicate_keys_extra_fields_and_excess_entries_are_422() -> None:
    duplicate = post([entry("duplicate"), entry("duplicate", player_id=194165)])
    assert duplicate.status_code == 422

    body = {"entries": [entry("extra")]}
    body["entries"][0]["extra"] = True
    extra = TestClient(app).post(
        "/api/v2/metric-ranks", headers={"Origin": PRODUCTION_ORIGIN}, json=body,
    )
    assert extra.status_code == 422

    too_many = post([entry(f"entry-{index}") for index in range(51)])
    assert too_many.status_code == 422


def test_body_limit_is_413_and_hostile_origin_gets_no_cors_header() -> None:
    oversized = TestClient(app).post(
        "/api/v2/metric-ranks",
        headers={"Origin": PRODUCTION_ORIGIN, "Content-Type": "application/json"},
        content=b"x" * (64 * 1024 + 1),
    )
    assert oversized.status_code == 413

    hostile = post([entry("hostile")], origin="https://hostile.example")
    assert hostile.status_code == 403
    assert "access-control-allow-origin" not in hostile.headers


@pytest.mark.parametrize("origin", [PRODUCTION_ORIGIN, CUSTOM_DOMAIN_ORIGIN, PREVIEW_ORIGIN])
def test_post_preflight_allows_dashboard_origins_and_approved_preview(origin: str) -> None:
    response = TestClient(app).options(
        "/api/v2/metric-ranks",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers.get("access-control-allow-credentials") is None


def test_custom_domain_can_submit_metric_ranks() -> None:
    response = post([entry("messi-my")], origin=CUSTOM_DOMAIN_ORIGIN)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == CUSTOM_DOMAIN_ORIGIN


def test_batch_groups_same_context_without_n_plus_one(monkeypatch) -> None:
    service._duel_press_metric_rank_maps.cache_clear()
    original = service.build_duel_press_players
    calls: list[tuple[object, ...]] = []

    def observed(*args):
        calls.append(args)
        return original(*args)

    monkeypatch.setattr(service, "build_duel_press_players", observed)
    request = MetricRanksRequest.model_validate({
        "entries": [entry("first"), entry("second"), entry("third")],
    })
    results = service.resolve_metric_rank_entries(request.entries)
    assert len(calls) == 1
    assert [result.key for result in results] == ["first", "second", "third"]


def test_openapi_declares_strict_schema_and_error_contract() -> None:
    schema = TestClient(app).get("/openapi.json").json()
    operation = schema["paths"]["/api/v2/metric-ranks"]["post"]
    assert {"200", "413", "422"}.issubset(operation["responses"])
    envelope = schema["components"]["schemas"]["MetricRanksEnvelope"]
    assert envelope["additionalProperties"] is False
    assert envelope["properties"]["schemaVersion"]["const"] == "1.0.0"
    metrics = schema["components"]["schemas"]["DuelPressMetricRanks"]
    assert metrics["additionalProperties"] is False
    assert set(metrics["required"]) == {
        "outsideShot", "boxThreat", "dangerZone", "combinedDuel",
        "spaceControl", "forwardPress",
    }
