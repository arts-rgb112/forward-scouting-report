import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api_server.native_pitch_v2_contract import build_native_pitch_v2_envelope
from api_server.native_pitch_v2_router import create_native_pitch_v2_router
from tests.test_native_pitch_v2_contract import context, provider_examples, source


PATH = "/api/v2/players/194165/native-pitch-events-v2"
ROUTE_TEMPLATE = "/api/v2/players/{playerId}/native-pitch-events-v2"


def app():
    api = FastAPI()
    api.include_router(create_native_pitch_v2_router(
        lambda value, include: build_native_pitch_v2_envelope(value, [source(list(provider_examples()))], include_penalties=include),
        lambda: ["2025/2026"],
    ))
    return api


def test_v2_router_enforces_same_context_query_rules_and_no_store():
    client = TestClient(app())
    response = client.get(PATH)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["schemaVersion"] == "native-pitch-events-v2"
    assert len(body["selectionZones"]["grid"]) == 30 and len(body["selectionZones"]["box"]) == 4
    for query in ("?unexpected=1", "?scope=8&scope=7", "?mode=europe&scope=8", "?competition=ucl"):
        assert client.get(PATH + query).status_code == 422
    assert client.get(PATH + "?season=2024/2025").status_code == 404


def test_v2_terminal_fixture_is_realized_by_strict_response():
    fixture = Path(__file__).resolve().parents[1] / "docs/fixtures/native_pitch_v2/source_terminal_cases.json"
    cases = json.loads(fixture.read_text(encoding="utf-8"))["cases"]
    body = TestClient(app()).get(PATH).json()
    by_id = {event["identity"]["shotId"]: event for event in body["events"]}
    for expected in cases:
        event = by_id[expected["shotId"]]
        destination = event["destination"]
        assert event["shotType"] == expected["shotType"]
        assert destination["kind"] == expected["expectedKind"]
        for key in ("expectedX", "expectedY", "expectedReason"):
            if key in expected:
                assert destination[{"expectedX": "x", "expectedY": "y", "expectedReason": "reason"}[key]] == expected[key]
        assert destination["observedHeightMeters"] is None


def test_production_pitch_router_registers_v2_without_building_source_at_mount():
    from api_server.pitch_routes import create_pitch_router

    root = Path(__file__).resolve().parents[1] / "data"
    router = create_pitch_router(root, lambda _context: None, lambda: ["2025/2026"])
    assert ROUTE_TEMPLATE in {route.path for route in router.routes}
