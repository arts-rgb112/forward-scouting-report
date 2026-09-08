"""Strict public transport for caller-supplied native body-part aggregates.

The builder deliberately has no filesystem, provider, event, or coordinate access.
"""
from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from api_server.box_subregion_contract import BoxContext, StrictModel


Count = Annotated[int, Field(ge=0)]
PARTS = ("head", "leftFoot", "rightFoot", "other", "unknown")
# Fixed provider-native tournament identities; deliberately duplicated here to
# keep this strict transport module independent of the provider implementation.
COMPETITION_TOURNAMENTS = {
    "Premier League": (17, "domestic", None), "LaLiga": (8, "domestic", None),
    "Bundesliga": (35, "domestic", None), "Serie A": (23, "domestic", None),
    "Ligue 1": (34, "domestic", None), "Eredivisie": (37, "domestic", None),
    "Primeira Liga": (238, "domestic", None), "Belgian Pro League": (38, "domestic", None),
    "UEFA Champions League": (7, "europe", "ucl"),
    "UEFA Europa League": (679, "europe", "uel"),
    "UEFA Europa Conference League": (17015, "europe", "uecl"),
}
SOURCE_KEYS = frozenset({"provider", "fotmobPlayerId", "sourcePlayerId", "tournamentId", "seasonId", "season", "competition", "mappingKey"})
AGGREGATE_KEYS = frozenset({"sourcePlayerId", "includePenalties", "coverage", "admittedShotCount", "excludedPenaltyShots", "excludedPenaltyGoals", "filteredShotCount", "filteredGoalCount", "categories", "qualityRecords"})


class NativeBodyPartCounts(StrictModel):
    shots: Count | None
    goals: Count | None
    quality: "NativeBodyPartQuality"

    @model_validator(mode="after")
    def reconcile(self):
        if (self.shots is None) != (self.goals is None):
            raise ValueError("body-part counts must both be null or observed")
        if self.shots is not None and self.goals > self.shots:
            raise ValueError("body-part goals exceed shots")
        _check_quality_for_shots(self.quality, self.shots)
        return self


class NativeBodyPartQuality(StrictModel):
    xg: float | None
    xgot: float | None
    delta: float | None
    eligible: Count | None
    state: Literal["complete", "partial", "unavailable"]

    @model_validator(mode="after")
    def reconcile(self):
        values = (self.xg, self.xgot, self.delta, self.eligible)
        if self.state == "unavailable":
            if any(value is not None for value in (self.xg, self.xgot, self.delta)) or self.eligible not in (None, 0):
                raise ValueError("unavailable quality must have null metrics and no eligible pair")
            return self
        if any(value is None for value in values):
            raise ValueError("observed quality must be complete")
        if any(not math.isfinite(value) for value in (self.xg, self.xgot, self.delta)) or self.xg < 0 or self.xgot < 0:
            raise ValueError("quality metrics must be finite and nonnegative")
        if abs(self.delta - round(self.xgot - self.xg, 4)) > 0.000000001:
            raise ValueError("quality delta contradicts xgot minus xg")
        return self


class NativeBodyPartTotals(StrictModel):
    admittedShots: Count | None
    excludedPenaltyShots: Count | None
    excludedPenaltyGoals: Count | None
    shots: Count | None
    goals: Count | None
    quality: NativeBodyPartQuality

    @model_validator(mode="after")
    def reconcile(self):
        values = (self.admittedShots, self.excludedPenaltyShots, self.excludedPenaltyGoals, self.shots, self.goals)
        if any(value is None for value in values):
            if any(value is not None for value in values):
                raise ValueError("unavailable totals must all be null")
            if self.quality.state != "unavailable" or self.quality.eligible is not None:
                raise ValueError("unavailable totals require unavailable quality")
            return self
        if self.goals > self.shots or self.excludedPenaltyGoals > self.excludedPenaltyShots:
            raise ValueError("native goals exceed shots")
        if self.admittedShots != self.shots + self.excludedPenaltyShots:
            raise ValueError("admitted shots do not reconcile filter")
        _check_quality_for_shots(self.quality, self.shots)
        return self


class NativeBodyPartCoverage(StrictModel):
    state: Literal["complete", "partial", "unavailable"]
    expectedMatchIds: list[Annotated[int, Field(gt=0)]]
    validMatchIds: list[Annotated[int, Field(gt=0)]]
    missingMatchIds: list[Annotated[int, Field(gt=0)]]
    invalidMatchIds: list[Annotated[int, Field(gt=0)]]
    invalidReasons: dict[str, str]

    @model_validator(mode="after")
    def partition(self):
        groups = (self.expectedMatchIds, self.validMatchIds, self.missingMatchIds, self.invalidMatchIds)
        if any(group != sorted(set(group)) for group in groups):
            raise ValueError("match identifiers must be sorted and unique")
        expected = set(self.expectedMatchIds)
        valid, missing, invalid = map(set, groups[1:])
        if valid | missing | invalid != expected or (valid & missing) or (valid & invalid) or (missing & invalid):
            raise ValueError("coverage match identifiers do not partition expected selection")
        if set(self.invalidReasons) != {str(value) for value in invalid} or any(not reason for reason in self.invalidReasons.values()):
            raise ValueError("invalid reasons must exactly cover invalid matches")
        state = "complete" if expected and valid == expected else "partial" if valid else "unavailable"
        if self.state != state:
            raise ValueError("coverage state contradicts match selection")
        return self


class NativeBodyPartSource(StrictModel):
    provider: Literal["sportsapi"]
    fotmobPlayerId: Annotated[int, Field(gt=0)]
    sourcePlayerId: Annotated[int, Field(gt=0)]
    tournamentId: Annotated[int, Field(gt=0)]
    seasonId: Annotated[int, Field(gt=0)]
    season: Annotated[str, Field(pattern=r"^20\d{2}/20\d{2}$")]
    competition: Annotated[str, Field(min_length=1)]
    mappingKey: str
    coverage: NativeBodyPartCoverage
    totals: NativeBodyPartTotals
    parts: dict[Literal["head", "leftFoot", "rightFoot", "other", "unknown"], NativeBodyPartCounts]

    @model_validator(mode="after")
    def consistency(self):
        if self.mappingKey != f"{self.fotmobPlayerId}:{self.tournamentId}:{self.seasonId}":
            raise ValueError("mapping key contradicts source identity")
        start, end = map(int, self.season.split("/"))
        if end != start + 1 or set(self.parts) != set(PARTS):
            raise ValueError("source season or part taxonomy is invalid")
        unavailable = self.coverage.state == "unavailable"
        if (self.totals.shots is None) != unavailable or any((part.shots is None) != unavailable for part in self.parts.values()):
            raise ValueError("source availability contradicts coverage")
        if not unavailable:
            if sum(part.shots for part in self.parts.values()) != self.totals.shots or sum(part.goals for part in self.parts.values()) != self.totals.goals:
                raise ValueError("source body-part counts do not reconcile totals")
            _check_quality_children(self.totals.quality, [part.quality for part in self.parts.values()])
        return self


class NativeBodyPartEnvelope(StrictModel):
    schemaVersion: Literal["native-body-part-stats-v2"]
    context: BoxContext
    includePenalties: bool
    provider: Literal["sportsapi"]
    completeness: Literal["complete", "partial", "unavailable"]
    sources: list[NativeBodyPartSource]
    totals: NativeBodyPartTotals
    parts: dict[Literal["head", "leftFoot", "rightFoot", "other", "unknown"], NativeBodyPartCounts]

    @model_validator(mode="after")
    def reconcile(self):
        if set(self.parts) != set(PARTS):
            raise ValueError("envelope part taxonomy is invalid")
        for source in self.sources:
            _validate_source_context(self.context, source)
        keys = [source.mappingKey for source in self.sources]
        if len(keys) != len(set(keys)):
            raise ValueError("selected mappings must be unique")
        state = "unavailable" if not self.sources or all(source.coverage.state == "unavailable" for source in self.sources) else "complete" if all(source.coverage.state == "complete" for source in self.sources) else "partial"
        if self.completeness != state:
            raise ValueError("envelope completeness contradicts source coverage")
        unavailable = state == "unavailable"
        if (self.totals.shots is None) != unavailable or any((part.shots is None) != unavailable for part in self.parts.values()):
            raise ValueError("envelope availability contradicts source coverage")
        observed = [source for source in self.sources if source.totals.shots is not None]
        if not unavailable:
            for field in ("admittedShots", "excludedPenaltyShots", "excludedPenaltyGoals", "shots", "goals"):
                if getattr(self.totals, field) != sum(getattr(source.totals, field) for source in observed):
                    raise ValueError("envelope totals do not reconcile sources")
            for part in PARTS:
                for field in ("shots", "goals"):
                    if getattr(self.parts[part], field) != sum(getattr(source.parts[part], field) for source in observed):
                        raise ValueError("envelope body-part counts do not reconcile sources")
                _check_quality_children(self.parts[part].quality, [source.parts[part].quality for source in self.sources])
            _check_quality_children(self.totals.quality, [source.totals.quality for source in self.sources])
            _check_quality_children(self.totals.quality, [part.quality for part in self.parts.values()])
        if self.includePenalties and self.totals.excludedPenaltyShots not in (None, 0):
            raise ValueError("included penalties cannot be excluded")
        return self


def _empty_counts() -> dict[str, dict[str, None]]:
    return {part: {"shots": None, "goals": None, "quality": _unavailable_quality()} for part in PARTS}


def _unavailable_quality() -> dict[str, Any]:
    return {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}


def _quality(records: list[dict[str, Any]], *, observed: bool) -> dict[str, Any]:
    if not observed:
        return _unavailable_quality()
    paired = [record for record in records if record["xg"] is not None and record["xgot"] is not None]
    if not records:
        return {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}
    if not paired:
        return {"xg": None, "xgot": None, "delta": None, "eligible": 0, "state": "unavailable"}
    xg = round(sum(record["xg"] for record in paired), 4)
    xgot = round(sum(record["xgot"] for record in paired), 4)
    return {"xg": xg, "xgot": xgot, "delta": round(xgot - xg, 4), "eligible": len(paired),
            "state": "complete" if len(paired) == len(records) else "partial"}


def _check_quality_children(parent: NativeBodyPartQuality, children: list[NativeBodyPartQuality]) -> None:
    observed = [child for child in children if child.state != "unavailable"]
    if not observed:
        if parent.state != "unavailable":
            raise ValueError("unavailable children require unavailable parent quality")
        return
    eligible = sum(child.eligible or 0 for child in observed)
    if parent.eligible != eligible:
        raise ValueError("quality eligibility does not reconcile children")
    if parent.state == "unavailable":
        if eligible:
            raise ValueError("paired child quality requires observed parent")
        return
    metric_children = [child for child in observed if child.xg is not None]
    if not metric_children:
        if parent.eligible != 0 or parent.state != "unavailable":
            raise ValueError("unpaired child quality requires unavailable parent")
        return
    tolerance = (len(metric_children) + 1) * 0.00005 + 1e-9
    if abs(parent.xg - sum(child.xg for child in metric_children)) > tolerance or abs(parent.xgot - sum(child.xgot for child in metric_children)) > tolerance:
        raise ValueError("quality totals exceed rounding tolerance")


def _check_quality_for_shots(quality: NativeBodyPartQuality, shots: int | None) -> None:
    if shots is None:
        if quality.state != "unavailable" or quality.eligible is not None:
            raise ValueError("unavailable counts require unavailable source quality")
        return
    if shots == 0:
        if quality.state != "complete" or quality.eligible != 0 or (quality.xg, quality.xgot, quality.delta) != (0.0, 0.0, 0.0):
            raise ValueError("observed zero counts require observed-zero quality")
        return
    if quality.state == "unavailable":
        if quality.eligible != 0:
            raise ValueError("unpaired observed counts require zero eligible pairs")
    elif quality.state == "complete":
        if quality.eligible != shots:
            raise ValueError("complete quality must cover every observed shot")
    elif not 0 < quality.eligible < shots:
        raise ValueError("partial quality must cover a strict subset of observed shots")


def _unavailable_source(source: dict[str, Any]) -> NativeBodyPartSource:
    return NativeBodyPartSource(**source, coverage={"state": "unavailable", "expectedMatchIds": [], "validMatchIds": [], "missingMatchIds": [], "invalidMatchIds": [], "invalidReasons": {}}, totals={"admittedShots": None, "excludedPenaltyShots": None, "excludedPenaltyGoals": None, "shots": None, "goals": None, "quality": _unavailable_quality()}, parts=_empty_counts())


def _source_from_aggregate(source: dict[str, Any], aggregate: dict[str, Any], include_penalties: bool) -> NativeBodyPartSource:
    if set(aggregate) != AGGREGATE_KEYS or aggregate["sourcePlayerId"] != source["sourcePlayerId"] or aggregate["includePenalties"] is not include_penalties:
        raise ValueError("native aggregate contradicts source identity or requested penalty filter")
    categories = aggregate["categories"]
    if not isinstance(categories, dict) or set(categories) != set(PARTS):
        raise ValueError("native aggregate part taxonomy is invalid")
    coverage = aggregate["coverage"]
    valid_match_ids = coverage.get("validMatchIds") if isinstance(coverage, dict) else None
    if not isinstance(valid_match_ids, list) or any(isinstance(match_id, bool) or not isinstance(match_id, int) or match_id <= 0 for match_id in valid_match_ids):
        raise ValueError("native aggregate coverage valid matches are invalid")
    records = _quality_records(aggregate["qualityRecords"], source["sourcePlayerId"], set(valid_match_ids))
    if not include_penalties and any(record["isPenalty"] for record in records):
        raise ValueError("excluded-penalty aggregate retains a penalty quality record")
    observed = aggregate["filteredShotCount"] is not None
    expected_records = records if observed else []
    if observed and (aggregate["filteredShotCount"] != len(expected_records) or aggregate["filteredGoalCount"] != sum(record["shotType"] == "goal" for record in expected_records)):
        raise ValueError("native aggregate counts contradict raw quality records")
    if not observed and (records or categories != _empty_counts()):
        raise ValueError("unavailable native aggregate must not expose observed values")
    parts = {}
    for part in PARTS:
        part_records = [record for record in expected_records if _public_part(record["bodyPart"]) == part]
        expected = ({"shots": len(part_records), "goals": sum(record["shotType"] == "goal" for record in part_records),
                     "quality": _quality(part_records, observed=True)} if observed else _empty_counts()[part])
        if categories[part] != expected:
            raise ValueError("native aggregate part values contradict raw quality records")
        parts[part] = expected
    total_quality = _quality(expected_records, observed=observed)
    return NativeBodyPartSource(**source, coverage=aggregate["coverage"], totals={
        "admittedShots": aggregate["admittedShotCount"], "excludedPenaltyShots": aggregate["excludedPenaltyShots"],
        "excludedPenaltyGoals": aggregate["excludedPenaltyGoals"], "shots": aggregate["filteredShotCount"], "goals": aggregate["filteredGoalCount"], "quality": total_quality,
    }, parts=parts)


def _public_part(value: str) -> str:
    return {"head": "head", "left-foot": "leftFoot", "right-foot": "rightFoot", "other": "other", "unknown": "unknown"}[value]


def _quality_records(value: Any, player_id: int, valid_match_ids: set[int] | None = None) -> list[dict[str, Any]]:
    keys = frozenset({"matchId", "eventId", "playerId", "bodyPart", "shotType", "isPenalty", "xg", "xgot"})
    if not isinstance(value, list):
        raise ValueError("native quality records must be a list")
    result = []
    identities = set()
    for record in value:
        if not isinstance(record, dict) or set(record) != keys:
            raise ValueError("native quality record schema is invalid")
        if any(isinstance(record[key], bool) or not isinstance(record[key], int) or record[key] <= 0 for key in ("matchId", "eventId", "playerId")) or record["playerId"] != player_id:
            raise ValueError("native quality record identity is invalid")
        identity = (record["matchId"], record["eventId"])
        if identity in identities:
            raise ValueError("duplicate native quality event")
        identities.add(identity)
        if valid_match_ids is not None and record["matchId"] not in valid_match_ids:
            raise ValueError("native quality event is outside valid source coverage")
        if record["bodyPart"] not in {"head", "left-foot", "right-foot", "other", "unknown"} or record["shotType"] not in {"goal", "save", "miss", "post", "block"} or not isinstance(record["isPenalty"], bool):
            raise ValueError("native quality record classification is invalid")
        for metric in ("xg", "xgot"):
            raw = record[metric]
            if raw is not None and (isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw) or raw < 0):
                raise ValueError("native quality record metric is invalid")
        result.append(dict(record))
    return sorted(result, key=lambda record: (record["matchId"], record["eventId"]))


def _source_value(source: dict[str, Any] | NativeBodyPartSource, key: str) -> Any:
    return source.get(key) if isinstance(source, dict) else getattr(source, key)


def _validate_source_context(context: BoxContext, source: dict[str, Any] | NativeBodyPartSource) -> None:
    if isinstance(source, dict) and set(source) != SOURCE_KEYS:
        raise ValueError("native source metadata has unexpected fields")
    if _source_value(source, "fotmobPlayerId") != context.playerId or _source_value(source, "season") != context.season:
        raise ValueError("native source belongs to another player or season")
    competition = _source_value(source, "competition")
    catalog = COMPETITION_TOURNAMENTS.get(competition)
    if catalog is None or _source_value(source, "tournamentId") != catalog[0]:
        raise ValueError("native source competition contradicts tournament identity")
    _, group, code = catalog
    if context.mode == "league":
        if group != "domestic":
            raise ValueError("league context cannot use UEFA source")
    else:
        if group != "europe" or (context.competition != "all" and code != context.competition):
            raise ValueError("European source contradicts requested competition")


def build_native_body_part_envelope(
    context: BoxContext,
    source_results: list[dict[str, Any]],
    *,
    include_penalties: bool = True,
) -> NativeBodyPartEnvelope:
    """Build a fully reconciled DTO from verified source mappings and aggregates."""
    if not isinstance(context, BoxContext) or not isinstance(include_penalties, bool) or not isinstance(source_results, list):
        raise ValueError("context, include_penalties, and source_results have invalid types")
    sources = []
    source_records: list[list[dict[str, Any]]] = []
    for item in sorted(deepcopy(source_results), key=lambda item: item.get("source", {}).get("mappingKey", "")):
        if not isinstance(item, dict) or set(item) != {"source", "aggregate"} or not isinstance(item["source"], dict):
            raise ValueError("source result must contain only source metadata and aggregate")
        source = item["source"]
        _validate_source_context(context, source)
        if item["aggregate"] is None:
            sources.append(_unavailable_source(source))
            source_records.append([])
        else:
            sources.append(_source_from_aggregate(source, item["aggregate"], include_penalties))
            coverage = item["aggregate"]["coverage"]
            source_records.append(_quality_records(item["aggregate"]["qualityRecords"], source["sourcePlayerId"], set(coverage["validMatchIds"])))
    observed = [source for source in sources if source.totals.shots is not None]
    if not observed:
        totals = {"admittedShots": None, "excludedPenaltyShots": None, "excludedPenaltyGoals": None, "shots": None, "goals": None, "quality": _unavailable_quality()}
        parts = _empty_counts()
        completeness = "unavailable"
    else:
        raw_records = [record for records in source_records for record in records]
        totals = {field: sum(getattr(source.totals, field) for source in observed) for field in ("admittedShots", "excludedPenaltyShots", "excludedPenaltyGoals", "shots", "goals")}
        totals["quality"] = _quality(raw_records, observed=True)
        parts = {}
        for part in PARTS:
            records = [record for record in raw_records if _public_part(record["bodyPart"]) == part]
            parts[part] = {"shots": sum(getattr(source.parts[part], "shots") for source in observed),
                           "goals": sum(getattr(source.parts[part], "goals") for source in observed),
                           "quality": _quality(records, observed=True)}
        completeness = "complete" if all(source.coverage.state == "complete" for source in sources) else "partial"
    return NativeBodyPartEnvelope(schemaVersion="native-body-part-stats-v2", context=context, includePenalties=include_penalties,
                                  provider="sportsapi", completeness=completeness, sources=sources, totals=totals, parts=parts)
