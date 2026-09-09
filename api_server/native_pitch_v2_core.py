"""Pure v2 native-pitch display derivation.

This is intentionally separate from v1.  It consumes the exact same saved
SportsAPI selection, but only exposes a trajectory terminal point when the
provider supplies the outcome-appropriate coordinate pair.  In particular,
``goalMouthCoordinates`` is not a terminal coordinate for misses or posts.
"""
from __future__ import annotations

from collections.abc import Mapping
import math
from typing import Any

from positional_grid import POSITIONAL_DEPTH_BOUNDARIES, POSITIONAL_LANE_BOUNDARIES

from api_server.native_body_part_contract import PARTS, _public_part, _quality
from api_server.native_pitch_events_core import build_native_event_bundle


BOX_MIN_X = 84.29
BOX_ORDER = ("L4", "L3L", "L3R", "L2")
BOX_META = {
    "L4": ("박스 좌", 63.0, 78.18),
    "L3L": ("박스 중좌", 50.0, 63.0),
    "L3R": ("박스 중우", 37.0, 50.0),
    "L2": ("박스 우", 21.82, 37.0),
}
OUTCOMES = {"goal": "goal", "save": "on_target", "miss": "off_target", "post": "off_target", "block": "blocked"}


def build_native_pitch_v2_bundle(selected_sources: list, *, include_penalties: bool = True) -> dict[str, Any]:
    """Build v2 records and selection aggregates from one saved selection.

    ``build_native_event_bundle`` remains the sole same-event eligibility
    authority.  We deliberately request its full penalty-inclusive bundle
    once, then apply the requested marker/grid filter locally.  The four box
    regions always retain their documented non-penalty denominator.
    """
    full = build_native_event_bundle(selected_sources, include_penalties=True)
    all_events = [_event(row) for row in full["events"]]
    selected = all_events if include_penalties else [row for row in all_events if not row["isPenalty"]]
    observed = full["completeness"] != "unavailable"
    return {
        "snapshotRevision": full["snapshotRevision"],
        "completeness": full["completeness"],
        "events": selected,
        "selectionZones": _selection_zones(selected, all_events, observed, full["completeness"]),
    }


def _event(raw: Mapping[str, Any]) -> dict[str, Any]:
    identity = raw["identity"]
    return {
        "key": f"sportsapi:{identity['mappingKey']}:{identity['sourcePlayerId']}:{identity['matchId']}:{identity['shotId']}",
        "identity": dict(identity),
        "bodyPart": _public_part(raw["bodyPart"]),
        "shotType": raw["shotType"],
        "outcome": OUTCOMES[raw["shotType"]],
        "isPenalty": raw["isPenalty"],
        "xg": raw["xg"],
        "xgot": raw["xgot"],
        "quality": _event_quality(raw),
        "plot": {key: raw["plot"][key] for key in ("state", "x", "y", "reason")},
        "destination": _destination(raw["shotType"], raw["rawCoordinates"]),
    }


def _event_quality(row: Mapping[str, Any]) -> dict[str, Any]:
    if row["xg"] is None or row["xgot"] is None:
        return {"xg": None, "xgot": None, "delta": None, "eligible": 0, "state": "unavailable"}
    xg, xgot = round(row["xg"], 4), round(row["xgot"], 4)
    return {"xg": xg, "xgot": xgot, "delta": round(xgot - xg, 4), "eligible": 1, "state": "complete"}


def _destination(shot_type: str, raw: Mapping[str, Any]) -> dict[str, Any]:
    if shot_type == "goal":
        return _goal_destination(raw)
    if shot_type in {"save", "block"}:
        return _block_destination(raw)
    # A miss/post can contain goal-mouth display data, but it is not evidence
    # that the ball reached that plane.  Do not make a persuasive false path.
    return _unavailable_destination("terminal_coordinate_unavailable_for_outcome")


def _goal_destination(raw: Mapping[str, Any]) -> dict[str, Any]:
    draw, mouth, player = raw.get("draw"), raw.get("goalMouthCoordinates"), raw.get("playerCoordinates")
    end = draw.get("end") if isinstance(draw, Mapping) else None
    if not isinstance(end, Mapping) or not isinstance(mouth, Mapping) or not isinstance(player, Mapping):
        return _unavailable_destination("native_goal_plane_invalid")
    values = (end.get("x"), end.get("y"), mouth.get("y"), player.get("z"))
    if not all(_coordinate(value) for value in values):
        return _unavailable_destination("native_goal_plane_invalid")
    if end["x"] != 100 - mouth["y"] or end["y"] != player["z"]:
        return _unavailable_destination("native_goal_plane_mismatch")
    return {"kind": "goal_plane", "x": 100.0, "y": round(100.0 - end["x"], 6), "observedHeightMeters": None, "reason": None}


def _block_destination(raw: Mapping[str, Any]) -> dict[str, Any]:
    draw, source = raw.get("draw"), raw.get("blockCoordinates")
    block = draw.get("block") if isinstance(draw, Mapping) else None
    if not isinstance(block, Mapping) or not isinstance(source, Mapping):
        return _unavailable_destination("native_block_coordinates_invalid")
    values = (block.get("x"), block.get("y"), source.get("x"), source.get("y"))
    if not all(_coordinate(value) for value in values):
        return _unavailable_destination("native_block_coordinates_invalid")
    # Provider source is pitch x/y whereas draw.block is its rotated image
    # frame.  Require both representations to agree before displaying a path.
    if block["x"] != source["y"] or block["y"] != source["x"]:
        return _unavailable_destination("native_block_coordinate_mismatch")
    return {"kind": "block", "x": round(100.0 - block["y"], 6), "y": round(100.0 - block["x"], 6), "observedHeightMeters": None, "reason": None}


def _unavailable_destination(reason: str) -> dict[str, Any]:
    return {"kind": "unavailable", "x": None, "y": None, "observedHeightMeters": None, "reason": reason}


def _coordinate(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 100


def _selection_zones(selected: list[dict[str, Any]], all_events: list[dict[str, Any]], observed: bool, completeness: str) -> dict[str, Any]:
    grid_groups = {f"depth{depth}_lane{lane}": [] for depth in range(1, 7) for lane in range(1, 6)}
    grid_unlocated = []
    for event in selected:
        cell = _grid_cell(event)
        (grid_unlocated if cell is None else grid_groups[cell]).append(event)
    grid = [_zone_grid(depth, lane, grid_groups[f"depth{depth}_lane{lane}"], len(selected), observed, completeness)
            for depth in range(1, 7) for lane in range(1, 6)]

    # This intentionally uses the complete bundle, never the marker filter.
    # The public box policy stays native non-PK for both PK toggle states.
    non_pk = [event for event in all_events if not event["isPenalty"]]
    box_groups = {key: [] for key in BOX_ORDER}
    box_unlocated, box_outside = [], []
    for event in non_pk:
        key = _box_region(event)
        if key == "unlocated":
            box_unlocated.append(event)
        elif key is None:
            box_outside.append(event)
        else:
            box_groups[key].append(event)
    box = [_zone_box(key, box_groups[key], len(non_pk), observed, completeness) for key in BOX_ORDER]
    return {
        "grid": grid,
        "box": box,
        "gridAccounting": _accounting(selected, [item for group in grid_groups.values() for item in group], grid_unlocated, observed),
        "boxAccounting": _box_accounting(all_events, non_pk, box_groups, box_outside, box_unlocated, observed),
    }


def _grid_cell(event: Mapping[str, Any]) -> str | None:
    plot = event["plot"]
    if plot["state"] != "projected":
        return None
    return f"depth{_segment(plot['x'], POSITIONAL_DEPTH_BOUNDARIES)}_lane{_segment(plot['y'], POSITIONAL_LANE_BOUNDARIES)}"


def _segment(value: float, boundaries: tuple[float, ...]) -> int:
    for index, edge in enumerate(boundaries[1:], 1):
        if value < edge or index == len(boundaries) - 1:
            return index
    raise AssertionError("grid must cover canonical pitch coordinates")


def _box_region(event: Mapping[str, Any]) -> str | None:
    plot = event["plot"]
    if plot["state"] != "projected":
        return "unlocated"
    if plot["x"] < BOX_MIN_X:
        return None
    for key, (_label, low, high) in BOX_META.items():
        if low <= plot["y"] < high:
            return key
    return None


def _zone_grid(depth: int, lane: int, events: list[dict[str, Any]], denominator: int, observed: bool, completeness: str) -> dict[str, Any]:
    x_low, x_high = POSITIONAL_DEPTH_BOUNDARIES[depth - 1], POSITIONAL_DEPTH_BOUNDARIES[depth]
    y_low, y_high = POSITIONAL_LANE_BOUNDARIES[lane - 1], POSITIONAL_LANE_BOUNDARIES[lane]
    return _zone(f"depth{depth}_lane{lane}", f"구역 {depth}-{lane}", x_low, x_high, y_low, y_high,
                 depth == 6, lane == 5, events, denominator, observed, completeness)


def _zone_box(key: str, events: list[dict[str, Any]], denominator: int, observed: bool, completeness: str) -> dict[str, Any]:
    label, y_low, y_high = BOX_META[key]
    return _zone(key, label, BOX_MIN_X, 100.0, y_low, y_high, True, False, events, denominator, observed, completeness)


def _zone(identifier: str, label: str, x_low: float, x_high: float, y_low: float, y_high: float, include_max_x: bool, include_max_y: bool, events: list[dict[str, Any]], denominator: int, observed: bool, completeness: str) -> dict[str, Any]:
    return {
        "id": identifier, "label": label,
        # Every zone is min-inclusive and max-exclusive except an explicit
        # terminal pitch edge.  This mirrors `_segment` / `_box_region`
        # exactly and makes shared boundary clicks deterministic.
        "bounds": {"xMinInclusive": x_low, "xMax": x_high, "includeMaxX": include_max_x,
                   "yMinInclusive": y_low, "yMax": y_high, "includeMaxY": include_max_y},
        **_summary(events if observed else None),
        "parts": _parts(events if observed else None),
        "shootingSharePct": None if not observed or denominator == 0 else round(len(events) / denominator * 100, 4),
        "source": {"state": completeness, "records": len(events) if observed else None},
    }


def _summary(events: list[dict[str, Any]] | None) -> dict[str, Any]:
    if events is None:
        return {"shots": None, "goals": None, "xg": None, "xgEligible": None,
                "quality": {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}}
    xg_values = [event["xg"] for event in events if event["xg"] is not None]
    quality_records = [{"xg": event["xg"], "xgot": event["xgot"]} for event in events]
    return {"shots": len(events), "goals": sum(event["shotType"] == "goal" for event in events),
            "xg": round(sum(xg_values), 4) if xg_values or not events else None, "xgEligible": len(xg_values),
            "quality": _quality(quality_records, observed=True)}


def _parts(events: list[dict[str, Any]] | None) -> dict[str, Any]:
    if events is None:
        return {part: {"shots": None, "goals": None, "quality": {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}} for part in PARTS}
    return {part: _part_summary([event for event in events if event["bodyPart"] == part]) for part in PARTS}


def _part_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    return {"shots": len(events), "goals": sum(event["shotType"] == "goal" for event in events),
            "quality": _quality([{"xg": event["xg"], "xgot": event["xgot"]} for event in events], observed=True)}


def _accounting(source: list[dict[str, Any]], assigned: list[dict[str, Any]], unlocated: list[dict[str, Any]], observed: bool) -> dict[str, Any]:
    if not observed:
        return {"source": None, "assigned": None, "unlocated": None, "reconciles": None}
    return {"source": len(source), "assigned": len(assigned), "unlocated": len(unlocated), "reconciles": len(source) == len(assigned) + len(unlocated)}


def _box_accounting(all_events, non_pk, groups, outside, unlocated, observed: bool) -> dict[str, Any]:
    if not observed:
        return {"source": None, "penalties": None, "denominator": None, "inRegions": None, "outside": None, "unlocated": None, "reconciles": None}
    in_regions = sum((group for group in groups.values()), [])
    penalties = [event for event in all_events if event["isPenalty"]]
    return {"source": len(all_events), "penalties": len(penalties), "denominator": len(non_pk), "inRegions": len(in_regions),
            "outside": len(outside), "unlocated": len(unlocated),
            "reconciles": len(non_pk) == len(in_regions) + len(outside) + len(unlocated)}
