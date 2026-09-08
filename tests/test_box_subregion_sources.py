from __future__ import annotations

from copy import deepcopy
from itertools import permutations
import json
from pathlib import Path

import pytest

from api_server.box_subregion_sources import aggregate_selected_box_sources


def context(fotmob, sports, tournament=35, season_id=77333, season="2025/2026"):
    return {"fotmobPlayerId": fotmob, "sportsapiPlayerId": sports, "tournamentId": tournament,
            "seasonId": season_id, "season": season}


def shot(x, y, outcome="miss", xg=0.1, xgot=0.2, **extra):
    return {"x": x, "y": y, "outcome": outcome, "xg": xg, "xgot": xgot, **extra}


def activity(*points):
    return {"success": True, "data": {"points": list(points)}}


def test_exact_two_context_merge_preserves_core_semantics_and_ignores_extras():
    contexts = [context(10, 110), context(10, 220, tournament=7, season_id=77777)]
    shots = {
        "10:35:77333": [shot(90, 70, "goal", 0.2, 0.3, trajectory={"not": "used"}), shot(89.524, 50, "goal", 0.8, 0.9)],
        "10:7:77777": [shot(90, 55, xg=0.4, xgot=0.6)],
    }
    points = {
        "110:35:77333": activity({"x": 90, "y": 70, "count": 4}),
        "220:7:77777": activity({"x": 90, "y": 55, "count": 6}),
    }

    result = aggregate_selected_box_sources(contexts, shots, points)

    assert result["coverage"]["shots"]["state"] == result["coverage"]["activity"]["state"] == "observed"
    assert result["aggregate"]["denominators"] == {"selectedNonPenaltyShots": 2, "fullActivityCount": 10}
    assert result["aggregate"]["regions"]["L4"]["shots"] == 1
    assert result["aggregate"]["regions"]["L3L"]["shots"] == 1
    assert result["aggregate"]["regions"]["L4"]["quality"]["delta"] == 0.1
    assert result["aggregate"]["accounting"]["penalties"]["shots"] == 1


def test_missing_parts_fully_missing_and_observed_empty_are_distinct():
    contexts = [context(10, 110), context(10, 220, tournament=7, season_id=77777)]
    partial = aggregate_selected_box_sources(contexts, {"10:35:77333": []}, {"220:7:77777": activity()})
    assert partial["coverage"]["shots"] == {
        "state": "partial", "expectedKeys": ["10:35:77333", "10:7:77777"],
        "observedKeys": ["10:35:77333"], "missingKeys": ["10:7:77777"],
    }
    assert partial["coverage"]["activity"]["state"] == "partial"
    assert partial["aggregate"]["sources"]["shots"] == {"state": "observed", "records": 0}
    assert partial["aggregate"]["sources"]["activity"] == {"state": "observed", "records": 0}
    missing = aggregate_selected_box_sources(contexts, {}, {})
    assert missing["coverage"]["shots"]["state"] == missing["coverage"]["activity"]["state"] == "unavailable"
    assert missing["aggregate"]["sources"]["shots"]["state"] == "unavailable"


@pytest.mark.parametrize(
    ("contexts", "shots", "points"),
    [
        ([], {}, {}),
        ([context(True, 110)], {}, {}),
        ([context(10, 110), context(10, 220)], {}, {}),
        ([context(10, 110), context(10, 110, tournament=7, season_id=77777, season="2024/2025")], {}, {}),
        ([context(10, 110), context(20, 220, tournament=7, season_id=77777)], {}, {}),
        ([context(10, 110)], {1: []}, {}),
        ([context(10, 110)], {"10:35:77333": {"x": 90}}, {}),
        ([context(10, 110)], {}, {"110:35:77333": {"success": False, "data": {"points": []}}}),
        ([context(10, 110)], {}, {"110:35:77333": activity({"x": 90, "y": 50, "count": float("nan")})}),
        ([context(10, 110)], {"10:35:77333": [shot(90, 50, xg=float("nan"))]}, {}),
    ],
)
def test_invalid_context_keys_or_present_payloads_fail_closed(contexts, shots, points):
    with pytest.raises(ValueError):
        aggregate_selected_box_sources(contexts, shots, points)


def test_context_permutations_are_deterministic_and_inputs_unchanged():
    contexts = [context(10, 220, tournament=7, season_id=77777), context(10, 110)]
    shots = {"10:35:77333": [shot(90, 70)], "10:7:77777": [shot(90, 55)]}
    points = {"110:35:77333": activity({"x": 90, "y": 70, "count": 1}),
              "220:7:77777": activity({"x": 90, "y": 55, "count": 2})}
    original = deepcopy((contexts, shots, points))
    expected = aggregate_selected_box_sources(contexts, shots, points)

    for ordered in permutations(contexts):
        assert aggregate_selected_box_sources(ordered, shots, points) == expected
    assert (contexts, shots, points) == original


def test_optional_recorded_kane_source_vector():
    """Read-only proof against recorded sources; unit fixtures remain self-contained."""
    root = Path(__file__).resolve().parents[1]
    shot_path = root / "data" / "tactical_shotmap_points_2025_2026.json"
    activity_path = root / "data" / "harvest" / "heatmaps" / "bundesliga" / "77333" / "108579.json"
    if not shot_path.is_file() or not activity_path.is_file():
        pytest.skip("recorded Kane source files are absent")
    with shot_path.open(encoding="utf-8") as handle:
        shots = json.load(handle)
    with activity_path.open(encoding="utf-8") as handle:
        activity_payload = json.load(handle)
    result = aggregate_selected_box_sources(
        [context(194165, 108579)],
        {"194165:35:77333": shots["194165:35:77333"]},
        {"108579:35:77333": activity_payload},
    )
    aggregate = result["aggregate"]
    assert [aggregate["regions"][region]["shots"] for region in aggregate["regionOrder"]] == [9, 31, 33, 11]
    assert [aggregate["regions"][region]["goals"] for region in aggregate["regionOrder"]] == [2, 7, 11, 0]
    assert [aggregate["regions"][region]["xg"] for region in aggregate["regionOrder"]] == [0.3343, 5.2478, 10.7224, 0.6388]
    assert [aggregate["regions"][region]["activity"] for region in aggregate["regionOrder"]] == [38, 79, 68, 37]
    assert aggregate["denominators"]["selectedNonPenaltyShots"] == 108
    assert aggregate["denominators"]["fullActivityCount"] == 1401
    assert aggregate["accounting"]["source"]["shots"] == 119
    assert aggregate["accounting"]["penalties"]["shots"] == 11
    assert aggregate["accounting"]["outside"]["shots"] == 24
    assert aggregate["accounting"]["inRegions"]["shots"] == 84
    assert aggregate["accounting"]["inRegions"]["goals"] == 20
    assert aggregate["accounting"]["inRegions"]["xg"] == 16.9433
    assert aggregate["regions"]["L3L"]["quality"]["state"] == "partial"
    assert [aggregate["regions"][region]["quality"]["delta"] for region in aggregate["regionOrder"]] == [1.639, 1.7659, 0.7675, -0.3677]
    assert [aggregate["regions"][region]["quality"]["eligible"] for region in aggregate["regionOrder"]] == [9, 30, 33, 11]
    assert sum(aggregate["regions"][region]["quality"]["eligible"] for region in aggregate["regionOrder"]) == 83
