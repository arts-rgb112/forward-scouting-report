from copy import deepcopy

import pytest
from pydantic import ValidationError

from api_server.box_subregion_contract import BoxContext, BoxSubregionEnvelope, build_box_subregion_envelope
from api_server.box_subregion_sources import aggregate_selected_box_sources


def result(shots=None, activity=None, *, partial=False):
    contexts = [{"fotmobPlayerId": 10, "sportsapiPlayerId": 110, "tournamentId": 35,
                 "seasonId": 77333, "season": "2025/2026"}]
    if partial:
        contexts.append({**contexts[0], "tournamentId": 7, "seasonId": 76953})
    return aggregate_selected_box_sources(
        contexts, {} if shots is None else {"10:35:77333": shots},
        {} if activity is None else {"110:35:77333": {"success": True, "data": {"points": activity}}},
    )


def context():
    return BoxContext(playerId=10, season="2025/2026", mode="league", scope=8, competition=None)


def shot(y=55, **fields):
    return {"x": 90, "y": y, "outcome": "goal", "xg": 0.1, "xgot": 0.3, **fields}


def test_public_percentages_use_unrounded_counts_and_actual_box_names():
    source = result([shot(), shot(y=5), shot(y=5)], [{"x": 90, "y": 55, "count": 1}, {"x": 5, "y": 5, "count": 2}])
    original = deepcopy(source)
    envelope = build_box_subregion_envelope(context(), source)
    assert source == original
    assert [region.label for region in envelope.regions] == ["박스 좌", "박스 중좌", "박스 중우", "박스 우"]
    assert envelope.regions[1].shootingSharePct == 33.3333
    assert envelope.regions[1].activitySharePct == 33.3333
    assert envelope.regions[1].quality.delta == 0.2
    assert "shootingShare" not in envelope.model_dump()["regions"][1]
    assert BoxSubregionEnvelope.model_validate_json(envelope.model_dump_json()) == envelope


@pytest.mark.parametrize("shots,activity,partial,state", [
    ([], [], False, "observed"), (None, None, False, "unavailable"),
    ([], None, False, "partial"), (None, [], False, "partial"),
    ([], [], True, "partial"),
])
def test_source_state_and_empty_are_not_conflated(shots, activity, partial, state):
    envelope = build_box_subregion_envelope(context(), result(shots, activity, partial=partial))
    assert envelope.completeness == state
    for region in envelope.regions:
        assert region.shots == (None if shots is None else 0)
        assert region.activity == (None if activity is None else 0)
        assert region.quality.delta == (None if shots is None else 0)
        assert region.shootingSharePct is None and region.activitySharePct is None
        assert region.quality.state == ("unavailable" if shots is None else "partial" if partial else "complete")


def test_missing_joint_quality_is_not_zero_and_partial_source_not_complete():
    missing = build_box_subregion_envelope(context(), result([shot(xgot=None)], []))
    assert missing.regions[1].quality.state == "unavailable"
    assert missing.regions[1].quality.delta is None
    partial = build_box_subregion_envelope(context(), result([shot()], [], partial=True))
    assert partial.regions[1].quality.state == "partial"
    assert partial.regions[1].quality.delta == 0.2


@pytest.mark.parametrize("path,value", [
    (("completeness",), "partial"),
    (("context", "playerId"), 11),
    (("context", "extra"), True),
    (("coverage", "shots", "state"), "partial"),
    (("coverage", "shots", "missingKeys"), ["10:35:77333"]),
    (("regions", 1, "label"), "구역28"),
    (("regions", 1, "bounds", "yMinInclusive"), 49.0),
    (("regions", 1, "quality", "delta"), 9.0),
    (("regions", 1, "quality", "xg"), -1.0),
    (("regions", 1, "quality", "extra"), 1),
    (("regions", 1, "shootingSharePct"), 1.0),
    (("regions", 1, "activity"), 8),
    (("accounting", "source", "shots"), 8),
    (("accounting", "reconciles"), False),
    (("activityAccounting", "reconciles"), False),
    (("denominators", "selectedNonPenaltyShots"), 8),
])
def test_strict_payload_rejects_tampered_states_counts_taxonomy_and_unknowns(path, value):
    payload = build_box_subregion_envelope(context(), result([shot()], [])).model_dump()
    node = payload
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    with pytest.raises(ValidationError):
        BoxSubregionEnvelope.model_validate(payload)


def test_context_dimensions_and_source_coverage_cannot_cross_players():
    for changes in ({"scope": None}, {"competition": "all"}, {"mode": "europe"}, {"playerId": True}):
        with pytest.raises(ValidationError):
            BoxContext.model_validate({**context().model_dump(), **changes})
    assert BoxContext(playerId=10, season="2025/2026", mode="europe", scope=None, competition="ucl")


def test_schema_keeps_every_object_closed():
    schema = BoxSubregionEnvelope.model_json_schema()
    assert schema["additionalProperties"] is False
    assert all(value.get("additionalProperties") is False for value in schema["$defs"].values() if value.get("type") == "object")


def test_nonconsecutive_season_and_unavailable_eligible_pairs_are_rejected():
    with pytest.raises(ValidationError):
        BoxContext.model_validate({**context().model_dump(), "season": "2025/2028"})
    payload = build_box_subregion_envelope(context(), result([shot(xgot=None)], [])).model_dump()
    payload["regions"][1]["quality"]["eligible"] = 1
    with pytest.raises(ValidationError):
        BoxSubregionEnvelope.model_validate(payload)


@pytest.mark.parametrize("key", ["10", "10:any:any", "10:0:77333", "10:35:-1", "010:35:77333"])
@pytest.mark.parametrize("source", ["shots", "activity"])
def test_malformed_native_coverage_keys_rejected(key, source):
    payload = build_box_subregion_envelope(context(), result([], [])).model_dump()
    payload["coverage"][source]["expectedKeys"] = [key]
    payload["coverage"][source]["observedKeys"] = [key]
    with pytest.raises(ValidationError):
        BoxSubregionEnvelope.model_validate(payload)


@pytest.mark.parametrize("shots,quality", [
    ([shot()], {"state": "partial", "eligible": 1, "xg": 0.1, "xgot": 0.3, "delta": 0.2}),
    ([shot(xgot=None)], {"state": "partial", "eligible": 0, "xg": 0.0, "xgot": 0.0, "delta": 0.0}),
    ([], {"state": "complete", "eligible": 0, "xg": 1.0, "xgot": 1.0, "delta": 0.0}),
])
def test_quality_state_matches_sample_and_coverage(shots, quality):
    payload = build_box_subregion_envelope(context(), result(shots, [])).model_dump()
    payload["regions"][1]["quality"] = quality
    with pytest.raises(ValidationError):
        BoxSubregionEnvelope.model_validate(payload)
