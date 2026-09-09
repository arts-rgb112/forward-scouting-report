"""Strict public transport for corrected native pitch selection v2.

V1 remains intentionally untouched.  V2 is the only contract whose replay
terminal semantics may be consumed by the redesigned pitch UI.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from api_server.box_subregion_contract import Amount, BoxContext, Count, StrictModel
from api_server.native_body_part_contract import NativeBodyPartCounts, NativeBodyPartEnvelope, NativeBodyPartQuality
from api_server.native_pitch_events_contract import NativeDisplayBoxStats, NativePitchIdentity, NativePitchPlot, OUTCOMES
from api_server.native_pitch_events_contract import build_native_pitch_envelope
from api_server.native_pitch_v2_core import BOX_ORDER, build_native_pitch_v2_bundle


Part = Literal["head", "rightFoot", "leftFoot", "other", "unknown"]
ShotType = Literal["goal", "save", "miss", "post", "block"]
Outcome = Literal["goal", "on_target", "off_target", "blocked"]
Coordinate = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]


class NativePitchV2Destination(StrictModel):
    kind: Literal["goal_plane", "block", "unavailable"]
    x: Coordinate | None
    y: Coordinate | None
    observedHeightMeters: None
    reason: Annotated[str, Field(min_length=1)] | None

    @model_validator(mode="after")
    def availability(self):
        if self.kind == "unavailable":
            if self.x is not None or self.y is not None or self.reason is None:
                raise ValueError("unavailable terminal requires null point and a reason")
        elif self.x is None or self.y is None or self.reason is not None:
            raise ValueError("available terminal requires point and null reason")
        elif self.kind == "goal_plane" and self.x != 100:
            raise ValueError("goal-plane terminal must be on x=100")
        return self


class NativePitchV2Event(StrictModel):
    key: str
    identity: NativePitchIdentity
    bodyPart: Part
    shotType: ShotType
    outcome: Outcome
    isPenalty: bool
    xg: Amount | None
    xgot: Amount | None
    quality: NativeBodyPartQuality
    plot: NativePitchPlot
    destination: NativePitchV2Destination

    @model_validator(mode="after")
    def source_identity_and_terminal(self):
        identity = self.identity
        if self.key != f"sportsapi:{identity.mappingKey}:{identity.sourcePlayerId}:{identity.matchId}:{identity.shotId}":
            raise ValueError("v2 key contradicts source identity")
        if self.outcome != OUTCOMES[self.shotType]:
            raise ValueError("v2 outcome contradicts source shot type")
        allowed = {"goal": {"goal_plane", "unavailable"}, "save": {"block", "unavailable"},
                   "block": {"block", "unavailable"}, "miss": {"unavailable"}, "post": {"unavailable"}}
        if self.destination.kind not in allowed[self.shotType]:
            raise ValueError("v2 terminal kind contradicts source outcome policy")
        expected_quality = _event_quality(self.xg, self.xgot)
        if self.quality.model_dump() != expected_quality:
            raise ValueError("v2 event quality contradicts server source metrics")
        return self


class NativePitchV2Bounds(StrictModel):
    xMinInclusive: Coordinate
    xMax: Coordinate
    includeMaxX: bool
    yMinInclusive: Coordinate
    yMax: Coordinate
    includeMaxY: bool

    @model_validator(mode="after")
    def order(self):
        if self.xMinInclusive >= self.xMax or self.yMinInclusive >= self.yMax:
            raise ValueError("v2 zone bounds must have positive extent")
        return self


class NativePitchV2ZoneSource(StrictModel):
    state: Literal["complete", "partial", "unavailable"]
    records: Count | None

    @model_validator(mode="after")
    def availability(self):
        if (self.state == "unavailable") != (self.records is None):
            raise ValueError("zone source availability contradicts records")
        return self


class NativePitchV2Zone(StrictModel):
    id: str
    label: str
    bounds: NativePitchV2Bounds
    shots: Count | None
    goals: Count | None
    xg: Amount | None
    xgEligible: Count | None
    quality: NativeBodyPartQuality
    parts: dict[Part, NativeBodyPartCounts]
    shootingSharePct: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)] | None
    source: NativePitchV2ZoneSource

    @model_validator(mode="after")
    def summary(self):
        unavailable = self.source.state == "unavailable"
        if set(self.parts) != {"head", "rightFoot", "leftFoot", "other", "unknown"}:
            raise ValueError("v2 zone requires exact public body-part taxonomy")
        if unavailable:
            if any(value is not None for value in (self.shots, self.goals, self.xg, self.xgEligible, self.shootingSharePct)):
                raise ValueError("unavailable zone cannot expose values")
            return self
        if self.shots is None or self.goals is None or self.xgEligible is None or self.goals > self.shots:
            raise ValueError("observed v2 zone counts are invalid")
        if sum(part.shots for part in self.parts.values()) != self.shots or sum(part.goals for part in self.parts.values()) != self.goals:
            raise ValueError("v2 zone parts do not reconcile")
        if self.source.records != self.shots:
            raise ValueError("v2 zone source record count contradicts shots")
        if self.xgEligible > self.shots or (self.xg is None) != (self.shots > 0 and self.xgEligible == 0):
            raise ValueError("v2 zone xg availability contradicts observed records")
        return self


class NativePitchV2GridAccounting(StrictModel):
    source: Count | None
    assigned: Count | None
    unlocated: Count | None
    reconciles: bool | None


class NativePitchV2BoxAccounting(StrictModel):
    source: Count | None
    penalties: Count | None
    denominator: Count | None
    inRegions: Count | None
    outside: Count | None
    unlocated: Count | None
    reconciles: bool | None


class NativePitchV2SelectionZones(StrictModel):
    grid: list[NativePitchV2Zone]
    box: list[NativePitchV2Zone]
    gridAccounting: NativePitchV2GridAccounting
    boxAccounting: NativePitchV2BoxAccounting

    @model_validator(mode="after")
    def exact_taxonomy_and_conservation(self):
        expected_grid = [f"depth{depth}_lane{lane}" for depth in range(1, 7) for lane in range(1, 6)]
        if [zone.id for zone in self.grid] != expected_grid or [zone.id for zone in self.box] != list(BOX_ORDER):
            raise ValueError("v2 selection zones require ordered 30-grid and exact four box regions")
        for depth in range(1, 7):
            for lane in range(1, 6):
                zone = self.grid[(depth - 1) * 5 + lane - 1]
                expected = {
                    "xMinInclusive": (0.0, 16.67, 33.33, 50.0, 66.67, 83.33)[depth - 1],
                    "xMax": (16.67, 33.33, 50.0, 66.67, 83.33, 100.0)[depth - 1],
                    "includeMaxX": depth == 6,
                    "yMinInclusive": (0.0, 21.82, 37.0, 63.0, 78.18)[lane - 1],
                    "yMax": (21.82, 37.0, 63.0, 78.18, 100.0)[lane - 1],
                    "includeMaxY": lane == 5,
                }
                if zone.bounds.model_dump() != expected:
                    raise ValueError("v2 grid bounds contradict exact half-open positional taxonomy")
        for zone in self.box:
            _label, y_low, y_high = {"L4": ("박스 좌", 63.0, 78.18), "L3L": ("박스 중좌", 50.0, 63.0), "L3R": ("박스 중우", 37.0, 50.0), "L2": ("박스 우", 21.82, 37.0)}[zone.id]
            if zone.bounds.model_dump() != {"xMinInclusive": 84.29, "xMax": 100.0, "includeMaxX": True,
                                            "yMinInclusive": y_low, "yMax": y_high, "includeMaxY": False}:
                raise ValueError("v2 box bounds contradict exact half-open box taxonomy")
        g, b = self.gridAccounting, self.boxAccounting
        if g.source is None:
            if any(value is not None for value in (g.assigned, g.unlocated, g.reconciles)):
                raise ValueError("unavailable grid accounting must be null")
        elif g.reconciles is not True or g.source != g.assigned + g.unlocated or sum(zone.shots for zone in self.grid) != g.assigned:
            raise ValueError("v2 grid accounting does not conserve same-event selection")
        if b.source is None:
            if any(value is not None for value in (b.penalties, b.denominator, b.inRegions, b.outside, b.unlocated, b.reconciles)):
                raise ValueError("unavailable box accounting must be null")
        elif (b.denominator != b.source - b.penalties or b.reconciles is not True or
              b.denominator != b.inRegions + b.outside + b.unlocated or sum(zone.shots for zone in self.box) != b.inRegions):
            raise ValueError("v2 box accounting does not conserve exact native non-PK selection")
        return self


class NativePitchV2Envelope(StrictModel):
    schemaVersion: Literal["native-pitch-events-v2"]
    context: BoxContext
    provider: Literal["sportsapi"]
    snapshotRevision: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    includePenalties: bool
    coordinateDefinition: Literal["sportsapi-draw-pitch-display-v1"]
    trajectoryDefinition: Literal["source-validated-terminal-planar-schematic-v2"]
    events: list[NativePitchV2Event]
    bodyParts: NativeBodyPartEnvelope
    box: NativeDisplayBoxStats
    selectionZones: NativePitchV2SelectionZones

    @model_validator(mode="after")
    def snapshot_context_and_filter(self):
        if self.bodyParts.context != self.context or self.bodyParts.includePenalties != self.includePenalties:
            raise ValueError("v2 convenience body summary contradicts v2 context/filter")
        ordered = [(event.identity.mappingKey, event.identity.matchId, event.identity.shotId) for event in self.events]
        if ordered != sorted(ordered) or len(ordered) != len(set(ordered)):
            raise ValueError("v2 events require deterministic unique source ordering")
        if not self.includePenalties and any(event.isPenalty for event in self.events):
            raise ValueError("v2 excluded penalty view retains a penalty event")
        if self.bodyParts.totals.shots is not None and self.bodyParts.totals.shots != len(self.events):
            raise ValueError("v2 body summary does not reconcile same event list")
        if self.selectionZones.gridAccounting.source is not None and self.selectionZones.gridAccounting.source != len(self.events):
            raise ValueError("v2 grid source denominator differs from event list")
        return self


def _event_quality(xg, xgot):
    if xg is None or xgot is None:
        return {"xg": None, "xgot": None, "delta": None, "eligible": 0, "state": "unavailable"}
    xg, xgot = round(xg, 4), round(xgot, 4)
    return {"xg": xg, "xgot": xgot, "delta": round(xgot - xg, 4), "eligible": 1, "state": "complete"}


def build_native_pitch_v2_envelope(context: BoxContext, selected_sources: list, *, include_penalties: bool = True) -> NativePitchV2Envelope:
    """Build both corrected v2 records and unchanged v1 convenience summaries."""
    if not isinstance(context, BoxContext):
        raise ValueError("strict native pitch v2 context required")
    v2 = build_native_pitch_v2_bundle(selected_sources, include_penalties=include_penalties)
    # These are compatibility summaries only.  V2 events/selectionZones above
    # are the authoritative corrected trajectory and selection contract.
    compatibility = build_native_pitch_envelope(context, selected_sources, include_penalties=include_penalties)
    return NativePitchV2Envelope(
        schemaVersion="native-pitch-events-v2", context=context, provider="sportsapi",
        snapshotRevision=v2["snapshotRevision"], includePenalties=include_penalties,
        coordinateDefinition="sportsapi-draw-pitch-display-v1",
        trajectoryDefinition="source-validated-terminal-planar-schematic-v2",
        events=v2["events"], bodyParts=compatibility.bodyParts, box=compatibility.box,
        selectionZones=v2["selectionZones"],
    )
