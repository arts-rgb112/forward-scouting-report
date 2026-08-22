"""Contract tests for independently contextual native two-player comparison."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import fotmob_client
from api_server import service
from api_server.main import app
from api_server.schemas import ApiErrorEnvelope, ContextualCompareEnvelope, ContextualCompareRequest


FIXTURES = Path(__file__).parents[1] / "docs" / "fixtures" / "contextual_compare_v1"
PRODUCTION_ORIGIN = "https://forward-scouting-report-6dn7-tau.vercel.app"
PREVIEW_ORIGIN = "https://forward-scouting-report-6dn7-feature-42-messiflick.vercel.app"


def fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def side(
    *, player_id: int = 194165, taxonomy: str = "legacy-v1", season: str = "2025/2026",
    mode: str = "league", scope: int | None = 8, competition: str = "all",
) -> dict[str, object]:
    return {
        "player": {"idNamespace": "fotmob", "playerId": player_id},
        "taxonomy": taxonomy,
        "context": {"season": season, "mode": mode, "scope": scope, "competition": competition},
    }


def post(payload: dict[str, object], origin: str = PRODUCTION_ORIGIN):
    return TestClient(app).post("/api/v2/compare/contextual", headers={"Origin": origin}, json=payload)


def without_snapshot_trajectories(payload: dict[str, object]) -> dict[str, object]:
    """Keep this contextual fixture stable across additive shotmap backfills.

    Trajectories are optional source enrichment.  They are intentionally
    transported verbatim by contextual compare, but are refreshed separately
    from the context contract fixture; stripping only this optional field
    lets this test keep asserting exact context/cohort resolution without
    asking the service to rewrite current source data at read time.
    """
    normalized = deepcopy(payload)
    for side_name in ("left", "right"):
        side_payload = normalized.get(side_name)
        if not isinstance(side_payload, dict):
            continue
        detail = side_payload.get("detail")
        analysis = detail.get("analysis") if isinstance(detail, dict) else None
        spatial = analysis.get("spatial") if isinstance(analysis, dict) else None
        points = spatial.get("shotmapPoints") if isinstance(spatial, dict) else None
        if isinstance(points, list):
            for point in points:
                if isinstance(point, dict):
                    point["trajectory"] = None
    return normalized


def test_complete_league_and_europe_sides_preserve_order_and_canonical_context() -> None:
    response = post(fixture("complete_league_europe_request.json"))
    assert response.status_code == 200
    payload = response.json()
    ContextualCompareEnvelope.model_validate(payload)
    assert payload["comparisonVersion"] == "contextual-compare-v1"
    assert payload["left"]["player"]["playerId"] == 194165
    assert payload["left"]["context"] == {
        "season": "2025/2026", "mode": "league", "scope": 8, "competition": None,
    }
    assert payload["right"]["context"] == {
        "season": "2025/2026", "mode": "europe", "scope": None, "competition": "ucl",
    }
    assert payload["left"]["status"] == "resolved"
    # Europe detail/quality/quadrant builders currently use domestic static
    # inputs. Contextual compare must not relabel that data as UCL data.
    assert payload["right"]["status"] == "resolved"
    assert payload["right"]["summary"]["id"] == 194165
    assert payload["right"]["componentAvailability"] == {
        "detail": "exact_context_analysis_unavailable",
        "dataQuality": "exact_context_analysis_unavailable",
        "tacticalQuadrant": "exact_context_analysis_unavailable",
    }
    assert payload["left"]["duelPressPlayer"]["idNamespace"] == "fotmob"
    assert payload["left"]["duelPressDetailReadout"]["readoutVersion"] == "detail-readout-v1"
    assert payload["left"]["duelPressDetailReadout"]["context"] == {
        "playerId": payload["left"]["player"]["playerId"],
        "idNamespace": payload["left"]["player"]["idNamespace"],
        **payload["left"]["context"],
    }
    assert (
        payload["left"]["duelPressDetailReadout"]["player"]["id"]
        == payload["left"]["player"]["playerId"]
    )
    assert payload["left"]["tacticalQuadrant"] is not None
    assert payload["left"]["tacticalQuadrant"]["available"] is True
    assert all(payload["right"][field] is None for field in (
        "detail", "dataQuality", "tacticalQuadrant", "duelPressPlayer", "duelPressDetailReadout",
    ))
    # The endpoint transports the authoritative builders verbatim: zero,
    # unavailable, fallback, and imputed states are never re-normalised here.
    assert payload["left"]["detail"] == service.build_player_detail(
        194165, "2025/2026", "league", 8, "all",
    ).model_dump(mode="json")
    assert payload["left"]["dataQuality"] == service.build_player_data_quality(
        194165, "2025/2026", "league", 8, "all",
    ).dataQuality.model_dump(mode="json")
    assert payload["left"]["duelPressDetailReadout"] == service.find_duel_press_detail_readouts(
        194165, "2025/2026", "league", 8, "all",
    ).model_dump(mode="json")


def test_historical_contexts_are_resolved_from_their_own_cohorts() -> None:
    response = post(fixture("historical_league_request.json"))
    assert response.status_code == 200
    payload = response.json()
    assert [payload[side_name]["context"]["season"] for side_name in ("left", "right")] == [
        "2022/2023", "2024/2025",
    ]
    assert [payload[side_name]["status"] for side_name in ("left", "right")] == ["resolved", "resolved"]
    assert payload["left"]["detail"]["league"]["name"] == "Premier League"
    assert payload["right"]["detail"]["league"]["name"] == "Bundesliga"
    assert payload["left"]["duelPressDetailReadout"]["context"] == {
        "playerId": payload["left"]["player"]["playerId"],
        "idNamespace": payload["left"]["player"]["idNamespace"],
        **payload["left"]["context"],
    }
    # The fixture is an exact historical-context response.  Shot trajectories
    # are optional provider enrichment that can be backfilled independently;
    # compare must pass current values through rather than re-normalising them
    # to the fixture's older null state.
    current_points = payload["left"]["detail"]["analysis"]["spatial"]["shotmapPoints"]
    assert all(
        point["trajectory"] is None or point["trajectory"]["schemaVersion"] == "shotmap-trajectory-v1"
        for point in current_points
    )
    assert without_snapshot_trajectories(payload) == without_snapshot_trajectories(
        fixture("historical_league_response.json")
    )


def test_contextual_schema_rejects_stale_duel_readout_context_or_identity() -> None:
    malformed = deepcopy(fixture("complete_league_europe_response.json"))
    readout = malformed["left"]["duelPressDetailReadout"]
    assert isinstance(readout, dict)
    context = readout["context"]
    assert isinstance(context, dict)
    context["season"] = "2024/2025"

    with pytest.raises(ValidationError, match="duel-press readout context must match"):
        ContextualCompareEnvelope.model_validate(malformed)

    identity_mismatch = deepcopy(fixture("complete_league_europe_response.json"))
    identity_readout = identity_mismatch["left"]["duelPressDetailReadout"]
    assert isinstance(identity_readout, dict)
    identity_player = identity_readout["player"]
    assert isinstance(identity_player, dict)
    identity_player["id"] = 194166

    with pytest.raises(ValidationError, match="player identity must match context playerId"):
        ContextualCompareEnvelope.model_validate(identity_mismatch)


def test_contextual_service_rejects_a_stale_duel_readout_from_a_builder(monkeypatch) -> None:
    original_builder = service.find_duel_press_detail_readouts

    def stale_builder(*args: object):
        readout = original_builder(*args)
        assert readout is not None
        return readout.model_copy(update={
            "context": readout.context.model_copy(update={"season": "2024/2025"}),
        })

    monkeypatch.setattr(service, "find_duel_press_detail_readouts", stale_builder)
    request = ContextualCompareRequest.model_validate({
        "comparisonVersion": "contextual-compare-v1",
        "left": side(taxonomy="duel-press-v1"),
        "right": side(season="2024/2025"),
    })

    with pytest.raises(ValidationError, match="duel-press readout context must match"):
        service.resolve_contextual_compare_sides(request.left, request.right)


def test_unavailable_side_keeps_resolved_sibling_and_nulls_only_its_payload() -> None:
    payload = {"comparisonVersion": "contextual-compare-v1", "left": side(), "right": side(player_id=999999999)}
    response = post(payload)
    assert response.status_code == 200
    data = response.json()
    assert data["left"]["status"] == "resolved"
    assert data["left"]["summary"] is not None
    assert data["left"]["detail"] is not None
    assert data["right"]["status"] == "unavailable"
    assert all(data["right"][field] is None for field in (
        "summary", "detail", "dataQuality", "tacticalQuadrant", "duelPressPlayer", "duelPressDetailReadout",
    ))
    assert set(data["right"]["componentAvailability"].values()) == {"unavailable"}


@pytest.mark.parametrize("mutate", [
    lambda payload: payload.update({"comparisonVersion": "contextual-compare-v0"}),
    lambda payload: payload["left"]["player"].update({"idNamespace": "sportsapi"}),
    lambda payload: payload["left"].update({"taxonomy": "unknown-v1"}),
    lambda payload: payload["left"]["context"].update({"competition": "ucl"}),
    lambda payload: payload["right"]["context"].update({"mode": "europe", "scope": 8, "competition": "ucl"}),
    lambda payload: payload["left"].update({"extra": True}),
    lambda payload: payload.update({"right": payload["left"]}),
])
def test_strict_request_rejects_invalid_versions_dimensions_extras_and_duplicates(mutate) -> None:
    payload = {"comparisonVersion": "contextual-compare-v1", "left": side(), "right": side(season="2024/2025")}
    mutate(payload)
    assert post(payload).status_code == 422


def test_no_provider_calls_for_contextual_resolution(monkeypatch) -> None:
    service.build_v2_players.cache_clear()
    monkeypatch.setattr(fotmob_client, "_get", lambda *_: pytest.fail("contextual compare must not call FotMob"))
    payload = {
        "comparisonVersion": "contextual-compare-v1",
        "left": side(player_id=194165),
        "right": side(player_id=194165, season="2024/2025"),
    }
    assert post(payload).status_code == 200
    assert post(payload).status_code == 200


def test_europe_side_never_invokes_domestic_detail_quality_or_quadrant_builders(monkeypatch) -> None:
    def unexpected_domestic_builder(*_: object) -> None:
        pytest.fail("Europe contextual side must not reuse domestic companion data")

    monkeypatch.setattr(service, "build_player_detail", unexpected_domestic_builder)
    monkeypatch.setattr(service, "build_player_data_quality", unexpected_domestic_builder)
    monkeypatch.setattr(service, "build_tactical_quadrant_analysis", unexpected_domestic_builder)
    payload = {
        "comparisonVersion": "contextual-compare-v1",
        "left": side(taxonomy="duel-press-v1", mode="europe", scope=None, competition="ucl"),
        "right": side(player_id=194166, mode="europe", scope=None, competition="ucl"),
    }
    response = post(payload)
    assert response.status_code == 200
    payload = response.json()
    assert payload["left"]["status"] == "resolved"
    assert payload["left"]["summary"] is not None
    assert set(payload["left"]["componentAvailability"].values()) == {
        "exact_context_analysis_unavailable",
    }
    assert payload["left"]["duelPressPlayer"]["id"] == 194165
    assert payload["left"]["duelPressDetailReadout"]["context"]["mode"] == "europe"
    for resolved_side in payload.values():
        if isinstance(resolved_side, dict) and "status" in resolved_side:
            assert all(resolved_side[field] is None for field in ("detail", "dataQuality", "tacticalQuadrant"))


def test_body_limit_cors_preflight_and_hostile_origin_contract() -> None:
    client = TestClient(app)
    oversized = client.post(
        "/api/v2/compare/contextual",
        headers={"Origin": PRODUCTION_ORIGIN, "Content-Type": "application/json"},
        content=b"x" * (64 * 1024 + 1),
    )
    assert oversized.status_code == 413
    hostile = post({"comparisonVersion": "contextual-compare-v1", "left": side(), "right": side(season="2024/2025")}, "https://hostile.example")
    assert hostile.status_code == 403
    assert "access-control-allow-origin" not in hostile.headers
    for origin in (PRODUCTION_ORIGIN, PREVIEW_ORIGIN):
        preflight = client.options(
            "/api/v2/compare/contextual",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type"},
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == origin
        assert preflight.headers.get("access-control-allow-credentials") is None


def test_openapi_exposes_strict_contextual_contract_and_errors() -> None:
    schema = TestClient(app).get("/openapi.json").json()
    operation = schema["paths"]["/api/v2/compare/contextual"]["post"]
    assert {"200", "400", "403", "413", "422", "500"}.issubset(operation["responses"])
    request = schema["components"]["schemas"]["ContextualCompareRequest"]
    response = schema["components"]["schemas"]["ContextualCompareEnvelope"]
    assert request["additionalProperties"] is False
    assert response["additionalProperties"] is False
    assert request["properties"]["comparisonVersion"]["const"] == "contextual-compare-v1"
    side = schema["components"]["schemas"]["ContextualCompareSide"]
    assert "tacticalQuadrant" in side["properties"]
    assert {"summary", "componentAvailability"}.issubset(side["properties"])
    ContextualCompareRequest.model_validate(fixture("complete_league_europe_request.json"))


def test_committed_strict_response_fixtures_cover_frontend_parser_states() -> None:
    """Keep independently consumable response fixtures pinned to the strict schema."""
    complete = ContextualCompareEnvelope.model_validate(fixture("complete_league_europe_response.json"))
    historical = ContextualCompareEnvelope.model_validate(fixture("historical_league_response.json"))
    unavailable = ContextualCompareEnvelope.model_validate(fixture("unavailable_sibling_response.json"))
    states = ContextualCompareEnvelope.model_validate(fixture("observed_zero_imputed_fallback_response.json"))
    ApiErrorEnvelope.model_validate(fixture("invalid_request_error.json"))

    assert complete.left.status == complete.right.status == "resolved"
    assert complete.left.taxonomy == "duel-press-v1"
    assert complete.right.context.mode == "europe"
    assert historical.left.context.season == "2022/2023"
    assert historical.right.context.season == "2024/2025"
    assert historical.left.duelPressDetailReadout is not None
    assert historical.left.duelPressDetailReadout.context.season == "2022/2023"
    assert historical.left.duelPressDetailReadout.context.scope == 3
    assert unavailable.left.status == "resolved"
    assert unavailable.right.status == "unavailable"
    assert unavailable.right.detail is None
    readouts = {
        readout.id: readout
        for category in states.left.duelPressDetailReadout.categories
        for readout in category.readouts
    }
    assert readouts["outsideBoxShots"].value == 0
    assert readouts["outsideBoxShots"].state == "observed"
    assert readouts["inBoxShots"].state == "imputed"
    assert readouts["recoveries"].source == "league_per90_fallback"
