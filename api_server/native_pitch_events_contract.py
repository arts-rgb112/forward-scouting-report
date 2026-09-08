"""Strict same-snapshot SportsAPI pitch transport; no I/O or legacy joins."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from api_server.box_subregion_contract import (
    Amount, Bounds, BoxContext, Count, META, ORDER, Pct, ShotSummary, StrictModel,
)
from api_server.native_body_part_contract import (
    PARTS, NativeBodyPartEnvelope, _public_part, _quality,
    build_native_body_part_envelope,
)
from api_server.native_pitch_events_core import build_native_event_bundle

Part = Literal["head", "leftFoot", "rightFoot", "other", "unknown"]
RegionId = Literal["L4", "L3L", "L3R", "L2"]
Coordinate = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
PositiveId = Annotated[int, Field(gt=0)]
Reason = Annotated[str, Field(min_length=1, pattern=r"\S")]
OUTCOMES = {"goal": "goal", "save": "on_target", "miss": "off_target", "post": "off_target", "block": "blocked"}


class NativePitchIdentity(StrictModel):
    mappingKey: Annotated[str, Field(pattern=r"^[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$")]
    sourcePlayerId: PositiveId
    matchId: PositiveId
    shotId: PositiveId


class NativePitchPlot(StrictModel):
    state: Literal["projected", "unlocated"]
    x: Coordinate | None
    y: Coordinate | None
    reason: Reason | None

    @model_validator(mode="after")
    def availability(self):
        available = self.state == "projected"
        if available and (self.x is None or self.y is None or self.reason is not None):
            raise ValueError("projected coordinates require both values and null reason")
        if not available and (self.x is not None or self.y is not None or self.reason is None):
            raise ValueError("unlocated coordinates require null values and a reason")
        return self


class NativePitchDestination(StrictModel):
    kind: Literal["goal_plane_projection", "block_projection", "unavailable"]
    x: Coordinate | None
    y: Coordinate | None
    observedHeightMeters: None
    reason: Reason | None

    @model_validator(mode="after")
    def availability(self):
        if self.kind == "unavailable":
            if self.x is not None or self.y is not None or self.reason is None:
                raise ValueError("unavailable destination requires null coordinates and reason")
        elif self.x is None or self.y is None or self.reason is not None:
            raise ValueError("available destination requires both coordinates and null reason")
        elif self.kind == "goal_plane_projection" and self.x != 100:
            raise ValueError("goal projection must be on display goal plane")
        return self


class NativePitchEvent(StrictModel):
    key: str
    identity: NativePitchIdentity
    bodyPart: Part
    shotType: Literal["goal", "save", "miss", "post", "block"]
    outcome: Literal["goal", "on_target", "off_target", "blocked"]
    isPenalty: bool
    xg: Amount | None
    xgot: Amount | None
    plot: NativePitchPlot
    destination: NativePitchDestination

    @model_validator(mode="after")
    def identity_and_classification(self):
        i = self.identity
        if self.key != f"sportsapi:{i.mappingKey}:{i.sourcePlayerId}:{i.matchId}:{i.shotId}":
            raise ValueError("event key contradicts exact source identity")
        if self.outcome != OUTCOMES[self.shotType]:
            raise ValueError("outcome contradicts native shot type")
        expected = "block_projection" if self.shotType == "block" else "goal_plane_projection"
        if self.destination.kind not in (expected, "unavailable"):
            raise ValueError("destination kind contradicts native shot type")
        return self


class NativeDisplayBoxRegion(ShotSummary):
    id: RegionId
    label: str
    bounds: Bounds
    shootingSharePct: Pct | None

    @model_validator(mode="after")
    def taxonomy(self):
        label, low, high = META[self.id]
        if (self.label, self.bounds.yMinInclusive, self.bounds.yMaxExclusive) != (label, low, high):
            raise ValueError("native box label/bounds contradict taxonomy")
        return self


class NativeDisplayBoxAccounting(StrictModel):
    source: ShotSummary
    penalties: ShotSummary
    inRegions: ShotSummary
    outside: ShotSummary
    unlocated: ShotSummary
    reconciles: bool | None


def _summary_partition(parent: ShotSummary, children: list[ShotSummary]) -> None:
    for field in ("shots", "goals", "xgEligible"):
        if getattr(parent, field) != sum(getattr(child, field) for child in children):
            raise ValueError("native box partition counts do not reconcile")
    if parent.quality.eligible != sum(child.quality.eligible for child in children):
        raise ValueError("native box paired eligibility does not reconcile")
    for metric, quality in (("xg", False), ("xg", True), ("xgot", True)):
        values = [getattr(child.quality if quality else child, metric) for child in children]
        value = getattr(parent.quality if quality else parent, metric)
        present = [item for item in values if item is not None]
        if value is None:
            if any(item != 0 for item in present):
                raise ValueError("native box parent metric unavailable despite observed child")
        elif abs(value - sum(present)) > (len(children) + 1) * 0.00005 + 1e-9:
            raise ValueError("native box metric partitions exceed rounding tolerance")


class NativeDisplayBoxStats(StrictModel):
    definitionVersion: Literal["native-display-box-subregion-v1"]
    coordinateDefinition: Literal["sportsapi-draw-pitch-display-v1"]
    regionOrder: list[RegionId]
    denominator: Count | None
    regions: dict[RegionId, NativeDisplayBoxRegion]
    accounting: NativeDisplayBoxAccounting

    @model_validator(mode="after")
    def reconciliation(self):
        if tuple(self.regionOrder) != ORDER or set(self.regions) != set(ORDER):
            raise ValueError("native box requires exact ordered four regions")
        if any(region.id != key for key, region in self.regions.items()):
            raise ValueError("native box region dictionary key differs from id")
        a = self.accounting
        unavailable = a.source.shots is None
        summaries = [a.penalties, a.inRegions, a.outside, a.unlocated, *self.regions.values()]
        if any((summary.shots is None) != unavailable for summary in summaries):
            raise ValueError("native box source availability contradicts partitions")
        if unavailable:
            if self.denominator is not None or a.reconciles is not None:
                raise ValueError("unavailable native box requires null denominator/reconciliation")
        else:
            if a.reconciles is not True or self.denominator != a.source.shots - a.penalties.shots:
                raise ValueError("native non-PK denominator does not reconcile")
            _summary_partition(a.source, [a.penalties, a.inRegions, a.outside, a.unlocated])
            _summary_partition(a.inRegions, list(self.regions.values()))
        for region in self.regions.values():
            expected = None if self.denominator in (None, 0) else round(region.shots / self.denominator * 100, 4)
            if region.shootingSharePct != expected:
                raise ValueError("native box share must use all observed non-PK events")
        return self


def _check_body_records(counts, records, *, observed: bool) -> None:
    if not observed:
        if records or counts.shots is not None:
            raise ValueError("unavailable native body cannot expose events")
        return
    if counts.shots != len(records) or counts.goals != sum(record["shotType"] == "goal" for record in records):
        raise ValueError("native body counts contradict same-event list")
    if counts.quality.model_dump() != _quality(records, observed=True):
        raise ValueError("native body quality contradicts same-event raw metrics")


def _native_box_payload(records):
    """Project the reviewed internal box result into the fixed public shape.

    Internal source metadata and denominator container are validated before
    removal. Only the four known internal label tokens receive Korean labels.
    No metric or coordinate value is synthesized by this presentation adapter.
    """
    from api_server.native_pitch_box_core import calculate_native_box
    result = calculate_native_box(records)
    expected_keys = {"definitionVersion", "coordinateDefinition", "regionOrder", "source", "denominators", "regions", "accounting"}
    if set(result) != expected_keys or set(result["denominators"]) != {"selectedNonPenaltyShots"}:
        raise ValueError("internal native box shape differs from reviewed core")
    expected_source = {"state": "unavailable" if records is None else "observed",
                       "records": None if records is None else len(records)}
    source_count = result["source"].get("records")
    if (result["source"] != expected_source or
            (source_count is not None and (isinstance(source_count, bool) or not isinstance(source_count, int)))):
        raise ValueError("internal native box source metadata contradicts input")
    labels = {"L4": "box_left", "L3L": "box_centre_left", "L3R": "box_centre_right", "L2": "box_right"}
    if set(result["regions"]) != set(ORDER):
        raise ValueError("internal native box region keys differ from taxonomy")
    regions = {}
    for key in ORDER:
        region = result["regions"][key]
        if region["label"] != labels[key]:
            raise ValueError("internal native box label differs from taxonomy")
        regions[key] = {**region, "label": META[key][0]}
    return {"definitionVersion": result["definitionVersion"], "coordinateDefinition": result["coordinateDefinition"],
            "regionOrder": result["regionOrder"], "denominator": result["denominators"]["selectedNonPenaltyShots"],
            "regions": regions, "accounting": result["accounting"]}


class NativePitchEnvelope(StrictModel):
    schemaVersion: Literal["native-pitch-events-v1"]
    context: BoxContext
    provider: Literal["sportsapi"]
    snapshotRevision: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    includePenalties: bool
    coordinateDefinition: Literal["sportsapi-draw-pitch-display-v1"]
    trajectoryDefinition: Literal["source-planar-schematic-height-v1"]
    events: list[NativePitchEvent]
    bodyParts: NativeBodyPartEnvelope
    box: NativeDisplayBoxStats

    @model_validator(mode="after")
    def same_snapshot_reconciliation(self):
        body = self.bodyParts
        if body.context != self.context or body.includePenalties != self.includePenalties or body.provider != self.provider:
            raise ValueError("native body context/provider/filter differs from pitch")
        order = [(e.identity.mappingKey, e.identity.matchId, e.identity.shotId) for e in self.events]
        identities = [(e.identity.sourcePlayerId, e.identity.matchId, e.identity.shotId) for e in self.events]
        if order != sorted(order) or len(order) != len(set(order)) or len(identities) != len(set(identities)):
            raise ValueError("native event identity/order must be unique and deterministic")
        sources = {source.mappingKey: source for source in body.sources}
        if list(sources) != sorted(sources):
            raise ValueError("native sources must be deterministically ordered")
        for event in self.events:
            source = sources.get(event.identity.mappingKey)
            if (source is None or source.sourcePlayerId != event.identity.sourcePlayerId
                    or event.identity.matchId not in source.coverage.validMatchIds):
                raise ValueError("event identity outside selected source/valid matches")
            if not self.includePenalties and event.isPenalty:
                raise ValueError("native excluded-PK view retains a penalty")
        records = [event.model_dump() for event in self.events]
        observed = body.completeness != "unavailable"
        _check_body_records(body.totals, records, observed=observed)
        for part in PARTS:
            _check_body_records(body.parts[part], [e for e in records if e["bodyPart"] == part], observed=observed)
        for source in body.sources:
            selected = [e for e in records if e["identity"]["mappingKey"] == source.mappingKey]
            available = source.coverage.state != "unavailable"
            _check_body_records(source.totals, selected, observed=available)
            for part in PARTS:
                _check_body_records(source.parts[part], [e for e in selected if e["bodyPart"] == part], observed=available)
        expected_box = _native_box_payload(records if observed else None)
        if self.box.model_dump() != expected_box:
            raise ValueError("native box values/partitions drift from the same event list")
        return self


def build_native_pitch_envelope(context: BoxContext, selected_sources: list, *, include_penalties: bool = True) -> NativePitchEnvelope:
    """Consume one in-memory source selection; never re-read provider/raw files."""
    if not isinstance(context, BoxContext):
        raise ValueError("strict native pitch context required")
    bundle = build_native_event_bundle(selected_sources, include_penalties=include_penalties)
    source_results = []
    for selected in bundle["sources"]:
        source = selected["source"]
        if selected["coverage"]["state"] == "unavailable":
            # Preserve missing/invalid match coverage when a manifest exists.
            if not selected["coverage"]["expectedMatchIds"]:
                source_results.append({"source": source, "aggregate": None})
                continue
        records = [{"matchId": e["identity"]["matchId"], "eventId": e["identity"]["shotId"],
                    "playerId": e["identity"]["sourcePlayerId"], "bodyPart": e["bodyPart"],
                    "shotType": e["shotType"], "isPenalty": e["isPenalty"], "xg": e["xg"], "xgot": e["xgot"]}
                   for e in bundle["events"] if e["identity"]["mappingKey"] == source["mappingKey"]]
        counts = selected["counts"]
        source_results.append({"source": source, "aggregate": {
            "sourcePlayerId": source["sourcePlayerId"], "includePenalties": include_penalties,
            "coverage": selected["coverage"], "admittedShotCount": counts["admittedShots"],
            "excludedPenaltyShots": counts["excludedPenaltyShots"], "excludedPenaltyGoals": counts["excludedPenaltyGoals"],
            "filteredShotCount": counts["shots"], "filteredGoalCount": counts["goals"],
            "categories": selected["parts"], "qualityRecords": records,
        }})
    body = build_native_body_part_envelope(context, source_results, include_penalties=include_penalties)
    events = []
    for raw in bundle["events"]:
        i = raw["identity"]
        projection = raw["blockProjection"] if raw["shotType"] == "block" else raw["goalPlaneProjection"]
        kind = "unavailable" if projection["state"] == "unavailable" else "block_projection" if raw["shotType"] == "block" else "goal_plane_projection"
        events.append({"key": f"sportsapi:{i['mappingKey']}:{i['sourcePlayerId']}:{i['matchId']}:{i['shotId']}",
                       "identity": i, "bodyPart": _public_part(raw["bodyPart"]), "shotType": raw["shotType"],
                       "outcome": OUTCOMES[raw["shotType"]], "isPenalty": raw["isPenalty"], "xg": raw["xg"], "xgot": raw["xgot"],
                       "plot": {key: raw["plot"][key] for key in ("state", "x", "y", "reason")},
                       "destination": {"kind": kind, "x": projection["x"], "y": projection["y"],
                                       "observedHeightMeters": None, "reason": projection["reason"]}})
    return NativePitchEnvelope(schemaVersion="native-pitch-events-v1", context=context, provider="sportsapi",
        snapshotRevision=bundle["snapshotRevision"], includePenalties=include_penalties,
        coordinateDefinition="sportsapi-draw-pitch-display-v1", trajectoryDefinition="source-planar-schematic-height-v1",
        events=events, bodyParts=body, box=_native_box_payload(events if body.completeness != "unavailable" else None))
