"""Strict additive box readout. No application mount, I/O, or cache side effects."""
from __future__ import annotations

from copy import deepcopy
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Count = Annotated[int, Field(ge=0)]
Amount = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Number = Annotated[float, Field(allow_inf_nan=False)]
Pct = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
ORDER = ("L4", "L3L", "L3R", "L2")
META = {
    "L4": ("박스 좌", 63.0, 78.18),
    "L3L": ("박스 중좌", 50.0, 63.0),
    "L3R": ("박스 중우", 37.0, 50.0),
    "L2": ("박스 우", 21.82, 37.0),
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class BoxContext(StrictModel):
    playerId: Annotated[int, Field(gt=0)]
    season: Annotated[str, Field(pattern=r"^20\d{2}/20\d{2}$")]
    mode: Literal["league", "europe"]
    scope: Literal[3, 5, 7, 8] | None
    competition: Literal["all", "ucl", "uel", "uecl"] | None

    @model_validator(mode="after")
    def dimensions(self):
        start, end = map(int, self.season.split("/"))
        if end != start + 1:
            raise ValueError("season must contain consecutive years")
        if self.mode == "league" and (self.scope is None or self.competition is not None):
            raise ValueError("league requires scope and null competition")
        if self.mode == "europe" and (self.scope is not None or self.competition is None):
            raise ValueError("europe requires competition and null scope")
        return self


class SourceCoverage(StrictModel):
    state: Literal["observed", "partial", "unavailable"]
    expectedKeys: list[str]
    observedKeys: list[str]
    missingKeys: list[str]

    @model_validator(mode="after")
    def reconcile(self):
        for values in (self.expectedKeys, self.observedKeys, self.missingKeys):
            if values != sorted(set(values)) or any(not key for key in values):
                raise ValueError("coverage keys must be sorted, unique, and nonblank")
            if any(not re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*", key) for key in values):
                raise ValueError("coverage keys require three positive native IDs")
        expected, observed, missing = map(set, (self.expectedKeys, self.observedKeys, self.missingKeys))
        if observed & missing or observed | missing != expected:
            raise ValueError("coverage keys do not partition expected selection")
        state = "unavailable" if not expected else "observed" if not missing else "partial" if observed else "unavailable"
        if self.state != state:
            raise ValueError("coverage state contradicts keys")
        return self


class Coverage(StrictModel):
    shots: SourceCoverage
    activity: SourceCoverage


class Quality(StrictModel):
    xg: Amount | None
    xgot: Amount | None
    delta: Number | None
    eligible: Count | None
    state: Literal["complete", "partial", "unavailable"]

    @model_validator(mode="after")
    def values(self):
        if self.state == "unavailable":
            if any(value is not None for value in (self.xg, self.xgot, self.delta)):
                raise ValueError("unavailable quality has no numeric amounts")
            if self.eligible not in (None, 0):
                raise ValueError("unavailable quality cannot have eligible pairs")
        elif any(value is None for value in (self.xg, self.xgot, self.delta, self.eligible)):
            raise ValueError("observed quality requires values")
        elif self.delta != round(self.xgot - self.xg, 4):
            raise ValueError("quality must be rounded xGOT minus xG")
        return self


class ShotSummary(StrictModel):
    shots: Count | None
    goals: Count | None
    xg: Amount | None
    xgEligible: Count | None
    quality: Quality

    @model_validator(mode="after")
    def counts(self):
        if self.shots is None:
            if any(value is not None for value in (self.goals, self.xg, self.xgEligible, self.quality.eligible)):
                raise ValueError("unavailable shots require null values")
            if self.quality.state != "unavailable":
                raise ValueError("unavailable shots require unavailable quality")
        else:
            if self.goals is None or self.xgEligible is None or self.quality.eligible is None:
                raise ValueError("observed shots require count fields")
            if not 0 <= self.goals <= self.shots or not 0 <= self.quality.eligible <= self.xgEligible <= self.shots:
                raise ValueError("shot counts do not reconcile")
            if (self.xg is None) != (self.shots > 0 and self.xgEligible == 0):
                raise ValueError("xG availability contradicts eligible count")
            if self.quality.state == "complete" and self.quality.eligible != self.shots:
                raise ValueError("complete quality requires all observed shots")
            if self.shots > 0 and self.quality.eligible == 0 and self.quality.state != "unavailable":
                raise ValueError("nonempty sample without joint pairs has unavailable quality")
            if self.shots == 0 and any(value != 0 for value in (self.xg, self.quality.xg, self.quality.xgot, self.quality.delta)):
                raise ValueError("observed empty shots require zero quality")
        return self


class Bounds(StrictModel):
    xMinInclusive: Literal[84.29]
    yMinInclusive: Amount
    yMaxExclusive: Amount


class Region(ShotSummary):
    id: Literal["L4", "L3L", "L3R", "L2"]
    label: str
    bounds: Bounds
    activity: Count | None
    shootingSharePct: Pct | None
    activitySharePct: Pct | None

    @model_validator(mode="after")
    def taxonomy(self):
        name, low, high = META[self.id]
        if (self.label, self.bounds.yMinInclusive, self.bounds.yMaxExclusive) != (name, low, high):
            raise ValueError("region differs from box-subregion-v1 taxonomy")
        return self


class Denominators(StrictModel):
    selectedNonPenaltyShots: Count | None
    fullActivityCount: Count | None


class ShotAccounting(StrictModel):
    source: ShotSummary
    inRegions: ShotSummary
    penalties: ShotSummary
    outside: ShotSummary
    reconciles: bool | None


class ActivityAccounting(StrictModel):
    source: Count | None
    inRegions: Count | None
    outside: Count | None
    reconciles: bool | None


def _pct(numerator, denominator):
    return None if numerator is None or denominator in (None, 0) else round(numerator / denominator * 100, 4)


class BoxSubregionEnvelope(StrictModel):
    schemaVersion: Literal["box-subregion-stats-v1"]
    definitionVersion: Literal["box-subregion-v1"]
    shotProvider: Literal["fotmob"]
    activityProvider: Literal["sportsapi"]
    context: BoxContext
    completeness: Literal["observed", "partial", "unavailable"]
    coverage: Coverage
    denominators: Denominators
    regions: list[Region]
    accounting: ShotAccounting
    activityAccounting: ActivityAccounting

    @model_validator(mode="after")
    def consistency(self):
        states = (self.coverage.shots.state, self.coverage.activity.state)
        expected = "observed" if states == ("observed", "observed") else "unavailable" if states == ("unavailable", "unavailable") else "partial"
        if self.completeness != expected or tuple(region.id for region in self.regions) != ORDER:
            raise ValueError("envelope completeness or region order invalid")
        if any(key.split(":")[0] != str(self.context.playerId) for key in self.coverage.shots.expectedKeys):
            raise ValueError("shot context belongs to another player")
        summaries = [self.accounting.source, self.accounting.inRegions, self.accounting.penalties, self.accounting.outside, *self.regions]
        unavailable = states[0] == "unavailable"
        if any((item.shots is None) != unavailable for item in summaries):
            raise ValueError("shot source availability contradicts values")
        if states[0] == "partial" and any(item.quality.state == "complete" for item in summaries):
            raise ValueError("partial source cannot report complete quality")
        if states[0] == "observed" and any(item.quality.state == "partial" and item.quality.eligible == item.shots for item in summaries):
            raise ValueError("fully observed eligible sample cannot report partial quality")
        account = self.accounting
        if unavailable:
            if account.reconciles is not None or self.denominators.selectedNonPenaltyShots is not None:
                raise ValueError("unavailable shot reconciliation must be null")
        else:
            for field in ("shots", "goals", "xgEligible"):
                if getattr(account.source, field) != sum(getattr(item, field) for item in (account.inRegions, account.penalties, account.outside)):
                    raise ValueError("shot accounting does not reconcile")
                if getattr(account.inRegions, field) != sum(getattr(item, field) for item in self.regions):
                    raise ValueError("region accounting does not reconcile")
            if account.reconciles is not True or self.denominators.selectedNonPenaltyShots != account.source.shots - account.penalties.shots:
                raise ValueError("non-penalty denominator invalid")
        activity = self.activityAccounting
        if states[1] == "unavailable":
            if any(value is not None for value in (activity.source, activity.inRegions, activity.outside, activity.reconciles, self.denominators.fullActivityCount, *(region.activity for region in self.regions))):
                raise ValueError("unavailable activity must be null")
        elif any(value is None for value in (activity.source, activity.inRegions, activity.outside, *(region.activity for region in self.regions))) or activity.reconciles is not True:
            raise ValueError("observed activity requires counts")
        elif activity.source != activity.inRegions + activity.outside or activity.inRegions != sum(region.activity for region in self.regions) or activity.source != self.denominators.fullActivityCount:
            raise ValueError("activity accounting does not reconcile")
        for region in self.regions:
            if region.shootingSharePct != _pct(region.shots, self.denominators.selectedNonPenaltyShots) or region.activitySharePct != _pct(region.activity, self.denominators.fullActivityCount):
                raise ValueError("shares must use original source denominators")
        return self


def build_box_subregion_envelope(context: BoxContext, selected_result: dict[str, Any]) -> BoxSubregionEnvelope:
    """Convert a core/source result without mutating it or inventing coverage."""
    aggregate = deepcopy(selected_result["aggregate"])
    coverage = Coverage.model_validate(selected_result["coverage"])
    regions = []
    for region_id in ORDER:
        region = aggregate["regions"][region_id]
        region["label"] = META[region_id][0]
        region.pop("shootingShare")
        region.pop("activityShare")
        region["shootingSharePct"] = _pct(region["shots"], aggregate["denominators"]["selectedNonPenaltyShots"])
        region["activitySharePct"] = _pct(region["activity"], aggregate["denominators"]["fullActivityCount"])
        regions.append(region)
    if coverage.shots.state == "partial":
        for item in [*regions, *(aggregate["accounting"][key] for key in ("source", "inRegions", "penalties", "outside"))]:
            if item["quality"]["state"] == "complete":
                item["quality"]["state"] = "partial"
    states = (coverage.shots.state, coverage.activity.state)
    return BoxSubregionEnvelope(
        schemaVersion="box-subregion-stats-v1", definitionVersion=aggregate["definitionVersion"],
        shotProvider="fotmob", activityProvider="sportsapi", context=context,
        completeness="observed" if states == ("observed", "observed") else "unavailable" if states == ("unavailable", "unavailable") else "partial",
        coverage=coverage, regions=regions, denominators=aggregate["denominators"],
        accounting=aggregate["accounting"], activityAccounting=aggregate["activityAccounting"],
    )
