"""Pure, source-labelled box-subregion aggregation over native shot events.

This module deliberately has no API, cache, filesystem, or application-service
dependencies. Callers provide already-normalized native event records; ``None``
represents an unavailable source while an empty iterable represents an
observed empty source.

Native display coordinates (``sportsapi-draw-pitch-display-v1``) are a
schematic/display coordinate system, not the exact source-of-truth pitch
coordinates the legacy ``box_subregion_core`` module uses. In particular the
legacy module's exact (89.524, 50) penalty-spot coordinate match does not
apply here: a native event's penalty status is decided ONLY by its own
recorded ``isPenalty`` flag, never by its plotted position. This module does
not call, import, or reuse ``calculate_box_subregions``' penalty logic.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Any


DEFINITION_VERSION = "native-display-box-subregion-v1"
COORDINATE_DEFINITION = "sportsapi-draw-pitch-display-v1"
BOX_MIN_X = 84.29
_REGION_ORDER = ("L4", "L3L", "L3R", "L2")
_REGIONS = {
    "L4": ("box_left", 63.0, 78.18),
    "L3L": ("box_centre_left", 50.0, 63.0),
    "L3R": ("box_centre_right", 37.0, 50.0),
    "L2": ("box_right", 21.82, 37.0),
}
_SHOT_TYPES = frozenset({"goal", "save", "miss", "post", "block"})
_PLOT_STATES = frozenset({"projected", "unlocated"})
_IDENTITY_KEYS = ("mappingKey", "sourcePlayerId", "matchId", "shotId")


def calculate_native_box(events: Iterable[Mapping[str, Any]] | None) -> dict[str, Any]:
    """Return box-only subregion aggregates for native shot events.

    Each event provides ``identity`` (``mappingKey``, ``sourcePlayerId``,
    ``matchId``, ``shotId``), ``isPenalty`` (bool), ``shotType`` (one of
    goal/save/miss/post/block), ``xg``/``xgot`` (nullable finite, >= 0), and
    ``plot`` (``state``: projected|unlocated, ``x``/``y``: 0..100 when
    projected, else ``None``). Extra fields (body part, source-native raw
    payload, etc.) may be present; only the fields above are read.

    Penalty classification is coordinate-independent: ``isPenalty`` alone
    decides it, always ahead of region assignment. A non-penalty event with
    an unlocated plot is its own accounting bucket — it is never folded into
    "outside" and it is still counted in the shooting-share denominator. The
    four reporting regions use the same half-open y ranges as the legacy box
    core (x >= 84.29 required; y maximum is exclusive).

    This function performs no activity aggregation or cross-source
    combination of its own — a separate, already-approved activity source is
    expected to be joined by the caller.
    """

    normalized = _validate_events(events)
    source = {"state": "unavailable" if normalized is None else "observed", "records": None if normalized is None else len(normalized)}

    if normalized is None:
        region_summaries = {region: _empty_region(region) for region in _REGION_ORDER}
        empty = _shot_summary(None)
        return {
            "definitionVersion": DEFINITION_VERSION,
            "coordinateDefinition": COORDINATE_DEFINITION,
            "regionOrder": list(_REGION_ORDER),
            "source": source,
            "denominators": {"selectedNonPenaltyShots": None},
            "regions": region_summaries,
            "accounting": {"source": empty, "inRegions": empty, "penalties": empty, "outside": empty, "unlocated": empty, "reconciles": None},
        }

    # Deterministic processing order regardless of input order — never lets
    # incidental input ordering change which floating-point summation order
    # produced a rounded total.
    ordered = sorted(normalized, key=lambda event: (event["identity"]["mappingKey"], event["identity"]["matchId"], event["identity"]["shotId"]))

    penalties: list[dict[str, Any]] = []
    non_penalty: list[dict[str, Any]] = []
    for event in ordered:
        (penalties if event["isPenalty"] else non_penalty).append(event)

    region_groups: dict[str, list[dict[str, Any]]] = {region: [] for region in _REGION_ORDER}
    unlocated: list[dict[str, Any]] = []
    outside: list[dict[str, Any]] = []
    for event in non_penalty:
        if event["plot"]["state"] == "unlocated":
            unlocated.append(event)
            continue
        region = _region_for(event["plot"]["x"], event["plot"]["y"])
        if region is None:
            outside.append(event)
        else:
            region_groups[region].append(event)

    selected_non_penalty = len(non_penalty)
    regions: dict[str, dict[str, Any]] = {}
    for region in _REGION_ORDER:
        shot_summary = _shot_summary(region_groups[region])
        label, y_min, y_max = _REGIONS[region]
        regions[region] = {
            "id": region,
            "label": label,
            "bounds": {"xMinInclusive": BOX_MIN_X, "yMinInclusive": y_min, "yMaxExclusive": y_max},
            **shot_summary,
            "shootingSharePct": _share_pct(shot_summary["shots"], selected_non_penalty),
        }

    source_summary = _shot_summary(ordered)
    penalty_summary = _shot_summary(penalties)
    outside_summary = _shot_summary(outside)
    unlocated_summary = _shot_summary(unlocated)
    in_region_events = [event for region in _REGION_ORDER for event in region_groups[region]]
    in_regions_summary = _shot_summary(in_region_events)
    reconciles = source_summary["shots"] == (
        in_regions_summary["shots"] + penalty_summary["shots"] + outside_summary["shots"] + unlocated_summary["shots"]
    )

    return {
        "definitionVersion": DEFINITION_VERSION,
        "coordinateDefinition": COORDINATE_DEFINITION,
        "regionOrder": list(_REGION_ORDER),
        "source": source,
        "denominators": {"selectedNonPenaltyShots": selected_non_penalty},
        "regions": regions,
        "accounting": {
            "source": source_summary,
            "inRegions": in_regions_summary,
            "penalties": penalty_summary,
            "outside": outside_summary,
            "unlocated": unlocated_summary,
            "reconciles": reconciles,
        },
    }


def _empty_region(region: str) -> dict[str, Any]:
    label, y_min, y_max = _REGIONS[region]
    return {
        "id": region,
        "label": label,
        "bounds": {"xMinInclusive": BOX_MIN_X, "yMinInclusive": y_min, "yMaxExclusive": y_max},
        **_shot_summary(None),
        "shootingSharePct": None,
    }


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
        "goals": sum(row["shotType"] == "goal" for row in records),
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
    # Keep the same paired-sum → round(4) → delta aggregation order the
    # legacy box core and native-body-part quality already established.
    return round(sum(values), 4)


def _share_pct(numerator: int | None, denominator: int | None) -> float | None:
    if numerator is None or denominator is None or denominator == 0:
        return None
    return round(numerator / denominator * 100, 4)


def _validate_events(events: Iterable[Mapping[str, Any]] | None) -> list[dict[str, Any]] | None:
    if events is None:
        return None
    rows = _records_list(events)
    normalized: list[dict[str, Any]] = []
    seen_identities: set[tuple[Any, ...]] = set()
    for index, record in enumerate(rows):
        label = f"events[{index}]"
        _require_keys(record, ("identity", "isPenalty", "shotType", "xg", "xgot", "plot"), label)
        identity = _validate_identity(record["identity"], f"{label}.identity")
        key = tuple(identity[field] for field in _IDENTITY_KEYS)
        if key in seen_identities:
            raise ValueError(f"{label}.identity duplicates an earlier event")
        seen_identities.add(key)

        is_penalty = record["isPenalty"]
        if not isinstance(is_penalty, bool):
            raise ValueError(f"{label}.isPenalty must be a boolean")

        shot_type = record["shotType"]
        if not isinstance(shot_type, str) or shot_type not in _SHOT_TYPES:
            raise ValueError(f"{label}.shotType is not a recognized native shot type")

        xg = _optional_nonnegative_finite(record["xg"], f"{label}.xg")
        xgot = _optional_nonnegative_finite(record["xgot"], f"{label}.xgot")
        plot = _validate_plot(record["plot"], f"{label}.plot")

        normalized.append({"identity": identity, "isPenalty": is_penalty, "shotType": shot_type, "xg": xg, "xgot": xgot, "plot": plot})
    return normalized


def _validate_identity(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be a mapping")
    _require_keys(value, _IDENTITY_KEYS, label)
    identity: dict[str, Any] = {
        "mappingKey": _positive_triple_string(value["mappingKey"], f"{label}.mappingKey"),
        "sourcePlayerId": _positive_int(value["sourcePlayerId"], f"{label}.sourcePlayerId"),
        "matchId": _positive_int(value["matchId"], f"{label}.matchId"),
        "shotId": _positive_int(value["shotId"], f"{label}.shotId"),
    }
    return identity


def _positive_int(value: Any, label: str) -> int:
    # Deliberately narrow (unlike the legacy box core's numeric coordinates):
    # this is a hashable identity component that later goes into a `set` for
    # duplicate detection, so anything but a real positive int — including a
    # numeric-looking string, float, list, or dict — must fail closed here
    # rather than risk an unrelated TypeError from the set itself.
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def _positive_triple_string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    parts = value.split(":")
    # `str.isdigit()` alone is too permissive here — it accepts Unicode digit
    # characters (e.g. superscripts, full-width forms) that are not ASCII
    # '0'-'9'. `isascii()` + `isdecimal()` together restrict to plain ASCII
    # decimal digits; a leading '0' (other than the single-digit '0' itself,
    # which is excluded anyway since it isn't positive) is rejected outright
    # so "01" is never treated as a canonical positive-integer segment.
    if len(parts) != 3 or not all(part.isascii() and part.isdecimal() and part[0] != "0" for part in parts):
        raise ValueError(f"{label} must be a canonical ASCII 'positiveId:positiveId:positiveId' string (no leading zeros)")
    return value


def _validate_plot(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be a mapping")
    _require_keys(value, ("state", "x", "y"), label)
    state = value["state"]
    if not isinstance(state, str) or state not in _PLOT_STATES:
        raise ValueError(f"{label}.state must be 'projected' or 'unlocated'")
    if state == "unlocated":
        if value["x"] is not None or value["y"] is not None:
            raise ValueError(f"{label}: unlocated plot must have null x/y")
        return {"state": state, "x": None, "y": None}
    x = _finite_coordinate(value["x"], f"{label}.x")
    y = _finite_coordinate(value["y"], f"{label}.y")
    return {"state": state, "x": x, "y": y}


def _records_list(records: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    if isinstance(records, (str, bytes, Mapping)):
        raise ValueError("events must be an iterable of records")
    try:
        rows = list(records)
    except TypeError as error:
        raise ValueError("events must be an iterable of records") from error
    if not all(isinstance(record, Mapping) for record in rows):
        raise ValueError("events must contain mappings")
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


def _optional_nonnegative_finite(value: Any, label: str) -> float | None:
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
