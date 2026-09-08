from copy import deepcopy
import csv
import json
from pathlib import Path

import pytest

from api_server.native_body_part_sources import aggregate_mapped_native_body_parts


def mapping():
    return {"fotmob_player_id": "194165", "sportsapi_player_id": "108579", "tournament_id": "35",
            "season_id": "77333", "season_name": "2025/2026", "competition_name": "Bundesliga",
            "heatmap_key": "194165:35:77333"}


def manifest():
    return {"tournamentId": 35, "seasonId": 77333, "seasonName": "2025/2026", "competition": "Bundesliga",
            "matchIds": [1, 2], "finishedExactContextMatchCount": 2}


def event(player=108579, body="left-foot", identity=1, situation="regular", xg=0.1, xgot=0.2):
    return {"id": identity, "player": {"id": player}, "bodyPart": body, "shotType": "goal",
            "situation": situation, "xg": xg, "xgot": xgot,
            "playerCoordinates": "not consumed", "draw": "not consumed", "sourceEventId": "not joined"}


def payload(match_id, events):
    return {"success": True, "matchId": match_id, "endpoint": "shotmap", "data": {"shotmap": events}}


def test_exact_source_player_filter_projection_and_input_purity():
    row, source_manifest = mapping(), manifest()
    snapshots = {1: payload(1, [event(), event(player=999)]), 2: payload(2, [])}
    original = deepcopy((row, source_manifest, snapshots))
    result = aggregate_mapped_native_body_parts(row, source_manifest, snapshots)
    assert (row, source_manifest, snapshots) == original
    assert result["source"]["provider"] == "sportsapi"
    assert result["aggregate"]["coverage"]["state"] == "complete"
    assert result["aggregate"]["admittedShotCount"] == 1
    assert result["aggregate"]["categories"]["leftFoot"]["shots"] == 1
    assert "sourceEventId" not in json.dumps(result) and "Coordinates" not in json.dumps(result)


@pytest.mark.parametrize("field,value", [("fotmob_player_id", "11"), ("season_name", "2024/2025"),
                                        ("sportsapi_player_id", True), ("competition_name", "Premier League")])
def test_mapping_context_cannot_cross_manifest(field, value):
    with pytest.raises(ValueError):
        aggregate_mapped_native_body_parts({**mapping(), field: value}, manifest(), {})


@pytest.mark.parametrize("broken", [None, {"success": False}, payload(9, []),
                                     payload(1, [event(situation="unknown")]), payload(1, [{"id": 1}])])
def test_present_malformed_is_invalid_not_missing_or_zero(broken):
    result = aggregate_mapped_native_body_parts(mapping(), manifest(), {1: broken})["aggregate"]
    assert result["coverage"]["invalidMatchIds"] == [1]
    assert result["coverage"]["missingMatchIds"] == [2]
    assert result["coverage"]["state"] == "unavailable"
    assert result["admittedShotCount"] is None


def test_partial_and_observed_empty_distinguished():
    partial = aggregate_mapped_native_body_parts(mapping(), manifest(), {1: payload(1, [])})["aggregate"]
    assert partial["coverage"]["state"] == "partial" and partial["admittedShotCount"] == 0
    complete = aggregate_mapped_native_body_parts(mapping(), manifest(), {1: payload(1, []), 2: payload(2, [])})["aggregate"]
    assert complete["coverage"]["state"] == "complete" and complete["admittedShotCount"] == 0


def test_body_unknown_and_penalty_situation_are_normalized_without_goaltype_inference():
    snapshots = {1: payload(1, [event(body=None, identity=1), event(body="volley", identity=2),
                                event(body="other", identity=3), event(identity=4, situation="penalty")]),
                 2: payload(2, [])}
    result = aggregate_mapped_native_body_parts(mapping(), manifest(), snapshots, include_penalties=False)["aggregate"]
    assert result["coverage"]["state"] == "complete"
    assert (result["admittedShotCount"], result["excludedPenaltyShots"], result["filteredShotCount"]) == (4, 1, 3)
    assert (result["categories"]["unknown"]["shots"], result["categories"]["unknown"]["goals"]) == (2, 2)
    assert (result["categories"]["other"]["shots"], result["categories"]["other"]["goals"]) == (1, 1)
    invalid = aggregate_mapped_native_body_parts(mapping(), manifest(), {1: payload(1, [event(body={})])})["aggregate"]
    assert invalid["coverage"]["invalidMatchIds"] == [1]
    missing_situation = aggregate_mapped_native_body_parts(mapping(), manifest(), {1: payload(1, [{key: value for key, value in event().items() if key != "situation"}])})["aggregate"]
    assert missing_situation["coverage"]["invalidMatchIds"] == [1]


def test_manifest_counts_and_unselected_matches_rejected():
    for invalid in ({**manifest(), "finishedExactContextMatchCount": 3}, {**manifest(), "matchIds": [1, 1]},
                    {**manifest(), "matchIds": [1], "finishedExactContextMatchCount": True}):
        with pytest.raises(ValueError):
            aggregate_mapped_native_body_parts(mapping(), invalid, {})
    with pytest.raises(ValueError):
        aggregate_mapped_native_body_parts(mapping(), manifest(), {3: payload(3, [])})


def test_recorded_kane_mapping_manifest_and_native_vector():
    root = Path(__file__).resolve().parents[1] / "data"
    manifest_path = root / "harvest/match-event-manifests-v1/domestic/bundesliga/77333/manifest-main-stage.json"
    raw_root = root / "harvest/match-shotmaps-v1/domestic/bundesliga/77333"
    if not manifest_path.is_file() or not raw_root.is_dir():
        pytest.skip("saved native fixture absent")
    with (root / "tactical_3zone_ratio.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row["heatmap_key"] == "194165:35:77333" and row["season_name"] == "2025/2026"]
    assert len(rows) == 1
    with manifest_path.open(encoding="utf-8") as handle:
        selected = json.load(handle)
    snapshots = {}
    for match_id in selected["matchIds"]:
        path = raw_root / f"{match_id}.json"
        if path.is_file():
            with path.open(encoding="utf-8") as handle:
                snapshots[match_id] = json.load(handle)
    result = aggregate_mapped_native_body_parts(rows[0], selected, snapshots)["aggregate"]
    assert len(result["coverage"]["expectedMatchIds"]) == 308
    assert result["coverage"]["state"] == "complete", result["coverage"]
    assert result["admittedShotCount"] == 119
    assert [result["categories"][category]["shots"] for category in ("head", "leftFoot", "rightFoot", "other", "unknown")] == [15, 20, 84, 0, 0]
    assert [result["categories"][category]["goals"] for category in ("head", "leftFoot", "rightFoot", "other", "unknown")] == [3, 6, 27, 0, 0]
    assert (result["excludedPenaltyShots"], result["excludedPenaltyGoals"], result["filteredShotCount"], result["filteredGoalCount"]) == (0, 0, 119, 36)
    excluded = aggregate_mapped_native_body_parts(rows[0], selected, snapshots, include_penalties=False)["aggregate"]
    assert (excluded["admittedShotCount"], excluded["excludedPenaltyShots"], excluded["excludedPenaltyGoals"], excluded["filteredShotCount"], excluded["filteredGoalCount"]) == (119, 11, 10, 108, 26)
    assert [excluded["categories"][category]["shots"] for category in ("head", "leftFoot", "rightFoot", "other", "unknown")] == [15, 20, 73, 0, 0]
    assert [excluded["categories"][category]["goals"] for category in ("head", "leftFoot", "rightFoot", "other", "unknown")] == [3, 6, 17, 0, 0]
    assert result["categories"]["leftFoot"]["quality"] == {"xg": 3.687, "xgot": 5.2205, "delta": 1.5335, "eligible": 19, "state": "partial"}
    assert result["categories"]["rightFoot"]["quality"] == {"xg": 20.1047, "xgot": 21.6327, "delta": 1.528, "eligible": 84, "state": "complete"}
    assert excluded["categories"]["leftFoot"]["quality"]["state"] == "partial"
    assert excluded["filteredShotCount"] == 108


@pytest.mark.parametrize("metric", [True, "0.1", -0.1, float("nan"), float("inf")])
def test_malformed_native_metric_invalidates_entire_present_match(metric):
    result = aggregate_mapped_native_body_parts(mapping(), manifest(), {1: payload(1, [event(xg=metric)]), 2: payload(2, [])})["aggregate"]
    assert result["coverage"]["state"] == "partial"
    assert result["coverage"]["invalidMatchIds"] == [1]
    assert "xg" in result["coverage"]["invalidReasons"]["1"]
