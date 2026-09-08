import csv
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from api_server.box_subregion_contract import BoxContext, BoxSubregionEnvelope
from api_server.box_subregion_router import create_box_subregion_router
from api_server.native_body_part_router import create_native_body_part_router
from api_server.pitch_source_provider import COMPETITIONS, PitchSourceProvider, ResolvedPitchPlayer


def create_local_pitch_qa_app(provider, supported_seasons):
    # Test-only injected composition; production uses pitch_routes.py/main.py.
    app = FastAPI()
    app.include_router(create_box_subregion_router(provider.box, supported_seasons))
    app.include_router(create_native_body_part_router(provider.body_parts, supported_seasons))
    return app


def context(**changes):
    return BoxContext(**{"playerId": 10, "season": "2025/2026", "mode": "league", "scope": 8, "competition": None, **changes})


def row(name="Bundesliga", season_id=77333, sports=110):
    return {"fotmob_player_id": "10", "sportsapi_player_id": str(sports), "season_name": "2025/2026",
            "competition_name": name, "tournament_id": str(COMPETITIONS[name][0]), "season_id": str(season_id),
            "heatmap_key": f"10:{COMPETITIONS[name][0]}:{season_id}"}


def setup_source(tmp_path, rows):
    with (tmp_path / "tactical_3zone_ratio.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(row()))
        writer.writeheader()
        writer.writerows(rows)
    return PitchSourceProvider(tmp_path, lambda c: ResolvedPitchPlayer(c.playerId, "Bundesliga"))


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def test_exact_context_lookup_and_three_competition_selectors(tmp_path):
    rows = [row(), row("UEFA Champions League", 76953), row("UEFA Europa League", 76984), row("UEFA Europa Conference League", 76960)]
    provider = setup_source(tmp_path, rows)
    calls = []
    provider.player_lookup = lambda c: (calls.append(c.model_dump()), ResolvedPitchPlayer(10, "Bundesliga"))[1]
    assert [r["competition_name"] for r in provider.selected_rows(context())] == ["Bundesliga"]
    europe = context(mode="europe", scope=None, competition="ucl")
    assert provider.selected_rows(europe) == [rows[1]]
    all_cups = context(mode="europe", scope=None, competition="all")
    assert provider.selected_rows(all_cups) == rows[1:]
    assert calls == [context().model_dump(), europe.model_dump(), all_cups.model_dump()]


def test_known_no_mapping_is_200_unavailable_and_unknown_player_is_404(tmp_path):
    provider = setup_source(tmp_path, [])
    client = TestClient(create_local_pitch_qa_app(provider, lambda: ["2025/2026"]))
    response = client.get("/api/v2/players/10/box-subregion-stats")
    assert response.status_code == 200
    data = response.json()
    assert data["completeness"] == "unavailable"
    assert data["coverage"]["shots"]["expectedKeys"] == []
    assert all(region["shots"] is None for region in data["regions"])
    for state in ("observed", "partial"):
        bad = json.loads(response.text)
        bad["coverage"]["shots"]["state"] = state
        with pytest.raises(ValueError):
            BoxSubregionEnvelope.model_validate(bad)
    provider.player_lookup = lambda c: None
    assert client.get("/api/v2/players/10/box-subregion-stats").status_code == 404


def test_duplicate_wrong_tournament_and_cohort_identity_rejected(tmp_path):
    for rows in ([row(), row()], [{**row(), "tournament_id": "8"}], [{**row(), "season_id": "../x"}]):
        provider = setup_source(tmp_path, rows)
        with pytest.raises(ValueError):
            provider.selected_rows(context())
    provider = setup_source(tmp_path, [row()])
    for identity in (ResolvedPitchPlayer(99, "Bundesliga"), ResolvedPitchPlayer(10, "../other")):
        provider.player_lookup = lambda c: identity
        with pytest.raises(ValueError):
            provider.selected_rows(context())


def test_shot_shard_is_reread_and_mapping_revision_is_pinned(tmp_path, monkeypatch):
    provider = setup_source(tmp_path, [row()])
    shard = tmp_path / "tactical_shotmap_points_2025_2026.json"
    write_json(shard, {row()["heatmap_key"]: []})
    assert provider.box(context()).accounting.source.shots == 0
    write_json(shard, {row()["heatmap_key"]: [{"x": 90, "y": 55, "outcome": "goal", "xg": 0.1, "xgot": 0.3}]})
    monkeypatch.setattr(csv, "DictReader", lambda *a, **kw: pytest.fail("request rescanned CSV mapping"))
    assert provider.box(context()).accounting.source.shots == 1
    with (tmp_path / "tactical_3zone_ratio.csv").open("a", encoding="utf-8") as handle:
        handle.write("\n")
    with pytest.raises(ValueError, match="revision changed"):
        provider.box(context())


def test_europe_missing_selected_shard_is_partial_never_domestic_substitute(tmp_path):
    ucl, uel = row("UEFA Champions League", 76953), row("UEFA Europa League", 76984)
    provider = setup_source(tmp_path, [row(), ucl, uel])
    write_json(tmp_path / "tactical_shotmap_points_2025_2026.json", {row()["heatmap_key"]: [], ucl["heatmap_key"]: []})
    result = provider.box(context(mode="europe", scope=None, competition="all"))
    assert result.coverage.shots.state == "partial"
    assert result.coverage.shots.observedKeys == [ucl["heatmap_key"]]
    assert result.coverage.shots.missingKeys == [uel["heatmap_key"]]
    assert row()["heatmap_key"] not in result.coverage.shots.expectedKeys


def test_native_reader_only_reads_selected_manifest_ids_and_marks_bad_json_invalid(tmp_path):
    provider = setup_source(tmp_path, [row()])
    manifest = {"matchIds": [1, 2, 3], "finishedExactContextMatchCount": 3, "tournamentId": 35,
                "seasonId": 77333, "seasonName": "2025/2026", "competition": "Bundesliga"}
    folder = tmp_path / "harvest/match-shotmaps-v1/domestic/bundesliga/77333"
    write_json(tmp_path / "harvest/match-event-manifests-v1/domestic/bundesliga/77333/manifest-main-stage.json", manifest)
    write_json(folder / "1.json", {"sample": "selected"})
    (folder / "2.json").write_text("malformed", encoding="utf-8")
    write_json(folder / "999.json", {"sample": "must not read"})
    selected_row, returned_manifest, snapshots = provider.native_sources(context())[0]
    assert selected_row == row() and returned_manifest == manifest
    assert snapshots == {1: {"sample": "selected"}, 2: None}


def test_corrupt_present_source_is_not_unavailable(tmp_path):
    provider = setup_source(tmp_path, [row()])
    (tmp_path / "tactical_shotmap_points_2025_2026.json").write_text("malformed", encoding="utf-8")
    response = TestClient(create_local_pitch_qa_app(provider, lambda: ["2025/2026"])).get("/api/v2/players/10/box-subregion-stats")
    assert response.status_code == 500


@pytest.mark.parametrize("changes", [
    {"tournamentId": 8}, {"seasonId": 99}, {"competition": "LaLiga"},
    {"seasonName": "2024/2025"}, {"matchIds": [1, 1]},
    {"matchIds": ["../1"]}, {"finishedExactContextMatchCount": True},
])
def test_native_manifest_context_rejected_before_any_match_read(tmp_path, monkeypatch, changes):
    provider = setup_source(tmp_path, [row()])
    manifest = {"matchIds": [1], "finishedExactContextMatchCount": 1, "tournamentId": 35,
                "seasonId": 77333, "seasonName": "2025/2026", "competition": "Bundesliga", **changes}
    write_json(tmp_path / "harvest/match-event-manifests-v1/domestic/bundesliga/77333/manifest-main-stage.json", manifest)
    reads = []
    original_read = provider._json

    def checked_read(path):
        reads.append(path)
        assert "match-shotmaps-v1" not in path.parts, "unvalidated manifest reached a raw match read"
        return original_read(path)

    monkeypatch.setattr(provider, "_json", checked_read)
    with pytest.raises(ValueError):
        provider.native_sources(context())
    assert len(reads) == 1


def test_recorded_kane_real_sources_through_local_http_contract():
    from api_server.pitch_snapshot_provider import PitchSnapshotProvider
    data_root = Path(__file__).resolve().parents[1] / "data"
    # The isolated provider's lookup boundary is verified above; cohort lookup
    # itself is not asserted by this fixture-only integration test.
    provider = PitchSnapshotProvider(data_root, lambda c: ResolvedPitchPlayer(194165, "Bundesliga"))
    client = TestClient(create_local_pitch_qa_app(provider, lambda: ["2025/2026"]))
    response = client.get("/api/v2/players/194165/box-subregion-stats?season=2025/2026&scope=8")
    assert response.status_code == 200, response.text
    envelope = BoxSubregionEnvelope.model_validate(response.json())
    assert envelope.completeness == "observed"
    assert envelope.accounting.source.shots == 119
    assert envelope.denominators.fullActivityCount == 1401
    assert [r.shots for r in envelope.regions] == [9, 31, 33, 11]
    assert [r.quality.delta for r in envelope.regions] == [1.639, 1.7659, 0.7675, -0.3677]


def test_real_static_cohort_lookup_to_saved_sources_to_local_http():
    from api_server.service import find_v2_player
    from api_server.pitch_snapshot_provider import PitchSnapshotProvider

    data_root = Path(__file__).resolve().parents[1] / "data"

    def lookup(selected):
        player = find_v2_player(selected.playerId, selected.season, selected.mode,
                               selected.scope if selected.scope is not None else 8,
                               selected.competition or "all")
        return None if player is None else ResolvedPitchPlayer(player.id, player.league.name)

    provider = PitchSnapshotProvider(data_root, lookup)
    client = TestClient(create_local_pitch_qa_app(provider, lambda: ["2025/2026"]))
    response = client.get("/api/v2/players/194165/box-subregion-stats?season=2025/2026&scope=8")
    assert response.status_code == 200, response.text
    assert response.json()["accounting"]["source"]["shots"] == 119
    assert response.json()["denominators"]["fullActivityCount"] == 1401
    assert client.get("/api/v2/players/987654321/box-subregion-stats?scope=8").status_code == 404
