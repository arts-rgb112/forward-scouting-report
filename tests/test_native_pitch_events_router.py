from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from api_server.native_pitch_events_contract import build_native_pitch_envelope
from api_server.native_pitch_events_router import create_native_pitch_events_router


PATH = "/api/v2/players/194165/native-pitch-events"


def client_for(provider):
    app = FastAPI()
    app.include_router(create_native_pitch_events_router(provider, lambda: ["2025/2026"]))
    return TestClient(app)


def unavailable(context, include):
    return build_native_pitch_envelope(context, [], include_penalties=include)


def test_observed_transport_unavailable_unknown_and_pk_context():
    client = client_for(unavailable)
    for query, expected in (("", True), ("?includePenalties=false", False), ("?mode=europe&competition=uel", True)):
        response = client.get(PATH + query)
        assert response.status_code == 200, response.text
        assert response.json()["includePenalties"] is expected
        assert response.json()["bodyParts"]["totals"]["shots"] is None
        assert response.headers["cache-control"] == "no-store"
    assert client_for(lambda *_: None).get(PATH).status_code == 404


@pytest.mark.parametrize("query,status", [
    ("?wat=1", 422), ("?scope=8&scope=8", 422), ("?includePenalties=bad", 422),
    ("?includePenalties=true&includePenalties=false", 422), ("?mode=europe&scope=8", 422),
    ("?competition=ucl", 422), ("?season=2024/2025", 404), ("?season=2025/2028", 422),
])
def test_invalid_request_never_invokes_provider(query, status):
    calls = []
    response = client_for(lambda *args: calls.append(args)).get(PATH + query)
    assert response.status_code == status and calls == []


def test_corrupt_provider_sanitized_and_changed_context_filter_rejected():
    def corrupt(*_):
        raise ValueError("private source path")
    response = client_for(corrupt).get(PATH)
    assert response.status_code == 500 and "private" not in response.text
    for target in ("filter", "context", "nested"):
        def drift(context, include):
            result = unavailable(context, include)
            if target == "filter":
                result.includePenalties = not include
            elif target == "context":
                result.context.playerId = 1
                result.bodyParts.context.playerId = 1
            else:
                result.box.denominator = 7
            return result
        assert client_for(drift).get(PATH).status_code == 500


def test_production_factory_loads_native_inputs_once_without_implicit_main_mount(monkeypatch, tmp_path):
    import sys
    from types import SimpleNamespace
    from api_server import main
    from api_server.pitch_routes import create_pitch_router
    before = list(main.app.routes)
    calls = []
    constructions = []
    provider = SimpleNamespace(native_sources=lambda ctx: calls.append(ctx) or [])

    def factory(root, lookup):
        constructions.append(root)
        return provider

    monkeypatch.setitem(sys.modules, "api_server.pitch_snapshot_provider", SimpleNamespace(PitchSnapshotProvider=factory))
    app = FastAPI()
    app.include_router(create_pitch_router(tmp_path, lambda ctx: None, lambda: ["2025/2026"]))
    assert constructions == []
    client = TestClient(app)
    response = client.get(PATH + "?includePenalties=false")
    assert response.status_code == 200, response.text
    assert len(calls) == 1 and response.json()["includePenalties"] is False
    assert constructions == [tmp_path]
    assert list(main.app.routes) == before
    provider.native_sources = lambda ctx: None
    assert client.get(PATH).status_code == 404
    assert constructions == [tmp_path]


def test_production_source_configuration_error_stays_sanitized(monkeypatch, tmp_path):
    import sys
    from types import SimpleNamespace
    from api_server.pitch_routes import create_pitch_router

    def broken(*_):
        raise ValueError("private source path missing")

    monkeypatch.setitem(sys.modules, "api_server.pitch_snapshot_provider", SimpleNamespace(PitchSnapshotProvider=broken))
    app = FastAPI()
    app.include_router(create_pitch_router(tmp_path, lambda ctx: None, lambda: ["2025/2026"]))
    client = TestClient(app)
    for suffix in ("native-pitch-events", "body-part-shooting-stats", "box-subregion-stats"):
        response = client.get("/api/v2/players/194165/" + suffix)
        assert response.status_code == 500, response.text
        assert "private" not in response.text


def test_main_mounts_pitch_routes_once_and_preserves_existing_cors():
    from api_server.main import app
    paths = [getattr(route, "path", "") for route in app.routes]
    for suffix in ("native-pitch-events", "body-part-shooting-stats", "box-subregion-stats", "full-activity-heatmap"):
        assert sum(path.endswith("/" + suffix) for path in paths) == 1
    client = TestClient(app)
    allowed = client.options(PATH, headers={"Origin": "https://messi.my", "Access-Control-Request-Method": "GET"})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://messi.my"
    denied = client.options(PATH, headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in denied.headers


def test_cold_concurrent_pitch_requests_share_provider_and_leave_health_responsive(monkeypatch, tmp_path):
    import sys
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, Event
    from types import SimpleNamespace
    from api_server.pitch_routes import create_pitch_router

    entered = Event()
    release = Event()
    start = Barrier(3)
    constructions = []

    def factory(root, lookup):
        constructions.append(root)
        entered.set()
        assert release.wait(5), "test did not release cold initialization"
        return SimpleNamespace(native_sources=lambda context: [])

    monkeypatch.setitem(sys.modules, "api_server.pitch_snapshot_provider", SimpleNamespace(PitchSnapshotProvider=factory))
    app = FastAPI()
    app.include_router(create_pitch_router(tmp_path, lambda context: None, lambda: ["2025/2026"]))

    @app.get("/health")
    async def health():
        return {"ok": True}

    with TestClient(app) as client, ThreadPoolExecutor(max_workers=3) as pool:
        def request():
            start.wait(timeout=5)
            return client.get(PATH)

        requests = [pool.submit(request) for _ in range(2)]
        try:
            start.wait(timeout=5)
            assert entered.wait(5)
            # Same ASGI app/event loop must serve health during blocked decode.
            health_response = pool.submit(client.get, "/health").result(timeout=2)
            assert health_response.status_code == 200
            assert health_response.json() == {"ok": True}
        finally:
            release.set()
        for pending in requests:
            response = pending.result(timeout=5)
            assert response.status_code == 200, response.text
        assert constructions == [tmp_path]
