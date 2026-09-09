from copy import deepcopy
import json
from pathlib import Path

import pytest

from api_server.box_subregion_contract import BoxContext
from api_server.native_pitch_v2_contract import NativePitchV2Envelope, build_native_pitch_v2_envelope
from api_server.native_pitch_v2_core import _box_region, _grid_cell


def context(**kwargs):
    return BoxContext(**(dict(playerId=194165, season="2025/2026", mode="league", scope=8, competition=None) | kwargs))


def raw_event(shot_id=1, *, shot_type="goal", body_part="left-foot", x=8.0, y=37.8, xg=.2, xgot=.4, **extra):
    event = {
        "id": shot_id, "player": {"id": 108579}, "bodyPart": body_part, "shotType": shot_type,
        "situation": "regular", "xg": xg, "xgot": xgot,
        "playerCoordinates": {"x": x, "y": y, "z": 0.0},
        "goalMouthCoordinates": {"x": 0.0, "y": 45.7, "z": 8.2},
        "draw": {"start": {"x": y, "y": x}, "end": {"x": 54.3, "y": 0.0}},
    }
    event.update(extra)
    return event


def source(events):
    row = {"fotmob_player_id": "194165", "sportsapi_player_id": "108579", "tournament_id": "35",
           "season_id": "77333", "season_name": "2025/2026", "competition_name": "Bundesliga", "heatmap_key": "194165:35:77333"}
    manifest = {"tournamentId": 35, "seasonId": 77333, "seasonName": "2025/2026", "competition": "Bundesliga",
                "matchIds": [1], "finishedExactContextMatchCount": 1}
    return row, manifest, {1: {"success": True, "matchId": 1, "endpoint": "shotmap", "data": {"shotmap": events}}}


def envelope(events, **kwargs):
    return build_native_pitch_v2_envelope(context(), [source(events)], **kwargs)


def provider_examples():
    goal = raw_event(5473386, shot_type="goal", x=8, y=37.8,
                     goalMouthCoordinates={"x": 0, "y": 45.7, "z": 8.2},
                     draw={"start": {"x": 37.8, "y": 8}, "end": {"x": 54.3, "y": 0}, "goal": {"x": 54.3, "y": 91.8}})
    save = raw_event(5472520, shot_type="save", x=7.6, y=67.2,
                     blockCoordinates={"x": 1, "y": 52.5, "z": 0},
                     draw={"start": {"x": 67.2, "y": 7.6}, "block": {"x": 52.5, "y": 1}, "end": {"x": 50.3, "y": 0}})
    head_save = raw_event(6390845, shot_type="save", body_part="head", x=8.5, y=43.4,
                          blockCoordinates={"x": 2.5, "y": 49.6, "z": 0},
                          draw={"start": {"x": 43.4, "y": 8.5}, "block": {"x": 49.6, "y": 2.5}, "end": {"x": 48.8, "y": 0}})
    miss = raw_event(5472446, shot_type="miss", x=13.6, y=56.8,
                     goalMouthCoordinates={"x": 0, "y": 56.8, "z": 45.8},
                     draw={"start": {"x": 56.8, "y": 13.6}, "end": {"x": 43.2, "y": 0}})
    post = raw_event(6390464, shot_type="post", body_part="right-foot", x=6.4, y=56.8,
                     goalMouthCoordinates={"x": 0, "y": 55.8, "z": 1.9},
                     draw={"start": {"x": 56.8, "y": 6.4}, "end": {"x": 44.2, "y": 0}})
    return goal, save, head_save, miss, post


def test_v2_uses_only_outcome_validated_terminals_for_named_provider_examples():
    result = envelope(list(provider_examples()))
    by_id = {event.identity.shotId: event for event in result.events}
    assert by_id[5473386].destination.model_dump() == {"kind": "goal_plane", "x": 100.0, "y": 45.7, "observedHeightMeters": None, "reason": None}
    assert by_id[5472520].destination.model_dump() == {"kind": "block", "x": 99.0, "y": 47.5, "observedHeightMeters": None, "reason": None}
    assert by_id[6390845].destination.model_dump() == {"kind": "block", "x": 97.5, "y": 50.4, "observedHeightMeters": None, "reason": None}
    assert by_id[5472446].destination.kind == by_id[6390464].destination.kind == "unavailable"
    assert by_id[5472446].destination.reason == by_id[6390464].destination.reason == "terminal_coordinate_unavailable_for_outcome"
    assert all(event.destination.observedHeightMeters is None for event in result.events)


def test_v2_block_disagreement_fails_closed_without_goal_plane_fallback():
    save = provider_examples()[1]
    bad = deepcopy(save)
    bad["draw"]["block"]["x"] = 51.0
    result = envelope([bad])
    assert result.events[0].destination.model_dump() == {"kind": "unavailable", "x": None, "y": None,
                                                          "observedHeightMeters": None, "reason": "native_block_coordinate_mismatch"}


def test_v2_grid_follows_pk_filter_but_box_stays_nonpk_and_regions_conserve():
    first, second, third, miss, post = provider_examples()
    penalty = deepcopy(first)
    penalty["id"] = 99
    penalty["situation"] = "penalty"
    penalty["bodyPart"] = "right-foot"
    included = envelope([first, second, third, miss, post, penalty])
    excluded = envelope([first, second, third, miss, post, penalty], include_penalties=False)
    assert len(included.events) == 6 and len(excluded.events) == 5
    assert included.selectionZones.gridAccounting.source == 6
    assert excluded.selectionZones.gridAccounting.source == 5
    assert included.selectionZones.boxAccounting.denominator == excluded.selectionZones.boxAccounting.denominator == 5
    assert included.selectionZones.boxAccounting.reconciles is True
    assert sum(zone.shots for zone in included.selectionZones.grid) == included.selectionZones.gridAccounting.assigned
    assert sum(zone.shots for zone in included.selectionZones.box) == included.selectionZones.boxAccounting.inRegions
    assert included.bodyParts.totals.shots == 6 and excluded.bodyParts.totals.shots == 5
    assert included.box.denominator == excluded.box.denominator == 5


def test_v2_zone_parts_quality_and_compat_summaries_are_server_owned():
    goal, save, head_save, miss, post = provider_examples()
    result = envelope([goal, save, head_save, miss, post])
    zone = next(zone for zone in result.selectionZones.grid if zone.shots)
    assert set(zone.parts) == {"head", "rightFoot", "leftFoot", "other", "unknown"}
    assert sum(part.shots for part in zone.parts.values()) == zone.shots
    assert result.bodyParts.schemaVersion == "native-body-part-stats-v2"
    assert result.box.definitionVersion == "native-display-box-subregion-v1"


def test_v2_grid_and_box_boundary_assignment_matches_explicit_bounds_contract():
    def point(x, y):
        return {"plot": {"state": "projected", "x": x, "y": y}}

    # Depth/lane boundaries are lower-inclusive: exact 16.67 is depth 2,
    # exact 21.82 is lane 2, and only 100 uses explicit max inclusion.
    assert _grid_cell(point(0.0, 0.0)) == "depth1_lane1"
    assert _grid_cell(point(16.669999, 21.819999)) == "depth1_lane1"
    assert _grid_cell(point(16.67, 21.82)) == "depth2_lane2"
    assert _grid_cell(point(83.33, 78.18)) == "depth6_lane5"
    assert _grid_cell(point(100.0, 100.0)) == "depth6_lane5"
    # Box half-open y taxonomy: 63→L4, 50→L3L, 37→L3R.
    assert _box_region(point(84.29, 63.0)) == "L4"
    assert _box_region(point(84.29, 50.0)) == "L3L"
    assert _box_region(point(84.29, 37.0)) == "L3R"
    assert _box_region(point(100.0, 21.82)) == "L2"

    result = envelope(list(provider_examples()))
    first, last = result.selectionZones.grid[0].bounds, result.selectionZones.grid[-1].bounds
    assert first.model_dump() == {"xMinInclusive": 0.0, "xMax": 16.67, "includeMaxX": False,
                                  "yMinInclusive": 0.0, "yMax": 21.82, "includeMaxY": False}
    assert last.model_dump() == {"xMinInclusive": 83.33, "xMax": 100.0, "includeMaxX": True,
                                 "yMinInclusive": 78.18, "yMax": 100.0, "includeMaxY": True}


def test_canonical_v2_fixture_is_the_strict_builder_response():
    path = Path(__file__).resolve().parents[1] / "docs/fixtures/native_pitch_v2/canonical_response.json"
    assert json.loads(path.read_text(encoding="utf-8")) == envelope(list(provider_examples())).model_dump()


@pytest.mark.parametrize("mutation", [
    lambda value: value["events"][0]["destination"].update(kind="block", x=100.0, y=45.7, reason=None),
    lambda value: value["events"][0]["quality"].update(delta=99.0),
    lambda value: value["selectionZones"]["grid"].pop(),
    lambda value: value["selectionZones"]["boxAccounting"].update(denominator=99),
    lambda value: value["selectionZones"]["grid"][0]["parts"].pop("head"),
])
def test_v2_strict_model_rejects_terminal_or_same_event_aggregate_drift(mutation):
    value = envelope(list(provider_examples())).model_dump()
    mutation(value)
    with pytest.raises(ValueError):
        NativePitchV2Envelope.model_validate(value)
