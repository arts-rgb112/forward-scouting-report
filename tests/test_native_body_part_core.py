from __future__ import annotations

from copy import deepcopy
from itertools import permutations

import pytest

from api_server.native_body_part_core import aggregate_native_body_parts


PLAYER = 108579


def record(match_id, event_id, body_part="right-foot", shot_type="miss", player_id=PLAYER,
           is_penalty=False, xg=0.1, xgot=0.2, **extra):
    return {"matchId": match_id, "eventId": event_id, "playerId": player_id,
            "bodyPart": body_part, "shotType": shot_type, "isPenalty": is_penalty, "xg": xg, "xgot": xgot, **extra}


def test_synthetic_119_native_body_part_vector_and_goals():
    payload = (
        [record(1, event_id, "head", "goal" if event_id <= 5 else "miss") for event_id in range(1, 16)]
        + [record(1, event_id, "left-foot", "goal" if event_id <= 21 else "save") for event_id in range(16, 36)]
        + [record(1, event_id, "right-foot", "goal" if event_id <= 60 else "block") for event_id in range(36, 120)]
    )
    result = aggregate_native_body_parts(PLAYER, [1], {1: payload})

    assert result["coverage"]["state"] == "complete"
    assert result["admittedShotCount"] == 119
    assert {key: (value["shots"], value["goals"]) for key, value in result["categories"].items()} == {
        "head": (15, 5), "leftFoot": (20, 6), "rightFoot": (84, 25), "other": (0, 0), "unknown": (0, 0)}
    assert result["categories"]["head"]["quality"] == {"xg": 1.5, "xgot": 3.0, "delta": 1.5, "eligible": 15, "state": "complete"}


def test_missing_invalid_and_valid_empty_sources_are_distinct():
    result = aggregate_native_body_parts(PLAYER, [1, 2, 3], {
        1: [],
        2: [record(2, 1, player_id=999)],
    })
    assert result["coverage"] == {
        "state": "partial", "expectedMatchIds": [1, 2, 3], "validMatchIds": [1],
        "missingMatchIds": [3], "invalidMatchIds": [2], "invalidReasons": {"2": "record playerId mismatch"},
    }
    assert result["admittedShotCount"] == 0
    assert all(values == {"shots": 0, "goals": 0, "quality": {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}} for values in result["categories"].values())
    unavailable = aggregate_native_body_parts(PLAYER, [1], {})
    assert unavailable["coverage"]["state"] == "unavailable"
    assert unavailable["admittedShotCount"] is None
    assert unavailable["categories"]["head"] == {"shots": None, "goals": None, "quality": {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}}
    assert unavailable["excludedPenaltyShots"] is None
    assert unavailable["filteredShotCount"] is None
    complete_empty = aggregate_native_body_parts(PLAYER, [1, 2], {1: [], 2: []})
    assert complete_empty["coverage"]["state"] == "complete"
    assert complete_empty["admittedShotCount"] == 0


@pytest.mark.parametrize(
    "payload",
    [
        [{**record(1, 1), "matchId": 2}],
        [{**record(1, 1), "matchId": True}],
        [{**record(1, 1), "matchId": 1.0}],
        [record(1, 1, player_id=999)],
        [record(1, 1, player_id=108579.0)],
        [record(1, 0)],
        [record(1, 1), record(1, 1)],
        [record(1, 1, body_part=[])],
        [record(1, 1, shot_type="on_target")],
        [record(1, 1, shot_type={})],
        [record(1, 1, is_penalty=1)],
        [record(1, 1, extra="unexpected")],
        {"not": "a list"},
    ],
)
def test_present_invalid_match_is_reported_not_zero_filled(payload):
    result = aggregate_native_body_parts(PLAYER, [1], {1: payload})
    assert result["coverage"]["state"] == "unavailable"
    assert result["coverage"]["invalidMatchIds"] == [1]
    assert result["admittedShotCount"] is None
    assert result["categories"]["rightFoot"]["shots"] is None


def test_global_identity_and_mapping_guards_fail_closed():
    with pytest.raises(ValueError):
        aggregate_native_body_parts(True, [1], {})
    with pytest.raises(ValueError):
        aggregate_native_body_parts(PLAYER, [1, 1], {})
    with pytest.raises(ValueError):
        aggregate_native_body_parts(PLAYER, [1], {"1": []})
    with pytest.raises(ValueError):
        aggregate_native_body_parts(PLAYER, [1], {2: []})


def test_permutation_invariance_and_input_purity():
    payloads = {1: [record(1, 2, "left-foot", "goal"), record(1, 1, "head")],
                2: [record(2, 1, "other", "goal")]}
    original = deepcopy(payloads)
    expected = aggregate_native_body_parts(PLAYER, [1, 2], payloads)
    for matches in permutations([1, 2]):
        assert aggregate_native_body_parts(PLAYER, matches, payloads) == expected
    assert payloads == original


def test_quality_uses_event_identity_order_not_raw_list_order():
    ascending = [record(1, 1, xg=1e16, xgot=1e16), record(1, 2, xg=1.0, xgot=1.0), record(1, 3, xg=1.0, xgot=1.0)]
    shuffled = [ascending[2], ascending[0], ascending[1]]
    assert aggregate_native_body_parts(PLAYER, [1], {1: ascending}) == aggregate_native_body_parts(PLAYER, [1], {1: shuffled})


def test_unknown_is_observed_and_penalty_filter_is_explicit():
    payload = [
        record(1, 1, "unknown", "goal"),
        record(1, 2, "other", "miss"),
        record(1, 3, "right-foot", "goal", is_penalty=True),
        record(1, 4, "right-foot", "miss", is_penalty=True),
    ]
    including = aggregate_native_body_parts(PLAYER, [1], {1: payload})
    assert including["admittedShotCount"] == including["filteredShotCount"] == 4
    assert including["filteredGoalCount"] == 2
    assert including["excludedPenaltyShots"] == including["excludedPenaltyGoals"] == 0
    assert (including["categories"]["unknown"]["shots"], including["categories"]["unknown"]["goals"]) == (1, 1)
    excluding = aggregate_native_body_parts(PLAYER, [1], {1: payload}, include_penalties=False)
    assert excluding["admittedShotCount"] == 4
    assert (excluding["excludedPenaltyShots"], excluding["excludedPenaltyGoals"]) == (2, 1)
    assert (excluding["filteredShotCount"], excluding["filteredGoalCount"]) == (2, 1)
    assert (excluding["categories"]["rightFoot"]["shots"], excluding["categories"]["rightFoot"]["goals"]) == (0, 0)
    assert sum(values["shots"] for values in excluding["categories"].values()) == excluding["filteredShotCount"]
    with pytest.raises(ValueError):
        aggregate_native_body_parts(PLAYER, [1], {1: payload}, include_penalties=1)
    invalid_penalty = [{key: value for key, value in record(1, 1).items() if key != "isPenalty"}]
    assert aggregate_native_body_parts(PLAYER, [1], {1: invalid_penalty})["coverage"]["state"] == "unavailable"


@pytest.mark.parametrize("value", [True, "0.2", -0.1, float("nan"), float("inf")])
def test_malformed_observed_metric_invalidates_whole_match(value):
    result = aggregate_native_body_parts(PLAYER, [1], {1: [record(1, 1, xg=value)]})
    assert result["coverage"]["state"] == "unavailable"
    assert "xg" in result["coverage"]["invalidReasons"]["1"]


def test_missing_metrics_are_not_zero_and_partial_quality_is_preserved():
    result = aggregate_native_body_parts(PLAYER, [1], {1: [record(1, 1, "left-foot", xg=0.2, xgot=0.4), record(1, 2, "left-foot", xg=0.3, xgot=None)]})
    assert result["categories"]["leftFoot"]["quality"] == {"xg": 0.2, "xgot": 0.4, "delta": 0.2, "eligible": 1, "state": "partial"}
