from __future__ import annotations

from copy import deepcopy
from itertools import permutations

import pytest

from api_server.native_pitch_box_core import BOX_MIN_X, calculate_native_box


def event(mapping_key, match_id, shot_id, x, y, *, is_penalty=False, shot_type="miss", xg=0.1, xgot=0.2, source_player_id=1, plot_state="projected"):
    # mappingKey must be a real "positiveId:positiveId:positiveId" string —
    # the short mnemonic "m" used throughout this file's call sites maps to
    # one fixed valid triple, since these tests only need a stable identity,
    # not a specific mapping key value.
    real_mapping_key = "194165:35:77333" if mapping_key == "m" else mapping_key
    return {
        "identity": {"mappingKey": real_mapping_key, "sourcePlayerId": source_player_id, "matchId": match_id, "shotId": shot_id},
        "isPenalty": is_penalty,
        "shotType": shot_type,
        "xg": xg,
        "xgot": xgot,
        "plot": {"state": plot_state, "x": None if plot_state == "unlocated" else x, "y": None if plot_state == "unlocated" else y},
    }


def test_boundary_partition_and_accounting():
    events = [
        event("m", 1, 1, BOX_MIN_X, 21.82, shot_type="goal"),  # L2 lower bound
        event("m", 1, 2, BOX_MIN_X, 37.0),  # L3R lower bound
        event("m", 1, 3, BOX_MIN_X, 49.9999),
        event("m", 1, 4, BOX_MIN_X, 50.0, shot_type="goal"),  # ordinary centre line is L3L
        event("m", 1, 5, BOX_MIN_X, 63.0),  # L4 lower bound
        event("m", 1, 6, 100.0, 78.1799),
        event("m", 1, 7, 100.0, 78.18),  # upper y boundary is outside
        event("m", 1, 8, 84.2899, 50.0),  # depth boundary is outside
        event("m", 1, 9, 89.524, 50.0, is_penalty=True, shot_type="goal", xg=0.79, xgot=0.9),  # real PK, classified by isPenalty alone
        event("m", 1, 10, 89.5240001, 50.0),  # NOT a penalty — native never matches by coordinate
    ]

    result = calculate_native_box(events)

    assert result["definitionVersion"] == "native-display-box-subregion-v1"
    assert result["coordinateDefinition"] == "sportsapi-draw-pitch-display-v1"
    assert result["regionOrder"] == ["L4", "L3L", "L3R", "L2"]
    assert result["regions"]["L2"]["shots"] == 1
    assert result["regions"]["L3R"]["shots"] == 2
    assert result["regions"]["L3L"]["shots"] == 2
    assert result["regions"]["L4"]["shots"] == 2
    assert result["regions"]["L3L"]["goals"] == 1
    assert result["accounting"]["penalties"]["shots"] == 1
    assert result["accounting"]["penalties"]["goals"] == 1
    assert result["accounting"]["outside"]["shots"] == 2
    assert result["accounting"]["unlocated"]["shots"] == 0
    assert result["accounting"]["source"]["shots"] == 10
    assert result["accounting"]["reconciles"] is True
    assert result["denominators"]["selectedNonPenaltyShots"] == 9


def test_native_penalty_status_is_isPenalty_only_never_coordinate():
    # nativePK=true at a point that is NOT the legacy exact PK spot — still excluded from regions.
    penalty_elsewhere = event("m", 1, 1, 90.0, 45.0, is_penalty=True, shot_type="goal")
    # nativePK=false sitting exactly on the legacy PK spot — still an ordinary shot, lands in L3L.
    ordinary_at_legacy_spot = event("m", 1, 2, 89.524, 50.0, is_penalty=False)

    result = calculate_native_box([penalty_elsewhere, ordinary_at_legacy_spot])

    assert result["accounting"]["penalties"]["shots"] == 1
    assert result["regions"]["L3R"]["shots"] == 0  # (90, 45) would have been L3R if not for isPenalty
    assert result["regions"]["L3L"]["shots"] == 1  # the legacy-PK-coordinate shot, counted as ordinary


def test_unlocated_non_penalty_is_its_own_bucket_and_counts_in_the_denominator():
    located = event("m", 1, 1, 90.0, 55.0)
    unlocated = event("m", 1, 2, None, None, plot_state="unlocated")

    result = calculate_native_box([located, unlocated])

    assert result["accounting"]["unlocated"]["shots"] == 1
    assert result["accounting"]["outside"]["shots"] == 0  # unlocated is never folded into outside
    assert result["denominators"]["selectedNonPenaltyShots"] == 2  # unlocated still counts toward the denominator
    assert result["accounting"]["reconciles"] is True


def test_quality_paired_zero_null_partial_and_all_missing():
    events = [
        event("m", 1, 1, 90, 70, xg=0.0, xgot=0.0),
        event("m", 1, 2, 90, 55, xg=0.11114, xgot=0.22225),
        event("m", 1, 3, 90, 55, xg=0.22225, xgot=None),
        event("m", 1, 4, 90, 45, xg=None, xgot=None),
    ]

    result = calculate_native_box(events)

    l4 = result["regions"]["L4"]
    assert l4["xg"] == 0.0 and l4["xgEligible"] == 1
    assert l4["quality"] == {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 1, "state": "complete"}
    l3l = result["regions"]["L3L"]
    assert l3l["xg"] == 0.3334 and l3l["xgEligible"] == 2
    assert l3l["quality"] == {"xg": 0.1111, "xgot": 0.2223, "delta": 0.1112, "eligible": 1, "state": "partial"}
    l3r = result["regions"]["L3R"]
    assert l3r["xg"] is None and l3r["xgEligible"] == 0
    assert l3r["quality"]["state"] == "unavailable"


def test_observed_empty_is_distinct_from_source_unavailable():
    empty = calculate_native_box([])
    unavailable = calculate_native_box(None)

    assert empty["source"] == {"state": "observed", "records": 0}
    assert empty["denominators"] == {"selectedNonPenaltyShots": 0}
    assert empty["regions"]["L4"]["shots"] == 0
    assert empty["regions"]["L4"]["xg"] == 0.0
    assert empty["regions"]["L4"]["quality"] == {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}
    assert empty["regions"]["L4"]["shootingSharePct"] is None
    assert empty["accounting"]["reconciles"] is True

    assert unavailable["source"]["state"] == "unavailable"
    assert unavailable["regions"]["L4"]["shots"] is None
    assert unavailable["regions"]["L4"]["shootingSharePct"] is None
    assert unavailable["accounting"]["reconciles"] is None
    assert unavailable["denominators"]["selectedNonPenaltyShots"] is None


def test_permutation_invariance_and_input_purity():
    events = [
        event("m", 1, 1, 90, 70, xg=0.1, xgot=0.2),
        event("m", 1, 2, 90, 55, xg=0.2, xgot=0.3),
        event("m", 1, 3, 80, 50),
        event("m", 1, 4, 89.524, 50, is_penalty=True),
    ]
    original = deepcopy(events)
    expected = calculate_native_box(events)

    assert events == original
    for ordered in permutations(events):
        assert calculate_native_box(list(ordered)) == expected


def test_shooting_share_is_a_0_to_100_percentage_not_a_0_to_1_ratio():
    events = [event("m", 1, i, 90, 70) for i in range(1, 5)] + [event("m", 1, 5, 90, 45)]
    result = calculate_native_box(events)
    assert result["denominators"]["selectedNonPenaltyShots"] == 5
    assert result["regions"]["L4"]["shootingSharePct"] == 80.0
    assert result["regions"]["L3R"]["shootingSharePct"] == 20.0


def test_duplicate_identity_is_rejected():
    duplicate = event("m", 1, 1, 90, 55)
    with pytest.raises(ValueError):
        calculate_native_box([duplicate, deepcopy(duplicate)])


@pytest.mark.parametrize(
    "corrupt_event",
    [
        {**event("m", 1, 1, 90, 50), "xg": None},  # missing→None is fine on its own; this is the control case (must NOT raise)
    ],
)
def test_control_case_missing_metric_is_not_an_error(corrupt_event):
    # sanity control: a genuinely-null (unobserved) xg alone must not raise —
    # only the malformed shapes in the next test should.
    calculate_native_box([corrupt_event])


@pytest.mark.parametrize(
    "make_bad_event",
    [
        lambda: {**event("m", 1, 1, 90, 50), "xg": float("nan")},
        lambda: {**event("m", 1, 1, 90, 50), "xg": -0.01},
        lambda: {**event("m", 1, 1, 90, 50), "xgot": True},
        lambda: {**event("m", 1, 1, 90, 50), "shotType": "on_target"},  # not one of the 5 native shot types
        lambda: {**event("m", 1, 1, 90, 50), "isPenalty": "true"},
        lambda: {**event("m", 1, 1, float("nan"), 50)},
        lambda: {**event("m", 1, 1, 101, 50)},
        lambda: {**event("m", 1, 1, True, 50)},
        lambda: {**event("m", 1, 1, 90, 50, plot_state="unlocated"), "plot": {"state": "unlocated", "x": 90, "y": 50}},  # unlocated must have null x/y
        lambda: {**event("m", 1, 1, 90, 50), "identity": {"mappingKey": "m", "sourcePlayerId": 1, "matchId": 1}},  # missing shotId
        lambda: {**event("m", 1, 1, 90, 50), "identity": {"mappingKey": "m", "sourcePlayerId": 1, "matchId": 1, "shotId": None}},
    ],
)
def test_invalid_input_fails_closed(make_bad_event):
    with pytest.raises(ValueError):
        calculate_native_box([make_bad_event()])


@pytest.mark.parametrize(
    ("field", "bad_value"),
    [
        ("sourcePlayerId", 0),
        ("sourcePlayerId", -1),
        ("sourcePlayerId", None),
        ("sourcePlayerId", "1"),
        ("sourcePlayerId", 1.5),
        ("sourcePlayerId", True),
        ("sourcePlayerId", [1]),
        ("sourcePlayerId", {"id": 1}),
        ("matchId", 0),
        ("matchId", -1),
        ("shotId", 0),
        ("shotId", None),
        ("mappingKey", "m"),  # not colon-triple shaped
        ("mappingKey", "1:2"),  # only two segments
        ("mappingKey", "1:2:0"),  # a zero segment is not positive
        ("mappingKey", "1:-2:3"),
        ("mappingKey", "01:35:77333"),  # leading zero — not a canonical positive-integer segment
        ("mappingKey", "194165:035:77333"),
        ("mappingKey", "194165:35:077333"),
        ("mappingKey", "１９４１６５:35:77333"),  # full-width Unicode digits — isdigit() alone would wrongly accept this
        ("mappingKey", "194165:٤٥:77333"),  # Arabic-Indic Unicode digits
        ("mappingKey", 194165),  # a bare number, not the 'a:b:c' string shape
        ("mappingKey", ["194165", "35", "77333"]),  # would raise an unrelated TypeError from set() before this fix
        ("mappingKey", {"a": 1}),
        ("mappingKey", None),
    ],
)
def test_identity_field_validation_fails_closed_and_never_lets_an_unhashable_value_reach_the_dedup_set(field, bad_value):
    base = event("m", 1, 1, 90, 55)
    base["identity"][field] = bad_value
    with pytest.raises(ValueError):
        calculate_native_box([base])


def test_accepts_a_genuine_canonical_ascii_positive_triple_mapping_key():
    base = event("m", 1, 1, 90, 55)
    base["identity"]["mappingKey"] = "194165:35:77333"
    result = calculate_native_box([base])
    assert result["accounting"]["source"]["shots"] == 1


def test_never_reuses_legacy_calculate_box_subregions_penalty_logic():
    # A non-penalty event sitting exactly on the legacy exact-PK coordinate
    # must land as an ORDINARY L3L shot here — proving this module does not
    # delegate penalty classification to the legacy exact-coordinate check.
    result = calculate_native_box([event("m", 1, 1, 89.524, 50.0, is_penalty=False)])
    assert result["accounting"]["penalties"]["shots"] == 0
    assert result["regions"]["L3L"]["shots"] == 1
