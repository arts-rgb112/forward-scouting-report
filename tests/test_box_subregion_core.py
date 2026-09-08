from __future__ import annotations

from copy import deepcopy
from itertools import permutations

import pytest

from api_server.box_subregion_core import BOX_MIN_X, calculate_box_subregions


def shot(x, y, outcome="miss", xg=0.1, xgot=0.2):
    return {"x": x, "y": y, "outcome": outcome, "xg": xg, "xgot": xgot}


def activity(x, y, count):
    return {"x": x, "y": y, "count": count}


def test_boundary_partition_exact_penalty_and_accounting():
    shots = [
        shot(BOX_MIN_X, 21.82, "goal"),  # L2 lower bound
        shot(BOX_MIN_X, 37.0),  # L3R lower bound
        shot(BOX_MIN_X, 49.9999),
        shot(BOX_MIN_X, 50.0, "goal"),  # ordinary centre line is L3L
        shot(BOX_MIN_X, 63.0),  # L4 lower bound
        shot(100.0, 78.1799),
        shot(100.0, 78.18),  # upper boundary is outside
        shot(84.2899, 50.0),  # depth boundary is outside
        shot(89.524, 50.0, "goal", 0.79, 0.9),  # exact PK only
        shot(89.5240001, 50.0),  # not an approximate PK
    ]

    result = calculate_box_subregions(shots, [])

    assert result["regionOrder"] == ["L4", "L3L", "L3R", "L2"]
    assert result["regions"]["L2"]["shots"] == 1
    assert result["regions"]["L3R"]["shots"] == 2
    assert result["regions"]["L3L"]["shots"] == 2
    assert result["regions"]["L4"]["shots"] == 2
    assert result["regions"]["L3L"]["goals"] == 1
    assert result["accounting"]["penalties"]["shots"] == 1
    assert result["accounting"]["penalties"]["goals"] == 1
    assert result["accounting"]["outside"]["shots"] == 2
    assert result["accounting"]["source"]["shots"] == 10
    assert result["accounting"]["reconciles"] is True
    assert result["denominators"]["selectedNonPenaltyShots"] == 9


def test_weighted_activity_conservation_and_explicit_shares():
    shots = [shot(90, 70), shot(90, 55), shot(90, 45), shot(90, 30), shot(80, 30), shot(89.524, 50)]
    points = [activity(90, 70, 38), activity(90, 55, 79), activity(90, 45, 68), activity(90, 30, 37), activity(80, 30, 1)]

    result = calculate_box_subregions(shots, points)

    assert [result["regions"][region]["activity"] for region in result["regionOrder"]] == [38, 79, 68, 37]
    assert sum(result["regions"][region]["activity"] for region in result["regionOrder"]) == 222
    assert result["denominators"] == {"selectedNonPenaltyShots": 5, "fullActivityCount": 223}
    assert result["activityAccounting"] == {"source": 223, "inRegions": 222, "outside": 1, "reconciles": True}
    assert result["regions"]["L4"]["shootingShare"] == 0.2
    assert result["regions"]["L4"]["activityShare"] == round(38 / 223, 4)


def test_xg_zero_null_partial_all_missing_and_rounding_semantics():
    shots = [
        shot(90, 70, xg=0.0, xgot=0.0),
        shot(90, 55, xg=0.11114, xgot=0.22225),
        shot(90, 55, xg=0.22225, xgot=None),
        shot(90, 45, xg=None, xgot=None),
    ]

    result = calculate_box_subregions(shots, [])

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
    empty = calculate_box_subregions([], [])
    unavailable = calculate_box_subregions(None, None)

    assert empty["sources"] == {"shots": {"state": "observed", "records": 0}, "activity": {"state": "observed", "records": 0}}
    assert empty["denominators"] == {"selectedNonPenaltyShots": 0, "fullActivityCount": 0}
    assert empty["regions"]["L4"]["shots"] == 0
    assert empty["regions"]["L4"]["activity"] == 0
    assert empty["regions"]["L4"]["xg"] == 0.0
    assert empty["regions"]["L4"]["quality"] == {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}
    assert empty["regions"]["L4"]["shootingShare"] is None
    assert unavailable["sources"]["shots"]["state"] == "unavailable"
    assert unavailable["regions"]["L4"]["shots"] is None
    assert unavailable["regions"]["L4"]["activity"] is None
    assert unavailable["accounting"]["reconciles"] is None


def test_core_never_cross_joins_or_infers_missing_source_records():
    source_a = [shot(90, 70, "goal", 0.2, 0.3)]
    unrelated_source_b = [shot(90, 45, "goal", 0.9, 1.0)]

    only_a = calculate_box_subregions(source_a, [])
    only_b = calculate_box_subregions(unrelated_source_b, [])

    assert only_a["regions"]["L4"]["shots"] == 1
    assert only_a["regions"]["L3R"]["shots"] == 0
    assert only_b["regions"]["L4"]["shots"] == 0
    assert only_b["regions"]["L3R"]["shots"] == 1


def test_permutation_invariance_and_input_purity():
    shots = [shot(90, 70, xg=0.1, xgot=0.2), shot(90, 55, xg=0.2, xgot=0.3), shot(80, 50), shot(89.524, 50)]
    points = [activity(90, 70, 2), activity(90, 55, 3), activity(80, 50, 4)]
    original_shots, original_points = deepcopy(shots), deepcopy(points)
    expected = calculate_box_subregions(shots, points)

    assert shots == original_shots and points == original_points
    for ordered_shots in permutations(shots):
        assert calculate_box_subregions(ordered_shots, reversed(points)) == expected


@pytest.mark.parametrize(
    ("shots", "points"),
    [
        ([shot(float("nan"), 50)], []),
        ([shot(True, 50)], []),
        ([shot(101, 50)], []),
        ([shot(90, 50, outcome="mystery")], []),
        ([{"x": 90, "y": 50, "outcome": "miss", "xg": float("inf"), "xgot": 0.1}], []),
        ([], [activity(90, 50, -1)]),
        ([], [activity(90, 50, True)]),
        ([], [activity(-0.1, 50, 1)]),
    ],
)
def test_invalid_input_fails_closed(shots, points):
    with pytest.raises(ValueError):
        calculate_box_subregions(shots, points)


def test_quality_rejects_negative_values_but_preserves_observed_values_above_one():
    for record in (shot(90, 55, xg=-0.01), shot(90, 55, xgot=-0.01)):
        with pytest.raises(ValueError):
            calculate_box_subregions([record], [])
    result = calculate_box_subregions([shot(90, 55, xg=1.2, xgot=1.5)], [])
    assert result["regions"]["L3L"]["quality"] == {"xg": 1.2, "xgot": 1.5, "delta": 0.3, "eligible": 1, "state": "complete"}


def test_quality_uses_v3_builtin_sum_then_rounding_order():
    xg_values = [0.11111, 0.22222, 0.33333]
    xgot_values = [0.44444, 0.55555, 0.66666]
    result = calculate_box_subregions(
        [shot(90, 55, xg=xg, xgot=xgot) for xg, xgot in zip(xg_values, xgot_values)], []
    )
    quality = result["regions"]["L3L"]["quality"]
    expected_xg, expected_xgot = round(sum(xg_values), 4), round(sum(xgot_values), 4)
    assert quality == {"xg": expected_xg, "xgot": expected_xgot,
                       "delta": round(expected_xgot - expected_xg, 4), "eligible": 3, "state": "complete"}
