import copy
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api_server.box_subregion_contract import BoxContext
from api_server.full_activity_display_core import build_full_activity_display_envelope
from api_server.full_activity_display_router import create_full_activity_display_router


REPO = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((REPO / "docs" / "fixtures" / "full_activity_display_v1" / "kane_2025_2026_expected.json").read_text(encoding="utf-8"))
PATH = "/api/v2/players/194165/full-activity-display-v1"


def context() -> BoxContext:
    return BoxContext(playerId=194165, season="2025/2026", mode="league", scope=8, competition=None)


def mapping() -> dict[str, str]:
    return {
        "fotmob_player_id": "194165", "sportsapi_player_id": "108579",
        "tournament_id": "35", "season_id": "77333", "heatmap_key": "194165:35:77333",
    }


def raw(points=None):
    return {"data": {"points": points if points is not None else [
        {"x": 10.0, "y": 20.0, "count": 2}, {"x": 90.0, "y": 80.0, "count": 3},
    ]}}


def expected_grid(points):
    cells = [0] * 704
    total = 0
    for point in points:
        x, y, count = float(point["x"]), float(point["y"]), point["count"]
        column, row = min(31, int(x / 100 * 32)), min(21, int(y / 100 * 22))
        cells[row * 32 + column] += count
        total += count
    return {
        "available": True, "reason": None,
        "definitionVersion": "full-tier3-count-weighted-histogram-32x22-v1",
        "columns": 32, "rows": 22, "cellCounts": cells,
        "validPointCount": total, "activitySnapshotCount": 1,
        "sourceDefinitionVersion": "sportsapi-heatmap-points-count-weighted-full-v1",
    }


def test_real_kane_reconstructs_existing_full_grid_and_locks_display_definition():
    from api_server.pitch_snapshot_provider import PitchSnapshotProvider
    from api_server.pitch_source_provider import ResolvedPitchPlayer
    from api_server.service import build_full_activity_heatmap

    source = PitchSnapshotProvider(REPO / "data", lambda _: ResolvedPitchPlayer(194165, "Bundesliga"))
    existing = build_full_activity_heatmap(194165, "2025/2026", "league", 8, "all")
    assert existing is not None and existing.data.available
    result = build_full_activity_display_envelope(context(), source.full_activity_sources(context()), existing.data.model_dump())
    expected = FIXTURE["fullSourceCca"]
    cca = result.fullSourceCca
    assert result.fullHeat.model_dump() == existing.data.model_dump()
    assert cca.available and cca.coverage.expectedKeys == expected["expectedKeys"]
    for key in ("definitionVersion", "formulaVersion", "inputDefinition", "heatmapDefinition", "sourceRevision", "validPointCount", "densityThreshold", "thresholdOfPeak", "coreAreaPct", "standardizedTarget", "containedMassPct", "lowSample"):
        assert getattr(cca, key) == expected[key]
    assert cca.ccaAreaPct == cca.coreAreaPct


def test_raw_count_expansion_is_ordered_and_requires_exact_existing_grid_parity():
    source_raw = raw()
    result = build_full_activity_display_envelope(context(), [(mapping(), source_raw)], expected_grid(source_raw["data"]["points"]))
    assert result.fullSourceCca.available
    assert result.fullSourceCca.validPointCount == 5
    mismatch = expected_grid(source_raw["data"]["points"])
    # Keep the pre-existing grid internally valid while changing one cell.
    mismatch["cellCounts"][4 * 32 + 3] -= 1
    mismatch["cellCounts"][0] += 1
    rejected = build_full_activity_display_envelope(context(), [(mapping(), source_raw)], mismatch)
    assert rejected.fullHeat.available
    assert rejected.fullSourceCca.available is False
    assert rejected.fullSourceCca.reason == "full_source_grid_mismatch"
    assert rejected.fullSourceCca.validPointCount == 0


@pytest.mark.parametrize("raw_source", [None, {"data": {"points": [{"x": 1, "y": 2, "count": 0}]}}, {"data": {"points": "not-a-list"}}])
def test_missing_or_malformed_raw_fails_closed_without_hiding_existing_grid(raw_source):
    heat = expected_grid(raw()["data"]["points"])
    result = build_full_activity_display_envelope(context(), [(mapping(), raw_source)], heat)
    assert result.fullHeat.available
    assert result.fullSourceCca.available is False
    assert result.fullSourceCca.reason == "full_source_payload_unavailable"
    assert result.fullSourceCca.coverage.expectedKeys == ["108579:35:77333"]
    assert result.fullSourceCca.coverage.observedKeys == []
    assert result.fullSourceCca.coverage.missingKeys == ["108579:35:77333"]


def test_exact_mapping_and_raw_identity_revision_changes_when_source_changes():
    baseline_raw = raw()
    heat = expected_grid(baseline_raw["data"]["points"])
    baseline = build_full_activity_display_envelope(context(), [(mapping(), baseline_raw)], heat)
    changed_raw = copy.deepcopy(baseline_raw)
    changed_raw["data"]["points"][0]["x"] = 11.0
    changed_heat = expected_grid(changed_raw["data"]["points"])
    changed = build_full_activity_display_envelope(context(), [(mapping(), changed_raw)], changed_heat)
    assert baseline.fullSourceCca.sourceRevision != changed.fullSourceCca.sourceRevision


def client_for(provider):
    app = FastAPI()
    app.include_router(create_full_activity_display_router(provider, lambda: ["2025/2026"]))
    return TestClient(app)


def test_router_has_native_context_guards_no_store_and_sanitized_provider_errors():
    good = build_full_activity_display_envelope(context(), [(mapping(), raw())], expected_grid(raw()["data"]["points"]))
    client = client_for(lambda _: good)
    response = client.get(PATH)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    for query, status in (("?wat=1", 422), ("?scope=8&scope=8", 422), ("?mode=europe&scope=8", 422), ("?competition=ucl", 422), ("?season=2024/2025", 404)):
        assert client.get(PATH + query).status_code == status
    assert client_for(lambda _: None).get(PATH).status_code == 404
    response = client_for(lambda _: (_ for _ in ()).throw(ValueError("secret disk path"))).get(PATH)
    assert response.status_code == 500 and "secret" not in response.text


def test_production_pitch_factory_wires_the_new_route_to_one_exact_snapshot_source():
    from api_server.pitch_routes import create_pitch_router
    from api_server.pitch_source_provider import ResolvedPitchPlayer
    from api_server.main import _pitch_full_heat

    app = FastAPI()
    app.include_router(create_pitch_router(
        REPO / "data", lambda _: ResolvedPitchPlayer(194165, "Bundesliga"), lambda: ["2025/2026"],
        full_heat_provider=_pitch_full_heat,
    ))
    response = TestClient(app).get(PATH)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["fullHeat"]["validPointCount"] == body["fullSourceCca"]["validPointCount"] == 1401
    assert body["fullSourceCca"]["thresholdOfPeak"] == FIXTURE["fullSourceCca"]["thresholdOfPeak"]


@pytest.mark.parametrize("wrong_context", [False, True])
def test_factory_uses_injected_grid_and_rejects_context_drift(tmp_path, monkeypatch, wrong_context):
    from types import SimpleNamespace
    from api_server.pitch_routes import create_pitch_router
    from api_server.full_activity_display_contract import FullActivityDisplayHeatmap
    import api_server.pitch_snapshot_provider as snapshots
    import api_server.service as service

    def forbidden_global(*args, **kwargs):
        raise AssertionError("Factory must not reach the global service grid")

    monkeypatch.setattr(service, "build_full_activity_heatmap", forbidden_global)

    class LocalSources:
        def __init__(self, root, lookup):
            assert root == tmp_path

        def full_activity_sources(self, selected):
            assert selected == context()
            return [(mapping(), raw())]

    monkeypatch.setattr(snapshots, "PitchSnapshotProvider", LocalSources)

    def local_grid(selected):
        assert selected == context()
        return SimpleNamespace(
            context=selected.model_copy(update={"playerId": 99}) if wrong_context else selected,
            data=FullActivityDisplayHeatmap.model_validate(expected_grid(raw()["data"]["points"])),
        )

    app = FastAPI()
    app.include_router(create_pitch_router(tmp_path, lambda _: None, lambda: ["2025/2026"], full_heat_provider=local_grid))
    response = TestClient(app).get(PATH)
    assert response.status_code == (500 if wrong_context else 200)
    if not wrong_context:
        assert response.json()["fullHeat"]["validPointCount"] == 5


def test_factory_without_explicit_grid_provider_fails_closed(tmp_path):
    from api_server.pitch_routes import create_pitch_router
    app = FastAPI()
    app.include_router(create_pitch_router(tmp_path, lambda _: None, lambda: ["2025/2026"]))
    assert TestClient(app).get(PATH).status_code == 500
