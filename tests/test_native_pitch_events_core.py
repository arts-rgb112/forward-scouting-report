from __future__ import annotations

import csv
import json
from copy import deepcopy
from pathlib import Path

import pytest

from api_server.native_pitch_events_core import build_native_event_bundle


PLAYER = 108579


def mapping(*, tournament=35, season_id=77333, competition="Bundesliga"):
    return {"fotmob_player_id": "194165", "sportsapi_player_id": str(PLAYER), "tournament_id": str(tournament),
            "season_id": str(season_id), "season_name": "2025/2026", "competition_name": competition,
            "heatmap_key": f"194165:{tournament}:{season_id}"}


def manifest(match_ids=(1,), *, tournament=35, season_id=77333, competition="Bundesliga"):
    return {"tournamentId": tournament, "seasonId": season_id, "seasonName": "2025/2026", "competition": competition,
            "matchIds": list(match_ids), "finishedExactContextMatchCount": len(match_ids)}


def event(event_id, *, body="right-foot", shot_type="goal", situation="regular", xg=0.2, xgot=0.4,
          coordinates=True):
    result = {"id": event_id, "player": {"id": PLAYER}, "bodyPart": body, "shotType": shot_type,
              "situation": situation, "xg": xg, "xgot": xgot}
    if coordinates:
        result.update({"playerCoordinates": {"x": 8.0, "y": 37.8, "z": 0.0},
                       "goalMouthCoordinates": {"x": 0.0, "y": 45.7, "z": 8.2},
                       "draw": {"start": {"x": 37.8, "y": 8.0}, "end": {"x": 54.3, "y": 0.0},
                                "goal": {"x": 54.3, "y": 91.8}}})
    return result


def payload(match_id, events):
    return {"success": True, "matchId": match_id, "endpoint": "shotmap", "data": {"shotmap": events}}


def source(row=None, source_manifest=None, snapshots=None):
    return (row or mapping(), source_manifest or manifest(), snapshots if snapshots is not None else {1: payload(1, [event(1)])})


def test_exact_same_event_identity_raw_coordinates_and_plot_gate():
    original = source()
    before = deepcopy(original)
    result = build_native_event_bundle([original])
    assert original == before
    assert result["completeness"] == "complete"
    assert result["sources"][0]["counts"] == {"admittedShots": 1, "excludedPenaltyShots": 0,
                                                  "excludedPenaltyGoals": 0, "shots": 1, "goals": 1}
    shot = result["events"][0]
    assert shot["identity"] == {"mappingKey": "194165:35:77333", "sourcePlayerId": PLAYER, "matchId": 1, "shotId": 1}
    assert shot["bodyPart"] == "right-foot" and shot["shotType"] == shot["outcome"] == "goal"
    assert shot["rawCoordinates"]["playerCoordinates"] == {"x": 8.0, "y": 37.8, "z": 0.0}
    assert shot["plot"] == {"state": "projected", "x": 92.0, "y": 62.2, "reason": None,
                            "transformVersion": "sportsapi-draw-pitch-display-v1"}
    assert shot["goalPlaneProjection"] == {"state": "available", "x": 100.0, "y": 45.7, "reason": None,
                                           "transformVersion": "sportsapi-draw-pitch-display-v1"}


def test_pk_is_native_situation_not_coordinate_and_filter_keeps_quality_scope():
    regular_at_penalty_spot = event(1, situation="regular")
    regular_at_penalty_spot["playerCoordinates"] = {"x": 89.524, "y": 50.0, "z": 0.0}
    penalty_elsewhere = event(2, situation="penalty", xg=0.5, xgot=0.7)
    penalty_elsewhere["playerCoordinates"] = {"x": 1.0, "y": 1.0, "z": 0.0}
    included = build_native_event_bundle([source(snapshots={1: payload(1, [regular_at_penalty_spot, penalty_elsewhere])})])
    excluded = build_native_event_bundle([source(snapshots={1: payload(1, [regular_at_penalty_spot, penalty_elsewhere])})], include_penalties=False)
    assert [shot["identity"]["shotId"] for shot in excluded["events"]] == [1]
    assert excluded["sources"][0]["counts"] == {"admittedShots": 2, "excludedPenaltyShots": 1,
                                                   "excludedPenaltyGoals": 1, "shots": 1, "goals": 1}
    assert included["sources"][0]["quality"]["eligible"] == 2
    assert excluded["sources"][0]["quality"]["eligible"] == 1


def test_invalid_or_missing_coordinates_never_remove_exact_counted_event():
    broken = event(1)
    broken["draw"] = {"start": {"x": "bad", "y": 8}, "end": {}, "goal": None}
    result = build_native_event_bundle([source(snapshots={1: payload(1, [broken])})])
    assert result["sources"][0]["counts"]["shots"] == 1
    assert result["events"][0]["plot"]["reason"] == "native_coordinates_invalid"
    assert result["events"][0]["rawCoordinates"]["draw"] == broken["draw"]


def test_origin_projection_rejects_mismatch_range_and_null_without_changing_counts():
    cases = []
    mismatch = event(1); mismatch["draw"]["start"]["x"] = 37.9; cases.append((mismatch, "native_coordinate_mismatch"))
    out_of_range = event(1); out_of_range["draw"]["start"]["y"] = 101.0; cases.append((out_of_range, "native_coordinates_invalid"))
    null_coordinate = event(1); null_coordinate["playerCoordinates"]["x"] = None; cases.append((null_coordinate, "native_coordinates_invalid"))
    for raw, reason in cases:
        result = build_native_event_bundle([source(snapshots={1: payload(1, [raw])})])
        assert result["sources"][0]["counts"]["shots"] == 1
        assert result["events"][0]["plot"]["reason"] == reason


def test_goal_plane_requires_same_event_mouth_and_end_invariants_without_losing_counts():
    cases = []
    missing_mouth = event(1); del missing_mouth["goalMouthCoordinates"]; cases.append((missing_mouth, "native_goal_plane_invalid"))
    mismatch_x = event(1); mismatch_x["draw"]["end"]["x"] = 54.2; cases.append((mismatch_x, "native_goal_plane_mismatch"))
    mismatch_y = event(1); mismatch_y["draw"]["end"]["y"] = 1.0; cases.append((mismatch_y, "native_goal_plane_mismatch"))
    for raw, reason in cases:
        result = build_native_event_bundle([source(snapshots={1: payload(1, [raw])})])
        assert result["sources"][0]["counts"]["shots"] == 1
        assert result["events"][0]["goalPlaneProjection"]["reason"] == reason


def test_block_projection_uses_only_valid_native_draw_block():
    blocked = event(1, shot_type="block")
    blocked["draw"]["block"] = {"x": 49.6, "y": 2.5}
    result = build_native_event_bundle([source(snapshots={1: payload(1, [blocked])})])
    assert result["events"][0]["blockProjection"] == {"state": "available", "x": 97.5, "y": 50.4, "reason": None,
                                                          "transformVersion": "sportsapi-draw-pitch-display-v1"}
    del blocked["draw"]["block"]
    missing = build_native_event_bundle([source(snapshots={1: payload(1, [blocked])})])
    assert missing["events"][0]["blockProjection"]["reason"] == "native_block_coordinates_invalid"


def test_observed_zero_unavailable_and_missing_pair_semantics():
    observed_zero = build_native_event_bundle([source(snapshots={1: payload(1, [])})])
    assert observed_zero["sources"][0]["counts"]["shots"] == 0
    assert observed_zero["sources"][0]["quality"] == {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}
    unavailable = build_native_event_bundle([source(snapshots={})])
    assert unavailable["completeness"] == "unavailable"
    assert unavailable["sources"][0]["counts"]["shots"] is None
    assert unavailable["sources"][0]["quality"] == {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}
    unpaired = build_native_event_bundle([source(snapshots={1: payload(1, [event(1, xg=0.0, xgot=None)])})])
    assert unpaired["sources"][0]["counts"]["shots"] == 1
    assert unpaired["sources"][0]["quality"] == {"xg": None, "xgot": None, "delta": None, "eligible": 0, "state": "unavailable"}


def test_missing_manifest_is_known_unavailable_and_nonfinite_raw_snapshot_rejects():
    missing_manifest = build_native_event_bundle([(mapping(), None, {})])
    assert missing_manifest["completeness"] == "unavailable"
    assert missing_manifest["sources"][0]["coverage"]["state"] == "unavailable"
    corrupt = event(1)
    corrupt["playerCoordinates"]["x"] = float("nan")
    with pytest.raises(ValueError, match="nonfinite"):
        build_native_event_bundle([source(snapshots={1: payload(1, [corrupt])})])


@pytest.mark.parametrize("events", [[event(1), event(1)], [event(1, xg="bad")]])
def test_invalid_native_match_is_coverage_unavailable_not_a_partial_event(events):
    result = build_native_event_bundle([source(snapshots={1: payload(1, events)})])
    assert result["completeness"] == "unavailable"
    assert result["sources"][0]["coverage"]["invalidMatchIds"] == [1]
    assert result["sources"][0]["counts"]["shots"] is None
    assert result["events"] == []


def test_duplicate_exact_native_identity_is_rejected_across_sources():
    first = source()
    second_row = mapping(tournament=34, season_id=80000, competition="Ligue 1")
    second_manifest = manifest(tournament=34, season_id=80000, competition="Ligue 1")
    with pytest.raises(ValueError, match="duplicate native event identity"):
        build_native_event_bundle([first, source(second_row, second_manifest, {1: payload(1, [event(1)])})])


def test_snapshot_revision_and_event_order_ignore_mapping_and_dict_order():
    left = source(mapping(tournament=34, season_id=80000, competition="Ligue 1"),
                  manifest((2,), tournament=34, season_id=80000, competition="Ligue 1"), {2: payload(2, [event(2)])})
    right = source(mapping(), manifest((1,), tournament=35, season_id=77333), {1: payload(1, [event(1)])})
    first = build_native_event_bundle([left, right])
    second = build_native_event_bundle([(dict(reversed(left[0].items())), dict(reversed(left[1].items())), dict(reversed(left[2].items()))), right])
    assert first["snapshotRevision"] == second["snapshotRevision"]
    assert first["events"] == second["events"]
    assert [(event["identity"]["mappingKey"], event["identity"]["matchId"]) for event in first["events"]] == [("194165:34:80000", 2), ("194165:35:77333", 1)]


def test_actual_kane_saved_cohort_preserves_native_counts_and_quality():
    root = Path(__file__).resolve().parents[1] / "data"
    manifest_path = root / "harvest/match-event-manifests-v1/domestic/bundesliga/77333/manifest-main-stage.json"
    raw_root = root / "harvest/match-shotmaps-v1/domestic/bundesliga/77333"
    if not manifest_path.is_file() or not raw_root.is_dir():
        pytest.skip("saved native fixture absent")
    with (root / "tactical_3zone_ratio.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row["heatmap_key"] == "194165:35:77333" and row["season_name"] == "2025/2026"]
    with manifest_path.open(encoding="utf-8") as handle:
        source_manifest = json.load(handle)
    snapshots = {match_id: json.loads((raw_root / f"{match_id}.json").read_text(encoding="utf-8")) for match_id in source_manifest["matchIds"] if (raw_root / f"{match_id}.json").is_file()}
    included = build_native_event_bundle([(rows[0], source_manifest, snapshots)])
    excluded = build_native_event_bundle([(rows[0], source_manifest, snapshots)], include_penalties=False)
    assert len(included["events"]) == 119 and len(excluded["events"]) == 108
    assert (included["sources"][0]["counts"]["shots"], included["sources"][0]["counts"]["goals"]) == (119, 36)
    assert (excluded["sources"][0]["counts"]["shots"], excluded["sources"][0]["counts"]["goals"]) == (108, 26)
    assert included["sources"][0]["quality"] == {"xg": 26.4979, "xgot": 31.0131, "delta": 4.5152, "eligible": 118, "state": "partial"}
    assert excluded["sources"][0]["quality"] == {"xg": 17.8255, "xgot": 23.0167, "delta": 5.1912, "eligible": 107, "state": "partial"}
    assert len({(event["identity"]["sourcePlayerId"], event["identity"]["matchId"], event["identity"]["shotId"]) for event in included["events"]}) == 119
    left_goal = next(event for event in included["events"] if event["identity"]["matchId"] == 14056037 and event["identity"]["shotId"] == 5473386)
    right_goal = next(event for event in included["events"] if event["identity"]["matchId"] == 14056037 and event["identity"]["shotId"] == 5473363)
    assert left_goal["rawCoordinates"]["goalMouthCoordinates"] == {"x": 0, "y": 45.7, "z": 8.2}
    assert left_goal["plot"] == {"state": "projected", "x": 92.0, "y": 62.2, "reason": None,
                                  "transformVersion": "sportsapi-draw-pitch-display-v1"}
    assert left_goal["goalPlaneProjection"] == {"state": "available", "x": 100.0, "y": 45.7, "reason": None,
                                                  "transformVersion": "sportsapi-draw-pitch-display-v1"}
    assert right_goal["plot"] == {"state": "projected", "x": 85.0, "y": 71.9, "reason": None,
                                   "transformVersion": "sportsapi-draw-pitch-display-v1"}
    assert right_goal["goalPlaneProjection"] == {"state": "available", "x": 100.0, "y": 45.8, "reason": None,
                                                    "transformVersion": "sportsapi-draw-pitch-display-v1"}
    head_save = next(event for event in included["events"] if event["identity"]["matchId"] == 14062150 and event["identity"]["shotId"] == 6390845)
    assert head_save["plot"] == {"state": "projected", "x": 91.5, "y": 56.6, "reason": None,
                                  "transformVersion": "sportsapi-draw-pitch-display-v1"}
    assert head_save["goalPlaneProjection"] == {"state": "available", "x": 100.0, "y": 51.2, "reason": None,
                                                  "transformVersion": "sportsapi-draw-pitch-display-v1"}
    raw_by_id = {
        shot["id"]: shot
        for snapshot in snapshots.values()
        for shot in snapshot["data"]["shotmap"]
        if shot.get("player", {}).get("id") == PLAYER
    }
    # Provider labels prove the image-frame vertical inversion: source
    # ``low-right`` mouth y<50 must remain canonical player-right y<50.
    assert raw_by_id[5473386]["goalMouthLocation"] == "low-right"
    assert raw_by_id[5473363]["goalMouthLocation"] == "low-right"
    assert raw_by_id[6390845]["goalMouthLocation"] == "high-centre"
    for event_id, expected_y in ((5473386, 45.7), (5473363, 45.8), (6390845, 51.2)):
        raw = raw_by_id[event_id]
        assert 100.0 - raw["draw"]["end"]["x"] == raw["goalMouthCoordinates"]["y"] == expected_y
    # Explicit provider left/right labels follow the identical rule.  These
    # are source-native records, never cross-provider joins.
    labelled = ((14062150, 6390464, "left", 43.2, 55.8), (14062167, 6517932, "right", 33.5, 38.3))
    for match_id, event_id, label, expected_origin_y, expected_target_y in labelled:
        raw = next(shot for shot in snapshots[match_id]["data"]["shotmap"] if shot.get("id") == event_id)
        projected = next(shot for shot in included["events"] if shot["identity"] == {
            "mappingKey": "194165:35:77333", "sourcePlayerId": PLAYER, "matchId": match_id, "shotId": event_id,
        })
        assert raw["goalMouthLocation"] == label
        assert projected["plot"]["y"] == expected_origin_y
        assert projected["goalPlaneProjection"]["y"] == raw["goalMouthCoordinates"]["y"] == expected_target_y
    assert included["snapshotRevision"] == excluded["snapshotRevision"]
