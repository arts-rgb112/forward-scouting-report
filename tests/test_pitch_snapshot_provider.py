import csv
import gzip
import hashlib
import json
from pathlib import Path

import pytest

from api_server.box_subregion_contract import BoxContext
from api_server.native_pitch_events_contract import build_native_pitch_envelope
from api_server.pitch_snapshot_provider import PitchSnapshotProvider, MAX_DECODED_BYTES
from api_server.pitch_source_provider import PitchSourceProvider, ResolvedPitchPlayer
from scripts.export_native_pitch_snapshot import export_snapshot, canonical, read_json, heatmap_packs, VERSION, HEATMAP_PACK_BYTES


def context():
    return BoxContext(playerId=194165, season="2025/2026", mode="league", scope=8, competition=None)


def row():
    return {"fotmob_player_id": "194165", "sportsapi_player_id": "108579", "tournament_id": "35", "season_id": "77333",
            "season_name": "2025/2026", "competition_name": "Bundesliga", "heatmap_key": "194165:35:77333"}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical(value))


def lookup(ctx):
    return ResolvedPitchPlayer(ctx.playerId, "Bundesliga")


def setup(tmp_path, *, missing_manifest=False, invalid=False, aliases=False, heat=False):
    mapping = tmp_path / "tactical_3zone_ratio.csv"
    rows = [row()]
    if aliases:
        rows.append({**row(), "fotmob_player_id": "99", "heatmap_key": "99:35:77333"})
    with mapping.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, list(row()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    base = tmp_path / "harvest"
    if heat:
        write(base / "heatmaps/bundesliga/77333/108579.json", {"heatmap": [{"x": 70, "y": 45}]})
    if not missing_manifest:
        write(base / "match-event-manifests-v1/domestic/bundesliga/77333/manifest-main-stage.json",
              {"tournamentId": 35, "seasonId": 77333, "seasonName": "2025/2026", "competition": "Bundesliga", "matchIds": [1, 2], "finishedExactContextMatchCount": 2})
        events = [{"id": n, "player": {"id": 108579}, "bodyPart": body, "shotType": "goal", "situation": situation,
                   "xg": .2, "xgot": None if n == 1 else .4,
                   "playerCoordinates": {"x": 8., "y": 37.8, "z": 0.}, "goalMouthCoordinates": {"x": 0., "y": 45.7, "z": 8.2},
                   "draw": {"start": {"x": 37.8, "y": 8.}, "end": {"x": 54.3, "y": 0.}}}
                  for n, body, situation in ((1, "head", "regular"), (2, "left-foot", "regular"), (3, "right-foot", "penalty"))]
        write(base / "match-shotmaps-v1/domestic/bundesliga/77333/1.json", {"success": True, "matchId": 1, "endpoint": "shotmap", "data": {"shotmap": events}})
        if invalid:
            (base / "match-shotmaps-v1/domestic/bundesliga/77333/1.json").write_text("{bad", encoding="utf-8")
    output = tmp_path / "pitch-native-v2"
    index = export_snapshot(tmp_path, mapping, output, dry_run=False)
    return index, PitchSnapshotProvider(tmp_path, lookup)


def rewrite_index(root, index):
    index["sourceRevision"] = hashlib.sha256(canonical({key: index[key] for key in ("mappingCsvSha256", "native", "heatmaps")})).hexdigest()
    write(root / "pitch-native-v2/index.json", index)


def test_export_rejects_non_deployable_crlf_mapping(tmp_path):
    setup(tmp_path)
    mapping = tmp_path / "tactical_3zone_ratio.csv"
    mapping.write_bytes(mapping.read_bytes().replace(b"\n", b"\r\n"))
    with pytest.raises(ValueError, match="committed LF bytes"):
        export_snapshot(tmp_path, mapping, tmp_path / "rejected", dry_run=True)


def test_runtime_still_rejects_mapping_byte_changes(tmp_path):
    setup(tmp_path)
    mapping = tmp_path / "tactical_3zone_ratio.csv"
    mapping.write_bytes(mapping.read_bytes().replace(b"\n", b"\r\n"))
    with pytest.raises(ValueError, match="mapping SHA"):
        PitchSnapshotProvider(tmp_path, lookup)


def test_deterministic_complete_sources_and_pk_null_geometry_parity(tmp_path):
    index, provider = setup(tmp_path)
    raw = PitchSourceProvider(tmp_path, lookup)
    assert provider.native_sources(context()) == raw.native_sources(context())
    full = build_native_pitch_envelope(context(), provider.native_sources(context()))
    excluded = build_native_pitch_envelope(context(), provider.native_sources(context()), include_penalties=False)
    original = build_native_pitch_envelope(context(), raw.native_sources(context()))
    assert full == original
    assert len(full.events) == 3 and len(excluded.events) == 2
    assert full.snapshotRevision == excluded.snapshotRevision == original.snapshotRevision
    assert full.events[0].xgot is None
    assert full.events[1].plot.y == 62.2 and full.events[1].destination.y == 45.7
    assert all(e.destination.observedHeightMeters is None for e in full.events)
    again = export_snapshot(tmp_path, tmp_path / "tactical_3zone_ratio.csv", tmp_path / "another", dry_run=False)
    assert index == again
    for kind in ("native", "heatmaps"):
        entries = index[kind].values() if kind == "native" else [p for s in index[kind].values() for p in s["packs"].values()]
        for entry in entries:
            assert (tmp_path / "pitch-native-v2" / entry["path"]).read_bytes() == (tmp_path / "another" / entry["path"]).read_bytes()


@pytest.mark.parametrize("missing_manifest,invalid", [(True, False), (False, True), (False, False)])
def test_unavailable_invalid_missing_remain_distinct(tmp_path, missing_manifest, invalid):
    index, provider = setup(tmp_path, missing_manifest=missing_manifest, invalid=invalid)
    selected = provider.native_sources(context())
    assert selected == PitchSourceProvider(tmp_path, lookup).native_sources(context())
    coverage = next(iter(index["native"].values()))["coverage"]
    if missing_manifest:
        assert selected[0][1] is None and selected[0][2] == {} and coverage["expectedMatchIds"] == []
    elif invalid:
        assert selected[0][2] == {1: None} and coverage["invalidMatchIds"] == ["1"]
    else:
        assert coverage["missingMatchIds"] == ["2"]
    assert next(iter(index["heatmaps"].values()))["coverage"]["missingKeys"] == ["108579:35:77333"]


def test_aliases_preserve_mapping_rows_without_duplicate_raw_payloads(tmp_path):
    index, provider = setup(tmp_path, aliases=True, heat=True)
    entry = next(iter(index["heatmaps"].values()))
    assert index["mappingRows"] == entry["mappingRows"] == 2
    assert entry["coverage"]["expectedKeys"] == ["108579:35:77333"]
    assert entry["keyToPack"] == {"108579:35:77333": "0000"}
    assert len(provider._load("heatmaps", "domestic/bundesliga/77333", "0000")["payloads"]) == 1
    assert provider.native_sources(context())[0][0] == row()


def test_cache_one_and_mutations_cannot_change_later_source(tmp_path):
    _, provider = setup(tmp_path, heat=True)
    selected = provider.native_sources(context())
    selected[0][1]["matchIds"].append(9)
    selected[0][2][1]["data"]["shotmap"].clear()
    assert len(provider.native_sources(context())[0][2][1]["data"]["shotmap"]) == 3
    assert provider._cache_key[0] == "native"
    provider._load("heatmaps", "domestic/bundesliga/77333", "0000")
    assert provider._cache_key[0] == "heatmaps"
    assert "manifest" not in provider._cache_value
    provider.native_sources(context())
    assert provider._cache_key[0] == "native"


@pytest.mark.parametrize("mutation", [
    lambda i: i.update(mappingCsvSha256="0" * 64),
    lambda i: i["native"].clear(),
    lambda i: next(iter(i["native"].values())).update(path="../outside.gz"),
    lambda i: next(iter(i["native"].values())).update(decodedBytes=MAX_DECODED_BYTES + 1),
    lambda i: next(iter(i["native"].values())).update(mappingRows=99),
    lambda i: next(iter(i["native"].values()))["coverage"].update(missingMatchIds=["1", "2"]),
])
def test_strict_index_rejects_mutations(tmp_path, mutation):
    index, _ = setup(tmp_path)
    mutation(index)
    rewrite_index(tmp_path, index)
    with pytest.raises(ValueError):
        PitchSnapshotProvider(tmp_path, lookup)


@pytest.mark.parametrize("mode", ["missing", "corrupt", "size", "decoded_size", "coverage", "extra_key"])
def test_corrupt_artifact_is_never_unavailable(tmp_path, mode):
    index, _ = setup(tmp_path)
    entry = next(iter(index["native"].values()))
    path = tmp_path / "pitch-native-v2" / entry["path"]
    if mode == "missing":
        path.unlink()
    elif mode in ("corrupt", "size"):
        data = path.read_bytes()
        path.write_bytes((b"X" + data[1:]) if mode == "corrupt" else data[:-1])
    else:
        if mode == "decoded_size":
            entry["decodedBytes"] += 1
        else:
            value = json.loads(gzip.decompress(path.read_bytes()))
            if mode == "coverage":
                value["payloads"].pop("1")
            else:
                value["extra"] = True
            decoded = canonical(value)
            data = gzip.compress(decoded, mtime=0)
            path.write_bytes(data)
            entry.update(sha256=hashlib.sha256(data).hexdigest(), gzipBytes=len(data), decodedBytes=len(decoded))
        rewrite_index(tmp_path, index)
    provider = PitchSnapshotProvider(tmp_path, lookup)
    with pytest.raises((ValueError, FileNotFoundError)):
        provider.native_sources(context())


def test_unknown_cohort_is_none_but_missing_index_is_error(tmp_path):
    _, provider = setup(tmp_path)
    provider.player_lookup = lambda _: None
    assert provider.native_sources(context()) is None and provider.box(context()) is None
    (tmp_path / "pitch-native-v2/index.json").unlink()
    with pytest.raises(FileNotFoundError):
        PitchSnapshotProvider(tmp_path, lookup)


def test_dry_run_does_not_write(tmp_path):
    setup(tmp_path)
    target = tmp_path / "not-created"
    export_snapshot(tmp_path, tmp_path / "tactical_3zone_ratio.csv", target)
    assert not target.exists()


def test_duplicate_source_keys_are_rejected(tmp_path):
    path = tmp_path / "duplicate.json"
    path.write_text('{"data":1,"data":2}', encoding="utf-8")
    with pytest.raises(ValueError, match="Duplicate source"):
        read_json(path)


def test_bounded_decompression_rejects_dishonest_declared_size(tmp_path):
    index, _ = setup(tmp_path)
    entry = next(iter(index["native"].values()))
    data = gzip.compress(b" " * (MAX_DECODED_BYTES + 10), mtime=0)
    (tmp_path / "pitch-native-v2" / entry["path"]).write_bytes(data)
    entry.update(sha256=hashlib.sha256(data).hexdigest(), gzipBytes=len(data))
    rewrite_index(tmp_path, index)
    with pytest.raises(ValueError, match="decoded size"):
        PitchSnapshotProvider(tmp_path, lookup).native_sources(context())


def test_changed_mapping_and_cached_missing_shard_fail(tmp_path):
    index, provider = setup(tmp_path)
    provider.native_sources(context())
    entry = next(iter(index["native"].values()))
    (tmp_path / "pitch-native-v2" / entry["path"]).unlink()
    with pytest.raises(FileNotFoundError):
        provider.native_sources(context())
    with (tmp_path / "tactical_3zone_ratio.csv").open("a", encoding="utf-8") as handle:
        handle.write("\n")
    with pytest.raises(ValueError, match="revision changed"):
        provider.native_sources(context())


def test_observed_empty_stays_zero(tmp_path):
    setup(tmp_path)
    manifest_path = tmp_path / "harvest/match-event-manifests-v1/domestic/bundesliga/77333/manifest-main-stage.json"
    value = json.loads(manifest_path.read_bytes())
    value.update(matchIds=[1], finishedExactContextMatchCount=1)
    write(manifest_path, value)
    write(tmp_path / "harvest/match-shotmaps-v1/domestic/bundesliga/77333/1.json",
          {"success": True, "matchId": 1, "endpoint": "shotmap", "data": {"shotmap": []}})
    # Distinct destination avoids replacing an already pinned snapshot.
    output = tmp_path / "zero" / "pitch-native-v2"
    output.parent.mkdir()
    (output.parent / "tactical_3zone_ratio.csv").write_bytes((tmp_path / "tactical_3zone_ratio.csv").read_bytes())
    export_snapshot(tmp_path, output.parent / "tactical_3zone_ratio.csv", output, dry_run=False)
    provider = PitchSnapshotProvider(output.parent, lookup)
    result = build_native_pitch_envelope(context(), provider.native_sources(context()))
    assert result.bodyParts.totals.shots == 0
    assert result.bodyParts.totals.quality.delta == 0


def test_release_actual_kane_snapshot_parity():
    release_data = Path(__file__).resolve().parents[1] / "data"
    raw_data = release_data.parents[1] / "forward-scouting-report-agent-config/data"
    if not (release_data / "pitch-native-v2/index.json").exists() or not (raw_data / "harvest").exists():
        pytest.skip("Full local release snapshot/raw parity fixture is not installed")
    snapshot = PitchSnapshotProvider(release_data, lookup)
    class ReleaseMappedRawProvider(PitchSourceProvider):
        def _path(self, *parts):
            # Freeze selection to the approved release CSV; only harvest storage is elsewhere.
            if parts and parts[0] == "harvest":
                result = raw_data.joinpath(*parts).resolve()
                assert result.is_relative_to(raw_data)
                return result
            return super()._path(*parts)
    raw = ReleaseMappedRawProvider(release_data, lookup)
    selected = snapshot.native_sources(context())
    original_selected = raw.native_sources(context())
    assert selected == original_selected
    included = build_native_pitch_envelope(context(), selected)
    excluded = build_native_pitch_envelope(context(), selected, include_penalties=False)
    assert included == build_native_pitch_envelope(context(), original_selected)
    assert excluded == build_native_pitch_envelope(context(), original_selected, include_penalties=False)
    assert (included.bodyParts.totals.shots, included.bodyParts.totals.goals) == (119, 36)
    assert (excluded.bodyParts.totals.shots, excluded.bodyParts.totals.goals) == (108, 26)
    assert included.snapshotRevision == excluded.snapshotRevision
    vectors = {6390845: ("head", 91.5, 56.6, 100, 51.2), 5473386: ("leftFoot", 92, 62.2, 100, 45.7), 5473363: ("rightFoot", 85, 71.9, 100, 45.8)}
    for event in included.events:
        if event.identity.shotId in vectors:
            assert (event.bodyPart, event.plot.x, event.plot.y, event.destination.x, event.destination.y) == vectors.pop(event.identity.shotId)
    assert vectors == {}
    assert snapshot.box(context()) == raw.box(context())
    assert sum(len(v["coverage"]["missingMatchIds"]) for v in snapshot.index["native"].values()) == 8
    assert sum(len(v["coverage"]["missingKeys"]) for v in snapshot.index["heatmaps"].values()) == 34
    v1_index = json.loads((release_data / "pitch-native-v1/index.json").read_bytes())
    identity = "domestic/bundesliga/77333"
    old_native = json.loads(gzip.decompress((release_data / "pitch-native-v1" / v1_index["native"][identity]["path"]).read_bytes()))
    assert selected[0][1] == old_native["manifest"]
    assert selected[0][2] == {int(k): v for k, v in old_native["payloads"].items()}
    old_heat = json.loads(gzip.decompress((release_data / "pitch-native-v1" / v1_index["heatmaps"][identity]["path"]).read_bytes()))
    key = "108579:35:77333"
    pack = snapshot.index["heatmaps"][identity]["keyToPack"][key]
    assert snapshot._load("heatmaps", identity, pack)["payloads"][key] == old_heat["payloads"][key]


def test_greedy_packs_sorted_deterministic_indivisible_and_bounded():
    header = {"definitionVersion": VERSION, "scope": "domestic", "slug": "bundesliga", "seasonId": "77333"}
    values = {f"{n}:35:77333": {"original": "a" * 150000} for n in range(1, 40)}
    first = list(heatmap_packs(header, values))
    second = list(heatmap_packs(header, dict(reversed(list(values.items())))))
    assert first == second and len(first) > 1
    assert all(len(canonical(pack)) <= HEATMAP_PACK_BYTES for pack in first)
    restored = {key: value for pack in first for key, value in pack["payloads"].items()}
    assert restored == values
    assert [key for pack in first for key in pack["payloads"]] == sorted(values)
    with pytest.raises(ValueError, match="One heatmap"):
        list(heatmap_packs(header, {"1:35:77333": "a" * HEATMAP_PACK_BYTES}))


@pytest.mark.parametrize("mutation", [
    lambda i: next(iter(i["heatmaps"].values()))["keyToPack"].clear(),
    lambda i: next(iter(i["heatmaps"].values()))["keyToPack"].update({"108579:35:77333": "9999"}),
    lambda i: next(iter(i["heatmaps"].values()))["packs"]["0000"].update(decodedBytes=HEATMAP_PACK_BYTES + 1),
    lambda i: i.update(definitionVersion="native-pitch-source-snapshot-v1"),
    lambda i: next(iter(i["heatmaps"].values()))["coverage"].update(expectedKeys=["99:35:77333"], observedKeys=["99:35:77333"]),
])
def test_pack_routing_version_and_size_fail_closed(tmp_path, mutation):
    index, _ = setup(tmp_path, heat=True)
    mutation(index)
    rewrite_index(tmp_path, index)
    with pytest.raises(ValueError):
        PitchSnapshotProvider(tmp_path, lookup)


@pytest.mark.parametrize("mode", ["missing", "extra", "absent", "mixed_version"])
def test_heat_pack_must_match_exact_reverse_membership(tmp_path, mode):
    index, _ = setup(tmp_path, heat=True)
    entry = next(iter(index["heatmaps"].values()))["packs"]["0000"]
    path = tmp_path / "pitch-native-v2" / entry["path"]
    if mode == "missing":
        path.unlink()
    else:
        value = json.loads(gzip.decompress(path.read_bytes()))
        if mode == "extra":
            value["payloads"]["999:35:77333"] = {}
        elif mode == "absent":
            value["payloads"].clear()
        else:
            value["definitionVersion"] = "native-pitch-source-snapshot-v1"
        decoded = canonical(value)
        data = gzip.compress(decoded, mtime=0)
        path.write_bytes(data)
        entry.update(sha256=hashlib.sha256(data).hexdigest(), gzipBytes=len(data), decodedBytes=len(decoded))
        rewrite_index(tmp_path, index)
    with pytest.raises((ValueError, FileNotFoundError)):
        PitchSnapshotProvider(tmp_path, lookup)._load("heatmaps", "domestic/bundesliga/77333", "0000")
