"""Pure, source-labelled box-subregion aggregation.

This module deliberately has no API, cache, filesystem, or application-service
dependencies.  Callers provide already-normalized shot and full-activity records;
``None`` represents an unavailable source while an empty iterable represents an
observed empty source.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Any


DEFINITION_VERSION = "box-subregion-v1"
BOX_MIN_X = 84.29
PENALTY_X = 89.524
PENALTY_Y = 50.0
_REGION_ORDER = ("L4", "L3L", "L3R", "L2")
_REGIONS = {
    "L4": ("box_left", 63.0, 78.18),
    "L3L": ("box_centre_left", 50.0, 63.0),
    "L3R": ("box_centre_right", 37.0, 50.0),
    "L2": ("box_right", 21.82, 37.0),
}
_KNOWN_OUTCOMES = frozenset(
    {"goal", "save", "saved", "miss", "missed", "post", "block", "blocked", "on_target", "off_target"}
)


def calculate_box_subregions(
    shots: Iterable[Mapping[str, Any]] | None,
    activity: Iterable[Mapping[str, Any]] | None,
) -> dict[str, Any]:
    """Return box-only subregion aggregates without modifying either input.

    A shot record has ``x``, ``y``, ``outcome``, ``xg``, and ``xgot`` keys.
    xG/xGOT may be ``None`` but, when present, must be finite numbers.  An
    activity record has ``x``, ``y``, and integer ``count`` keys.  Coordinates
    are inclusive in the physical [0, 100] source range.  The four reporting
    regions use a half-open y maximum; a point at y=78.18 is therefore outside.

    The exact (89.524, 50) penalty spot is separate before ordinary lane
    assignment.  In particular, ordinary y=50 is L3L.
    """

    normalized_shots = _validate_shots(shots)
    normalized_activity = _validate_activity(activity)
    shot_source = _source_info(normalized_shots)
    activity_source = _source_info(normalized_activity)

    shot_groups: dict[str, list[dict[str, Any]]] = {region: [] for region in _REGION_ORDER}
    penalty_shots: list[dict[str, Any]] = []
    outside_shots: list[dict[str, Any]] = []
    if normalized_shots is not None:
        for shot in normalized_shots:
            region = _region_for(shot["x"], shot["y"])
            if _is_exact_penalty(shot["x"], shot["y"]):
                penalty_shots.append(shot)
            elif region is None:
                outside_shots.append(shot)
            else:
                shot_groups[region].append(shot)

    activity_groups: dict[str, int] | None
    if normalized_activity is None:
        activity_groups = None
    else:
        activity_groups = {region: 0 for region in _REGION_ORDER}
        for point in normalized_activity:
            region = _region_for(point["x"], point["y"])
            if region is not None:
                activity_groups[region] += point["count"]

    selected_non_pk = None if normalized_shots is None else len(normalized_shots) - len(penalty_shots)
    full_activity = None if normalized_activity is None else sum(point["count"] for point in normalized_activity)
    regions: dict[str, dict[str, Any]] = {}
    for region in _REGION_ORDER:
        shot_summary = _shot_summary(None if normalized_shots is None else shot_groups[region])
        activity_count = None if activity_groups is None else activity_groups[region]
        label, y_min, y_max = _REGIONS[region]
        regions[region] = {
            "id": region,
            "label": label,
            "bounds": {"xMinInclusive": BOX_MIN_X, "yMinInclusive": y_min, "yMaxExclusive": y_max},
            **shot_summary,
            "activity": activity_count,
            "shootingShare": _share(shot_summary["shots"], selected_non_pk),
            "activityShare": _share(activity_count, full_activity),
        }

    source_summary = _shot_summary(normalized_shots)
    penalty_summary = _shot_summary(None if normalized_shots is None else penalty_shots)
    outside_summary = _shot_summary(None if normalized_shots is None else outside_shots)
    in_region_shots = None if normalized_shots is None else [
        shot for region in _REGION_ORDER for shot in shot_groups[region]
    ]
    in_regions_summary = _shot_summary(in_region_shots)
    reconciles = (
        None
        if normalized_shots is None
        else source_summary["shots"]
        == in_regions_summary["shots"] + penalty_summary["shots"] + outside_summary["shots"]
    )
    in_region_activity = None if activity_groups is None else sum(activity_groups.values())
    outside_activity = None if full_activity is None else full_activity - in_region_activity

    return {
        "definitionVersion": DEFINITION_VERSION,
        "regionOrder": list(_REGION_ORDER),
        "sources": {"shots": shot_source, "activity": activity_source},
        "denominators": {"selectedNonPenaltyShots": selected_non_pk, "fullActivityCount": full_activity},
        "regions": regions,
        "accounting": {
            "source": source_summary,
            "inRegions": in_regions_summary,
            "penalties": penalty_summary,
            "outside": outside_summary,
            "reconciles": reconciles,
        },
        "activityAccounting": {
            "source": full_activity,
            "inRegions": in_region_activity,
            "outside": outside_activity,
            "reconciles": None if full_activity is None else full_activity == in_region_activity + outside_activity,
        },
    }


def _source_info(records: list[dict[str, Any]] | None) -> dict[str, Any]:
    return {"state": "unavailable" if records is None else "observed", "records": None if records is None else len(records)}


def _validate_shots(records: Iterable[Mapping[str, Any]] | None) -> list[dict[str, Any]] | None:
    if records is None:
        return None
    rows = _records_list(records, "shots")
    normalized: list[dict[str, Any]] = []
    for index, record in enumerate(rows):
        _require_keys(record, ("x", "y", "outcome", "xg", "xgot"), f"shots[{index}]")
        x = _finite_coordinate(record["x"], f"shots[{index}].x")
        y = _finite_coordinate(record["y"], f"shots[{index}].y")
        outcome = record["outcome"]
        if not isinstance(outcome, str) or outcome not in _KNOWN_OUTCOMES:
            raise ValueError(f"shots[{index}].outcome is not a recognized normalized outcome")
        normalized.append({"x": x, "y": y, "outcome": outcome, "xg": _optional_finite(record["xg"], f"shots[{index}].xg"), "xgot": _optional_finite(record["xgot"], f"shots[{index}].xgot")})
    return normalized


def _validate_activity(records: Iterable[Mapping[str, Any]] | None) -> list[dict[str, Any]] | None:
    if records is None:
        return None
    rows = _records_list(records, "activity")
    normalized: list[dict[str, Any]] = []
    for index, record in enumerate(rows):
        _require_keys(record, ("x", "y", "count"), f"activity[{index}]")
        count = record["count"]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError(f"activity[{index}].count must be a non-negative integer")
        normalized.append({"x": _finite_coordinate(record["x"], f"activity[{index}].x"), "y": _finite_coordinate(record["y"], f"activity[{index}].y"), "count": count})
    return normalized


def _records_list(records: Iterable[Mapping[str, Any]], label: str) -> list[Mapping[str, Any]]:
    if isinstance(records, (str, bytes, Mapping)):
        raise ValueError(f"{label} must be an iterable of records")
    try:
        rows = list(records)
    except TypeError as error:
        raise ValueError(f"{label} must be an iterable of records") from error
    if not all(isinstance(record, Mapping) for record in rows):
        raise ValueError(f"{label} must contain mappings")
    return rows


def _require_keys(record: Mapping[str, Any], keys: tuple[str, ...], label: str) -> None:
    missing = [key for key in keys if key not in record]
    if missing:
        raise ValueError(f"{label} missing required keys: {', '.join(missing)}")


def _finite_coordinate(value: Any, label: str) -> float:
    number = _finite_number(value, label)
    if number < 0.0 or number > 100.0:
        raise ValueError(f"{label} must be within [0, 100]")
    return number


def _optional_finite(value: Any, label: str) -> float | None:
    if value is None:
        return None
    number = _finite_number(value, label)
    if number < 0:
        raise ValueError(f"{label} must be non-negative")
    return number


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number")
    return number


def _is_exact_penalty(x: float, y: float) -> bool:
    return x == PENALTY_X and y == PENALTY_Y


def _region_for(x: float, y: float) -> str | None:
    if x < BOX_MIN_X:
        return None
    for region in _REGION_ORDER:
        _, y_min, y_max = _REGIONS[region]
        if y_min <= y < y_max:
            return region
    return None


def _shot_summary(records: list[dict[str, Any]] | None) -> dict[str, Any]:
    if records is None:
        return {"shots": None, "goals": None, "xg": None, "xgEligible": None, "quality": _quality_summary(None)}
    xg_values = [row["xg"] for row in records if row["xg"] is not None]
    return {
        "shots": len(records),
        "goals": sum(row["outcome"] == "goal" for row in records),
        "xg": _rounded_sum(xg_values) if xg_values or not records else None,
        "xgEligible": len(xg_values),
        "quality": _quality_summary(records),
    }


def _quality_summary(records: list[dict[str, Any]] | None) -> dict[str, Any]:
    if records is None:
        return {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}
    if not records:
        return {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}
    jointly_observed = [row for row in records if row["xg"] is not None and row["xgot"] is not None]
    if not jointly_observed:
        return {"xg": None, "xgot": None, "delta": None, "eligible": 0, "state": "unavailable"}
    xg = _rounded_sum([row["xg"] for row in jointly_observed])
    xgot = _rounded_sum([row["xgot"] for row in jointly_observed])
    return {
        "xg": xg,
        "xgot": xgot,
        "delta": round(xgot - xg, 4),
        "eligible": len(jointly_observed),
        "state": "complete" if len(jointly_observed) == len(records) else "partial",
    }


def _rounded_sum(values: list[float]) -> float:
    # Keep V3's established aggregation order/rounding semantics.
    return round(sum(values), 4)


def _share(numerator: int | None, denominator: int | None) -> float | None:
    if numerator is None or denominator is None or denominator == 0:
        return None
    return round(numerator / denominator, 4)
