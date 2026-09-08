from copy import deepcopy

import pytest
from pydantic import ValidationError

from api_server.box_subregion_contract import BoxContext
from api_server.native_body_part_contract import NativeBodyPartEnvelope, NativeBodyPartTotals, build_native_body_part_envelope


PARTS = ("head", "leftFoot", "rightFoot", "other", "unknown")


def context(**changes):
    return BoxContext(**{"playerId": 10, "season": "2025/2026", "mode": "league", "scope": 8, "competition": None, **changes})


def source(tournament=35, competition="Bundesliga"):
    return {"provider": "sportsapi", "fotmobPlayerId": 10, "sourcePlayerId": 110, "tournamentId": tournament,
            "seasonId": 77333, "season": "2025/2026", "competition": competition, "mappingKey": f"10:{tournament}:77333"}


def aggregate(include=True, state="complete", parts=None):
    parts = parts or {"head": {"shots": 1, "goals": 1}, "leftFoot": {"shots": 2, "goals": 1},
                      "rightFoot": {"shots": 3, "goals": 2}, "other": {"shots": 0, "goals": 0}, "unknown": {"shots": 0, "goals": 0}}
    shots, goals = sum(value["shots"] for value in parts.values()), sum(value["goals"] for value in parts.values())
    excluded = 0 if include else 1
    excluded_goals = 0 if include else 1
    coverage = {"state": state, "expectedMatchIds": [1], "validMatchIds": [1] if state != "unavailable" else [],
                "missingMatchIds": [], "invalidMatchIds": [], "invalidReasons": {}}
    if state == "unavailable":
        coverage["expectedMatchIds"] = []
        parts = {part: {"shots": None, "goals": None, "quality": {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}} for part in PARTS}
        return {"sourcePlayerId": 110, "includePenalties": include, "coverage": coverage, "admittedShotCount": None,
                "excludedPenaltyShots": None, "excludedPenaltyGoals": None, "filteredShotCount": None, "filteredGoalCount": None, "categories": parts, "qualityRecords": []}
    raw_parts = {"head": "head", "leftFoot": "left-foot", "rightFoot": "right-foot", "other": "other", "unknown": "unknown"}
    records, event_id = [], 1
    categories = {}
    for part in PARTS:
        category_records = []
        for index in range(parts[part]["shots"]):
            record = {"matchId": 1, "eventId": event_id, "playerId": 110, "bodyPart": raw_parts[part],
                      "shotType": "goal" if index < parts[part]["goals"] else "miss", "isPenalty": False, "xg": 0.1, "xgot": 0.2}
            records.append(record); category_records.append(record); event_id += 1
        categories[part] = {"shots": parts[part]["shots"], "goals": parts[part]["goals"],
                            "quality": {"xg": round(0.1 * len(category_records), 4), "xgot": round(0.2 * len(category_records), 4), "delta": round(0.1 * len(category_records), 4), "eligible": len(category_records), "state": "complete"}}
    return {"sourcePlayerId": 110, "includePenalties": include, "coverage": coverage, "admittedShotCount": shots + excluded,
            "excludedPenaltyShots": excluded, "excludedPenaltyGoals": excluded_goals, "filteredShotCount": shots, "filteredGoalCount": goals, "categories": categories, "qualityRecords": records}


def test_complete_unknown_and_pk_filter_reconcile_without_mutation():
    item = {"source": source(), "aggregate": aggregate(False, parts={"head": {"shots": 1, "goals": 0}, "leftFoot": {"shots": 0, "goals": 0}, "rightFoot": {"shots": 1, "goals": 1}, "other": {"shots": 0, "goals": 0}, "unknown": {"shots": 2, "goals": 1}})}
    original = deepcopy(item)
    envelope = build_native_body_part_envelope(context(), [item], include_penalties=False)
    assert item == original
    assert envelope.completeness == "complete"
    assert {key: value for key, value in envelope.totals.model_dump().items() if key != "quality"} == {"admittedShots": 5, "excludedPenaltyShots": 1, "excludedPenaltyGoals": 1, "shots": 4, "goals": 2}
    assert envelope.parts["unknown"].shots == 2 and envelope.parts["unknown"].goals == 1


def test_known_no_mapping_and_missing_manifest_are_unavailable_without_fake_ids():
    empty = build_native_body_part_envelope(context(), [])
    assert empty.completeness == "unavailable" and empty.sources == []
    missing = build_native_body_part_envelope(context(), [{"source": source(), "aggregate": None}])
    assert missing.sources[0].coverage.expectedMatchIds == []
    assert missing.totals.shots is None and missing.parts["head"].shots is None
    assert missing.totals.quality.eligible is None and missing.parts["head"].quality.state == "unavailable"


def test_present_but_all_invalid_source_keeps_coverage_reason_and_unavailable_metrics():
    result = build_native_body_part_envelope(context(), [{"source": source(), "aggregate": aggregate(state="unavailable")}])
    assert result.completeness == "unavailable"
    assert result.sources[0].coverage.state == "unavailable"
    assert result.sources[0].totals.quality.eligible is None


def test_partial_and_multi_european_sources_reconcile_observed_subsets():
    partial = aggregate(True, state="partial")
    partial["coverage"] = {"state": "partial", "expectedMatchIds": [1, 2], "validMatchIds": [1], "missingMatchIds": [2], "invalidMatchIds": [], "invalidReasons": {}}
    result = build_native_body_part_envelope(context(), [{"source": source(), "aggregate": partial}])
    assert result.completeness == "partial" and result.totals.shots == 6
    european = context(mode="europe", scope=None, competition="all")
    items = [{"source": source(7, "UEFA Champions League"), "aggregate": aggregate()},
             {"source": source(679, "UEFA Europa League"), "aggregate": aggregate()}]
    assert build_native_body_part_envelope(european, items).totals.shots == 12


@pytest.mark.parametrize("mutate", [
    lambda item: item["source"].update({"fotmobPlayerId": 11}),
    lambda item: item["source"].update({"competition": "UEFA Champions League"}),
    lambda item: item["source"].update({"competition": "Unknown Domestic"}),
    lambda item: item["source"].update({"tournamentId": 7, "mappingKey": "10:7:77333"}),
    lambda item: item["aggregate"].update({"includePenalties": False}),
    lambda item: item["aggregate"]["categories"]["head"].update({"goals": 9}),
    lambda item: item.update({"extra": 1}),
])
def test_context_filter_extras_and_reconciliation_fail_closed(mutate):
    item = {"source": source(), "aggregate": aggregate()}
    mutate(item)
    with pytest.raises((ValueError, ValidationError)):
        build_native_body_part_envelope(context(), [item])


def test_dto_forbids_extras_and_included_penalties_cannot_be_excluded():
    with pytest.raises(ValidationError):
        NativeBodyPartEnvelope.model_validate({"extra": 1})
    item = {"source": source(), "aggregate": aggregate()}
    item["aggregate"]["excludedPenaltyShots"] = 1
    item["aggregate"]["admittedShotCount"] = 7
    with pytest.raises((ValueError, ValidationError)):
        build_native_body_part_envelope(context(), [item])


@pytest.mark.parametrize("change", [
    lambda payload: payload["sources"][0].update({"fotmobPlayerId": 11}),
    lambda payload: payload["sources"][0].update({"season": "2024/2025"}),
    lambda payload: payload["sources"][0].update({"competition": "UEFA Champions League"}),
    lambda payload: payload["sources"][0].update({"competition": "Unknown Domestic"}),
    lambda payload: payload["sources"][0].update({"tournamentId": 7, "mappingKey": "10:7:77333"}),
    lambda payload: payload["context"].update({"mode": "europe", "scope": None, "competition": "ucl"}),
])
def test_direct_dto_revalidation_cannot_bypass_source_context(change):
    payload = build_native_body_part_envelope(context(), [{"source": source(), "aggregate": aggregate()}]).model_dump()
    change(payload)
    with pytest.raises(ValidationError):
        NativeBodyPartEnvelope.model_validate(payload)


def test_reordered_part_dicts_are_valid_and_builder_emits_canonical_order():
    categories = aggregate()["categories"]
    reordered = {part: categories[part] for part in reversed(PARTS)}
    result = build_native_body_part_envelope(context(), [{"source": source(), "aggregate": aggregate(parts=reordered)}])
    assert tuple(result.parts) == PARTS
    assert tuple(result.sources[0].parts) == PARTS


def test_quality_partial_metric_coverage_is_independent_of_source_coverage():
    item = {"source": source(), "aggregate": aggregate()}
    item["aggregate"]["qualityRecords"][0]["xgot"] = None
    item["aggregate"]["categories"]["head"]["quality"] = {"xg": None, "xgot": None, "delta": None, "eligible": 0, "state": "unavailable"}
    result = build_native_body_part_envelope(context(), [item])
    assert result.completeness == "complete"
    assert result.parts["head"].quality.state == "unavailable"
    assert result.parts["head"].quality.eligible == 0
    assert result.totals.quality.state == "partial"


def test_quality_records_cannot_escape_valid_match_coverage():
    item = {"source": source(), "aggregate": aggregate()}
    item["aggregate"]["qualityRecords"][0]["matchId"] = 99
    with pytest.raises((ValueError, ValidationError), match="coverage"):
        build_native_body_part_envelope(context(), [item])


def test_direct_dto_cannot_tamper_source_quality_after_builder_aggregation():
    payload = build_native_body_part_envelope(context(), [{"source": source(), "aggregate": aggregate()}]).model_dump()
    for location in (payload["sources"][0]["parts"]["head"]["quality"], payload["sources"][0]["totals"]["quality"]):
        location["xg"] += 1
        location["delta"] -= 1
    with pytest.raises(ValidationError, match="quality"):
        NativeBodyPartEnvelope.model_validate(payload)


def test_unavailable_source_totals_require_null_eligible_not_zero():
    with pytest.raises(ValidationError, match="unavailable totals"):
        NativeBodyPartTotals.model_validate({"admittedShots": None, "excludedPenaltyShots": None,
                                             "excludedPenaltyGoals": None, "shots": None, "goals": None,
                                             "quality": {"xg": None, "xgot": None, "delta": None,
                                                         "eligible": 0, "state": "unavailable"}})
