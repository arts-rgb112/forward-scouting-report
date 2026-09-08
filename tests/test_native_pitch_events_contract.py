from copy import deepcopy
from pathlib import Path

import pytest

from api_server.box_subregion_contract import BoxContext
from api_server.native_pitch_events_contract import NativePitchEnvelope, NativePitchEvent, build_native_pitch_envelope


def context(**kwargs):
    return BoxContext(**(dict(playerId=194165, season="2025/2026", mode="league", scope=8, competition=None) | kwargs))


def raw_event(shot_id=1, **kwargs):
    return {"id": shot_id, "player": {"id": 108579}, "bodyPart": "left-foot", "shotType": "goal",
            "situation": "regular", "xg": .2, "xgot": .4,
            "playerCoordinates": {"x": 8., "y": 37.8, "z": 0.},
            "goalMouthCoordinates": {"x": 0., "y": 45.7, "z": 8.2},
            "draw": {"start": {"x": 37.8, "y": 8.}, "end": {"x": 54.3, "y": 0.}}, **kwargs}


def source(events=None, *, missing_manifest=False, missing_match=False, expected=(1,)):
    row = {"fotmob_player_id": "194165", "sportsapi_player_id": "108579", "tournament_id": "35",
           "season_id": "77333", "season_name": "2025/2026", "competition_name": "Bundesliga", "heatmap_key": "194165:35:77333"}
    manifest = {"tournamentId": 35, "seasonId": 77333, "seasonName": "2025/2026", "competition": "Bundesliga",
                "matchIds": list(expected), "finishedExactContextMatchCount": len(expected)}
    snapshots = {1: {"success": True, "matchId": 1, "endpoint": "shotmap", "data": {"shotmap": [raw_event()] if events is None else events}}}
    return row, None if missing_manifest else manifest, {} if missing_manifest or missing_match else snapshots


def envelope(events=None, **kwargs):
    return build_native_pitch_envelope(context(), [source(events)], **kwargs)


def test_same_raw_snapshot_public_shape_filter_and_metrics():
    sources = [source([raw_event(), raw_event(2, bodyPart="right-foot", situation="penalty")])]
    before = deepcopy(sources)
    full = build_native_pitch_envelope(context(), sources)
    nonpk = build_native_pitch_envelope(context(), sources, include_penalties=False)
    assert sources == before
    assert full.snapshotRevision == nonpk.snapshotRevision
    assert len(full.events) == full.bodyParts.totals.shots == 2
    assert len(nonpk.events) == nonpk.bodyParts.totals.shots == 1
    assert full.box.denominator == nonpk.box.denominator == 1
    shot = full.events[0]
    assert shot.key == "sportsapi:194165:35:77333:108579:1:1"
    assert shot.bodyPart == "leftFoot" and shot.outcome == "goal"
    assert shot.plot.x == 92 and shot.plot.y == 62.2
    assert shot.destination.x == 100 and shot.destination.y == 45.7
    assert shot.destination.observedHeightMeters is None
    assert "rawCoordinates" not in shot.model_dump()


def test_observed_zero_missing_source_missing_manifest_and_partial_coverage():
    zero = envelope([])
    assert zero.bodyParts.totals.shots == zero.box.denominator == 0
    assert zero.bodyParts.totals.quality.delta == 0
    for sources in ([], [source(missing_manifest=True)], [source(missing_match=True)]):
        result = build_native_pitch_envelope(context(), sources)
        assert result.events == [] and result.bodyParts.totals.shots is None and result.box.denominator is None
        assert len(result.bodyParts.sources) == len(sources)
    partial = build_native_pitch_envelope(context(), [source(expected=(1, 2))])
    assert partial.bodyParts.completeness == "partial" and len(partial.events) == 1
    assert partial.bodyParts.sources[0].coverage.missingMatchIds == [2]


def test_malformed_geometry_counts_unlocated_and_blocks_never_borrow_goal_target():
    blocked = raw_event(2, shotType="block")
    blocked["draw"]["block"] = {"x": 48, "y": 5}
    result = envelope([raw_event(draw=None), blocked])
    assert result.bodyParts.totals.shots == 2 and result.box.denominator == 2
    assert result.box.accounting.unlocated.shots == 1
    assert result.events[1].destination.kind == "block_projection"
    assert result.events[1].destination.x == 95 and result.events[1].destination.y == 52
    del blocked["draw"]["block"]
    assert envelope([blocked]).events[0].destination.kind == "unavailable"
    mismatch = raw_event()
    mismatch["draw"]["end"]["y"] = 1
    assert envelope([mismatch]).events[0].destination.kind == "unavailable"


@pytest.mark.parametrize("field,value", [("xg", True), ("xgot", -1), ("xg", float("nan")), ("xgot", float("inf")), ("rawCoordinates", {})])
def test_public_event_rejects_invalid_numeric_or_extra_fields(field, value):
    record = envelope().events[0].model_dump()
    record[field] = value
    with pytest.raises(ValueError):
        NativePitchEvent.model_validate(record)


@pytest.mark.parametrize("mutation", [
    lambda e: e.update(key="sportsapi:wrong"),
    lambda e: e["identity"].update(mappingKey="0194165:35:77333"),
    lambda e: e["identity"].update(shotId=True),
    lambda e: e.update(outcome="on_target"),
    lambda e: e["destination"].update(kind="block_projection"),
    lambda e: e["destination"].update(x=None),
    lambda e: e["destination"].update(y=None),
    lambda e: e["destination"].update(x=99),
    lambda e: e["destination"].update(observedHeightMeters=8.2),
    lambda e: e["destination"].update(kind="unavailable", reason="missing"),
    lambda e: e["plot"].update(x=None),
    lambda e: e["plot"].update(reason="not null"),
    lambda e: e["plot"].update(state="unlocated", x=None, y=None, reason=" "),
])
def test_identity_projection_and_destination_guards(mutation):
    record = envelope().events[0].model_dump()
    mutation(record)
    with pytest.raises(ValueError):
        NativePitchEvent.model_validate(record)


@pytest.mark.parametrize("mutation", [
    lambda d: d["events"].append(deepcopy(d["events"][0])),
    lambda d: d["events"].reverse(),
    lambda d: d["events"][0].update(bodyPart="head"),
    lambda d: d["events"][0].update(xgot=.8),
    lambda d: d["events"][0]["identity"].update(sourcePlayerId=1),
    lambda d: d["bodyParts"]["context"].update(playerId=999),
    lambda d: d["bodyParts"].update(includePenalties=False),
    lambda d: d["box"]["regions"]["L3R"].update(label="박스 중좌"),
    lambda d: d["box"]["regions"]["L3R"].update(shootingSharePct=99.),
    lambda d: d["events"][0]["plot"].update(x=40.),
    lambda d: d.update(snapshotRevision="not-a-sha"),
])
def test_full_envelope_rejects_event_body_context_and_box_drift(mutation):
    value = envelope([raw_event(), raw_event(2)]).model_dump()
    mutation(value)
    with pytest.raises(ValueError):
        NativePitchEnvelope.model_validate(value)


def test_public_excluded_pk_guard_and_missing_quality():
    result = envelope([raw_event(xgot=None), raw_event(2)])
    assert result.bodyParts.parts["leftFoot"].quality.state == "partial"
    assert result.bodyParts.parts["leftFoot"].quality.eligible == 1
    value = envelope(include_penalties=False).model_dump()
    value["events"][0]["isPenalty"] = True
    with pytest.raises(ValueError):
        NativePitchEnvelope.model_validate(value)


def test_invalid_source_json_nonfinite_rejected_before_snapshot_identity():
    broken = raw_event()
    broken["playerCoordinates"]["z"] = float("nan")
    with pytest.raises(ValueError, match="nonfinite"):
        envelope([broken])


def test_wrong_selected_context_rejected():
    with pytest.raises(ValueError):
        build_native_pitch_envelope(context(playerId=123), [source()])


def test_invalid_match_retains_coverage_not_partial_event_acceptance():
    result = envelope([raw_event(), raw_event()])
    assert result.bodyParts.sources[0].coverage.invalidMatchIds == [1]
    assert result.bodyParts.totals.shots is None and result.events == []


def test_well_formed_event_identity_outside_valid_match_coverage_rejected():
    value = envelope().model_dump()
    event = value["events"][0]
    event["identity"]["matchId"] = 999
    event["key"] = "sportsapi:194165:35:77333:108579:999:1"
    with pytest.raises(ValueError, match="outside selected source"):
        NativePitchEnvelope.model_validate(value)


def test_missing_manifest_in_multisource_selection_cannot_promote_complete():
    observed = source()
    missing = source(missing_manifest=True)
    missing[0].update(tournament_id="34", season_id="90000", competition_name="Ligue 1", heatmap_key="194165:34:90000")
    result = build_native_pitch_envelope(context(), [observed, missing])
    assert result.bodyParts.completeness == "partial"
    assert len(result.bodyParts.sources) == 2 and result.bodyParts.totals.shots == 1
    assert result.bodyParts.sources[0].coverage.state == "unavailable"


def test_actual_saved_native_fixture_both_pk_views_share_events_body_and_box():
    from api_server.pitch_source_provider import PitchSourceProvider, ResolvedPitchPlayer
    root = Path(__file__).resolve().parents[1] / "data"
    if not (root / "harvest/match-event-manifests-v1/domestic/bundesliga/77333/manifest-main-stage.json").is_file():
        pytest.skip("saved native fixture not present")
    provider = PitchSourceProvider(root, lambda ctx: ResolvedPitchPlayer(ctx.playerId, "Bundesliga"))
    sources = provider.native_sources(context())
    included = build_native_pitch_envelope(context(), sources)
    excluded = build_native_pitch_envelope(context(), sources, include_penalties=False)
    assert included.snapshotRevision == excluded.snapshotRevision
    assert (len(included.events), included.bodyParts.totals.goals) == (119, 36)
    assert (len(excluded.events), excluded.bodyParts.totals.goals) == (108, 26)
    assert included.box.denominator == excluded.box.denominator == 108
    assert included.bodyParts.parts["leftFoot"].quality.eligible == 19
    assert included.bodyParts.parts["rightFoot"].quality.delta == 1.528
    assert excluded.bodyParts.parts["rightFoot"].quality.delta == 2.204
    assert {event.key for event in excluded.events} < {event.key for event in included.events}
    assert all(event.destination.observedHeightMeters is None for event in included.events)


@pytest.mark.parametrize("mutation", [
    lambda d: d["source"].update(records=True),
    lambda d: d["source"].update(state="unavailable"),
    lambda d: d["regions"]["L4"].update(label="unexpected"),
    lambda d: d.update(extra="not reviewed"),
    lambda d: d["denominators"].update(extra=0),
    lambda d: d.update(definitionVersion="legacy-box"),
])
def test_internal_box_projection_rejects_unreviewed_metadata(monkeypatch, mutation):
    from api_server import native_pitch_box_core as box
    original = box.calculate_native_box
    def changed(events):
        result = original(events)
        mutation(result)
        return result
    monkeypatch.setattr(box, "calculate_native_box", changed)
    with pytest.raises(ValueError):
        envelope()
