"""Pure exact-identity native body-part aggregation.

Callers provide already-filtered per-match records.  This module never attempts
to join coordinates, names, arrays, or another provider's events.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
import math
from typing import Any


_BODY_PARTS = ("head", "left-foot", "right-foot", "other", "unknown")
_OUTPUT_CATEGORY = {
    "head": "head",
    "left-foot": "leftFoot",
    "right-foot": "rightFoot",
    "other": "other",
    "unknown": "unknown",
}
_SHOT_TYPES = frozenset({"goal", "save", "miss", "post", "block"})
_RECORD_KEYS = frozenset({"matchId", "eventId", "playerId", "bodyPart", "shotType", "isPenalty", "xg", "xgot"})


def aggregate_native_body_parts(
    source_player_id: int,
    expected_match_ids: Iterable[int],
    match_payloads: Mapping[int, Any],
    *,
    include_penalties: bool = True,
) -> dict[str, Any]:
    """Aggregate only exact ``(matchId, eventId, playerId)`` native records.

    An absent expected match is missing.  A present malformed match is reported
    invalid as a whole and contributes no zero-filled counts.  Valid empty match
    payloads are observed zero sources.
    """

    _positive_int(source_player_id, "source_player_id")
    if not isinstance(include_penalties, bool):
        raise ValueError("include_penalties must be a boolean")
    expected = _expected_matches(expected_match_ids)
    if not isinstance(match_payloads, Mapping):
        raise ValueError("match_payloads must be a mapping keyed by exact matchId")
    if any(not isinstance(key, int) or isinstance(key, bool) or key <= 0 for key in match_payloads):
        raise ValueError("match_payloads keys must be positive integer matchIds")
    unexpected = set(match_payloads) - set(expected)
    if unexpected:
        raise ValueError("match_payloads contains unselected matchId")

    admitted: list[dict[str, Any]] = []
    valid: list[int] = []
    missing: list[int] = []
    invalid: dict[int, str] = {}
    for match_id in expected:
        if match_id not in match_payloads:
            missing.append(match_id)
            continue
        try:
            records = _validated_match(match_id, source_player_id, match_payloads[match_id])
        except ValueError as error:
            invalid[match_id] = str(error)
            continue
        valid.append(match_id)
        admitted.extend(records)

    state = "complete" if len(valid) == len(expected) else "partial" if valid else "unavailable"
    if state == "unavailable":
        categories = _unavailable_categories()
        excluded_shots = excluded_goals = filtered_shots = filtered_goals = None
        filtered = []
    else:
        excluded = [] if include_penalties else [record for record in admitted if record["isPenalty"]]
        filtered = admitted if include_penalties else [record for record in admitted if not record["isPenalty"]]
        # Quality sums and the internal evidence stream share one stable order;
        # otherwise legal raw event ordering could alter a floating sum's last bit.
        filtered = sorted(filtered, key=lambda record: (record["matchId"], record["eventId"]))
        categories = _categories(filtered)
        excluded_shots = len(excluded)
        excluded_goals = sum(record["shotType"] == "goal" for record in excluded)
        filtered_shots = len(filtered)
        filtered_goals = sum(record["shotType"] == "goal" for record in filtered)
    return {
        "sourcePlayerId": source_player_id,
        "includePenalties": include_penalties,
        "coverage": {
            "state": state,
            "expectedMatchIds": expected,
            "validMatchIds": valid,
            "missingMatchIds": missing,
            "invalidMatchIds": sorted(invalid),
            "invalidReasons": {str(match_id): invalid[match_id] for match_id in sorted(invalid)},
        },
        "admittedShotCount": len(admitted) if state != "unavailable" else None,
        "excludedPenaltyShots": excluded_shots,
        "excludedPenaltyGoals": excluded_goals,
        "filteredShotCount": filtered_shots,
        "filteredGoalCount": filtered_goals,
        "categories": categories,
        # Internal builder input only.  The strict public DTO consumes this
        # evidence to derive source/envelope quality and never serializes it.
        "qualityRecords": filtered,
    }


def _expected_matches(values: Iterable[int]) -> list[int]:
    if isinstance(values, (str, bytes, Mapping)):
        raise ValueError("expected_match_ids must be a non-empty iterable of positive integers")
    try:
        matches = list(values)
    except TypeError as error:
        raise ValueError("expected_match_ids must be a non-empty iterable of positive integers") from error
    if not matches:
        raise ValueError("expected_match_ids must be non-empty")
    for match_id in matches:
        _positive_int(match_id, "expected_match_ids value")
    if len(matches) != len(set(matches)):
        raise ValueError("expected_match_ids must be unique")
    return sorted(matches)


def _validated_match(match_id: int, source_player_id: int, payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, (str, bytes, Mapping)) or not isinstance(payload, Sequence):
        raise ValueError("payload must be a list of normalized records")
    records: list[dict[str, Any]] = []
    event_ids: set[int] = set()
    for index, record in enumerate(payload):
        if not isinstance(record, Mapping):
            raise ValueError("record must be a mapping")
        if set(record) != _RECORD_KEYS:
            raise ValueError("record keys must exactly match normalized native schema")
        _positive_int(record["matchId"], f"record[{index}].matchId")
        if record["matchId"] != match_id:
            raise ValueError("record matchId mismatch")
        _positive_int(record["playerId"], f"record[{index}].playerId")
        if record["playerId"] != source_player_id:
            raise ValueError("record playerId mismatch")
        event_id = record["eventId"]
        _positive_int(event_id, f"record[{index}].eventId")
        if event_id in event_ids:
            raise ValueError("duplicate eventId in match payload")
        event_ids.add(event_id)
        if not isinstance(record["bodyPart"], str) or record["bodyPart"] not in _BODY_PARTS:
            raise ValueError("record bodyPart is invalid")
        if not isinstance(record["shotType"], str) or record["shotType"] not in _SHOT_TYPES:
            raise ValueError("record shotType is invalid")
        if not isinstance(record["isPenalty"], bool):
            raise ValueError("record isPenalty must be a boolean")
        xg = _metric(record["xg"], f"record[{index}].xg")
        xgot = _metric(record["xgot"], f"record[{index}].xgot")
        records.append({"matchId": match_id, "eventId": event_id, "playerId": source_player_id,
                        "bodyPart": record["bodyPart"], "shotType": record["shotType"],
                        "isPenalty": record["isPenalty"], "xg": xg, "xgot": xgot})
    return records


def _positive_int(value: Any, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")


def _metric(value: Any, label: str) -> float | int | None:
    """Accept absent/null metrics, but reject malformed observed values."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{label} must be null or a finite nonnegative number")
    return value


def _categories(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped = {category: [] for category in _OUTPUT_CATEGORY.values()}
    result = {category: {"shots": 0, "goals": 0} for category in _OUTPUT_CATEGORY.values()}
    for record in records:
        category = _OUTPUT_CATEGORY[record["bodyPart"]]
        result[category]["shots"] += 1
        result[category]["goals"] += record["shotType"] == "goal"
        grouped[category].append(record)
    for category, category_records in grouped.items():
        result[category]["quality"] = _quality(category_records, observed=True)
    return result


def _unavailable_categories() -> dict[str, dict[str, Any]]:
    return {category: {"shots": None, "goals": None, "quality": _quality([], observed=False)} for category in _OUTPUT_CATEGORY.values()}


def _quality(records: Sequence[Mapping[str, Any]], *, observed: bool) -> dict[str, Any]:
    if not observed:
        return {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}
    paired = [record for record in records if record["xg"] is not None and record["xgot"] is not None]
    if not records:
        return {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}
    if not paired:
        return {"xg": None, "xgot": None, "delta": None, "eligible": 0, "state": "unavailable"}
    xg = round(sum(record["xg"] for record in paired), 4)
    xgot = round(sum(record["xgot"] for record in paired), 4)
    return {"xg": xg, "xgot": xgot, "delta": round(xgot - xg, 4), "eligible": len(paired),
            "state": "complete" if len(paired) == len(records) else "partial"}
