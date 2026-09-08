"""Pure exact-key source selection for the box-subregion core.

This is intentionally an internal adapter: it accepts caller-provided snapshots
only and neither reads files nor invokes a provider.  A future production adapter
must load verified paths before calling this function.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
import re
from typing import Any

from api_server.box_subregion_core import calculate_box_subregions


_CONTEXT_FIELDS = ("fotmobPlayerId", "sportsapiPlayerId", "tournamentId", "seasonId")


def aggregate_selected_box_sources(
    selected_contexts: Iterable[Mapping[str, Any]],
    shot_snapshots: Mapping[str, Any],
    activity_snapshots: Mapping[str, Any],
) -> dict[str, Any]:
    """Aggregate selected, identity-keyed snapshots without cross-source joins.

    ``[]`` under an expected key means an observed empty source.  An absent key
    means unavailable for that context.  Present malformed values fail closed;
    they are never converted into an unavailable or zero result.
    """

    contexts = _validated_contexts(selected_contexts)
    _validate_snapshot_mapping(shot_snapshots, "shot_snapshots")
    _validate_snapshot_mapping(activity_snapshots, "activity_snapshots")

    shot_expected = [context["shotKey"] for context in contexts]
    activity_expected = [context["activityKey"] for context in contexts]
    shot_observed = [key for key in shot_expected if key in shot_snapshots]
    activity_observed = [key for key in activity_expected if key in activity_snapshots]

    shots: list[dict[str, Any]] = []
    for key in shot_observed:
        shots.extend(_normalized_shot_snapshot(shot_snapshots[key], key))
    activity: list[dict[str, Any]] = []
    for key in activity_observed:
        activity.extend(_normalized_activity_snapshot(activity_snapshots[key], key))

    return {
        "coverage": {
            "shots": _coverage(shot_expected, shot_observed),
            "activity": _coverage(activity_expected, activity_observed),
        },
        "aggregate": calculate_box_subregions(shots if shot_observed else None, activity if activity_observed else None),
    }


def _validated_contexts(contexts: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    if isinstance(contexts, (str, bytes, Mapping)):
        raise ValueError("selected_contexts must be a non-empty iterable of mappings")
    try:
        records = list(contexts)
    except TypeError as error:
        raise ValueError("selected_contexts must be a non-empty iterable of mappings") from error
    if not records or not all(isinstance(record, Mapping) for record in records):
        raise ValueError("selected_contexts must be a non-empty iterable of mappings")

    normalized: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        values: dict[str, Any] = {}
        for field in _CONTEXT_FIELDS:
            value = record.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"selected_contexts[{index}].{field} must be a positive integer")
            values[field] = value
        season = record.get("season")
        if not isinstance(season, str) or not re.fullmatch(r"\d{4}/\d{4}", season):
            raise ValueError(f"selected_contexts[{index}].season must be a YYYY/YYYY string")
        values["season"] = season
        values["shotKey"] = f"{values['fotmobPlayerId']}:{values['tournamentId']}:{values['seasonId']}"
        values["activityKey"] = f"{values['sportsapiPlayerId']}:{values['tournamentId']}:{values['seasonId']}"
        normalized.append(values)

    for key_name in ("shotKey", "activityKey"):
        keys = [context[key_name] for context in normalized]
        if len(keys) != len(set(keys)):
            raise ValueError(f"selected_contexts contain duplicate {key_name} aliases")
    if len({context["fotmobPlayerId"] for context in normalized}) != 1:
        raise ValueError("selected_contexts must select one fotmobPlayerId")
    if len({context["season"] for context in normalized}) != 1:
        raise ValueError("selected_contexts must select one canonical season")
    return sorted(normalized, key=lambda context: (context["shotKey"], context["activityKey"]))


def _validate_snapshot_mapping(snapshots: Mapping[str, Any], label: str) -> None:
    if not isinstance(snapshots, Mapping) or any(not isinstance(key, str) for key in snapshots):
        raise ValueError(f"{label} must be a mapping with string keys")


def _coverage(expected: list[str], observed: list[str]) -> dict[str, Any]:
    missing = sorted(set(expected) - set(observed))
    state = "observed" if not missing else "partial" if observed else "unavailable"
    return {
        "state": state,
        "expectedKeys": list(expected),
        "observedKeys": list(observed),
        "missingKeys": missing,
    }


def _normalized_shot_snapshot(value: Any, key: str) -> list[dict[str, Any]]:
    rows = _record_list(value, f"shot_snapshots[{key!r}]")
    normalized: list[dict[str, Any]] = []
    for index, record in enumerate(rows):
        _require(record, ("x", "y", "outcome", "xg", "xgot"), f"shot_snapshots[{key!r}][{index}]")
        # Deliberately project the canonical shot fields: trajectory/event extras
        # remain in the caller-owned input and cannot affect aggregation.
        normalized.append({field: record[field] for field in ("x", "y", "outcome", "xg", "xgot")})
    return normalized


def _normalized_activity_snapshot(value: Any, key: str) -> list[dict[str, Any]]:
    if not isinstance(value, Mapping) or value.get("success") is not True:
        raise ValueError(f"activity_snapshots[{key!r}] must be a successful payload")
    data = value.get("data")
    if not isinstance(data, Mapping):
        raise ValueError(f"activity_snapshots[{key!r}].data must be a mapping")
    rows = _record_list(data.get("points"), f"activity_snapshots[{key!r}].data.points")
    normalized: list[dict[str, Any]] = []
    for index, record in enumerate(rows):
        _require(record, ("x", "y", "count"), f"activity_snapshots[{key!r}].data.points[{index}]")
        normalized.append({field: record[field] for field in ("x", "y", "count")})
    return normalized


def _record_list(value: Any, label: str) -> list[Mapping[str, Any]]:
    if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Sequence):
        raise ValueError(f"{label} must be a list of records")
    if not all(isinstance(record, Mapping) for record in value):
        raise ValueError(f"{label} must contain mappings")
    return list(value)


def _require(record: Mapping[str, Any], fields: tuple[str, ...], label: str) -> None:
    missing = [field for field in fields if field not in record]
    if missing:
        raise ValueError(f"{label} missing required keys: {', '.join(missing)}")
