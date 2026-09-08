"""Pure source-native pitch-event bundle construction.

The caller supplies saved SportsAPI match-shotmap payloads for explicit player
and context mappings.  This module neither reads files nor joins FotMob events.
Raw provider coordinates are retained for audit.  The only projection here is
the reviewed provider draw-plane display convention; it never claims metres,
physical height, or a real terminal ball position.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
import hashlib
import json
import math
from typing import Any

from api_server.native_body_part_sources import aggregate_mapped_native_body_parts


_DISPLAY_TRANSFORM = "sportsapi-draw-pitch-display-v1"


def build_native_event_bundle(
    selected_sources: list[tuple[Mapping[str, Any], Mapping[str, Any], Mapping[int, Any]]],
    *,
    include_penalties: bool = True,
) -> dict[str, Any]:
    """Build deterministic same-provider events from explicit saved sources.

    ``aggregate_mapped_native_body_parts`` is the sole eligibility authority:
    match/context/player/PK/metric validation and source coverage are inherited
    from it. Coordinates never determine eligibility; the reviewed draw-plane
    projection below cannot silently remove a recorded shot.
    """
    if not isinstance(selected_sources, list) or not isinstance(include_penalties, bool):
        raise ValueError("selected_sources must be a list and include_penalties a boolean")

    prepared = []
    mapping_keys: set[str] = set()
    for item in selected_sources:
        if not isinstance(item, tuple) or len(item) != 3:
            raise ValueError("each selected source must be (mapping_row, manifest, raw_snapshots)")
        mapping, manifest, snapshots = item
        if not isinstance(mapping, Mapping) or (manifest is not None and not isinstance(manifest, Mapping)) or not isinstance(snapshots, Mapping):
            raise ValueError("native source mapping/snapshots and optional manifest have invalid types")
        mapping_key = mapping.get("heatmap_key")
        if not isinstance(mapping_key, str) or not mapping_key or mapping_key in mapping_keys:
            raise ValueError("selected source mapping keys must be unique nonempty strings")
        mapping_keys.add(mapping_key)
        prepared.append((mapping_key, mapping, manifest, snapshots))

    prepared.sort(key=lambda item: item[0])
    revision = _snapshot_revision(prepared)
    sources = []
    events = []
    identities: set[tuple[int, int, int]] = set()
    for _mapping_key, mapping, manifest, snapshots in prepared:
        if manifest is None:
            if snapshots:
                raise ValueError("missing native manifest cannot accept unscoped raw snapshots")
            sources.append(_unavailable_missing_manifest_source(mapping))
            continue
        result = aggregate_mapped_native_body_parts(
            mapping, manifest, snapshots, include_penalties=include_penalties,
        )
        source, aggregate = result["source"], result["aggregate"]
        records = aggregate["qualityRecords"]
        wanted_coordinates = {(record["matchId"], record["eventId"], record["playerId"]) for record in records}
        coordinate_index = _coordinate_index(snapshots, source["sourcePlayerId"], wanted_coordinates)
        source_events = []
        for record in records:
            identity = (record["playerId"], record["matchId"], record["eventId"])
            if identity in identities:
                raise ValueError("duplicate native event identity across selected sources")
            identities.add(identity)
            raw_event = coordinate_index.get((record["matchId"], record["eventId"], record["playerId"]))
            if raw_event is None:
                raise ValueError("validated native event has no same-event raw payload")
            source_events.append(_event(source, record, raw_event))
        source_events.sort(key=_event_sort_key)
        events.extend(source_events)
        sources.append({
            "source": deepcopy(source),
            "coverage": deepcopy(aggregate["coverage"]),
            "counts": {
                "admittedShots": aggregate["admittedShotCount"],
                "excludedPenaltyShots": aggregate["excludedPenaltyShots"],
                "excludedPenaltyGoals": aggregate["excludedPenaltyGoals"],
                "shots": aggregate["filteredShotCount"],
                "goals": aggregate["filteredGoalCount"],
            },
            "parts": deepcopy(aggregate["categories"]),
            "quality": _quality(records, observed=aggregate["filteredShotCount"] is not None),
        })
    events.sort(key=_event_sort_key)
    completeness = (
        "unavailable" if not sources or all(source["coverage"]["state"] == "unavailable" for source in sources)
        else "complete" if all(source["coverage"]["state"] == "complete" for source in sources)
        else "partial"
    )
    return {
        "schemaVersion": "sportsapi-native-pitch-events-internal-v1",
        "provider": "sportsapi",
        "includePenalties": include_penalties,
        "snapshotRevision": revision,
        "completeness": completeness,
        "sources": sources,
        "events": events,
    }


def _snapshot_revision(prepared: list[tuple[str, Mapping[str, Any], Mapping[str, Any] | None, Mapping[int, Any]]]) -> str:
    value = {
        "sources": [
            {"mapping": mapping, "manifest": manifest, "snapshots": snapshots}
            for _key, mapping, manifest, snapshots in prepared
        ],
    }
    if _contains_nonfinite(value):
        raise ValueError("native source snapshot contains nonfinite numeric value")
    try:
        canonical = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise ValueError("native source snapshot cannot form a canonical revision") from error
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _contains_nonfinite(value: Any) -> bool:
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, Mapping):
        return any(_contains_nonfinite(key) or _contains_nonfinite(item) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_nonfinite(item) for item in value)
    return False


def _unavailable_missing_manifest_source(mapping: Mapping[str, Any]) -> dict[str, Any]:
    fotmob = _native_id(mapping.get("fotmob_player_id"), "fotmob_player_id")
    player = _native_id(mapping.get("sportsapi_player_id"), "sportsapi_player_id")
    tournament = _native_id(mapping.get("tournament_id"), "tournament_id")
    season_id = _native_id(mapping.get("season_id"), "season_id")
    season, competition, mapping_key = mapping.get("season_name"), mapping.get("competition_name"), mapping.get("heatmap_key")
    if not isinstance(season, str) or not isinstance(competition, str) or not competition.strip() or mapping_key != f"{fotmob}:{tournament}:{season_id}":
        raise ValueError("missing-manifest source mapping is invalid")
    unavailable_quality = {"xg": None, "xgot": None, "delta": None, "eligible": None, "state": "unavailable"}
    return {
        "source": {"provider": "sportsapi", "fotmobPlayerId": fotmob, "sourcePlayerId": player,
                   "tournamentId": tournament, "seasonId": season_id, "season": season,
                   "competition": competition, "mappingKey": mapping_key},
        "coverage": {"state": "unavailable", "expectedMatchIds": [], "validMatchIds": [],
                     "missingMatchIds": [], "invalidMatchIds": [], "invalidReasons": {}},
        "counts": {"admittedShots": None, "excludedPenaltyShots": None, "excludedPenaltyGoals": None,
                   "shots": None, "goals": None},
        "parts": {part: {"shots": None, "goals": None, "quality": dict(unavailable_quality)}
                  for part in ("head", "leftFoot", "rightFoot", "other", "unknown")},
        "quality": unavailable_quality,
    }


def _native_id(value: Any, label: str) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    if isinstance(value, str) and value.isdecimal() and not value.startswith("0") and int(value) > 0:
        return int(value)
    raise ValueError(f"{label} must be a positive native ID")


def _coordinate_index(
    snapshots: Mapping[int, Any], player_id: int, wanted: set[tuple[int, int, int]],
) -> dict[tuple[int, int, int], Mapping[str, Any]]:
    index: dict[tuple[int, int, int], Mapping[str, Any]] = {}
    for match_id, payload in snapshots.items():
        if not isinstance(payload, Mapping):
            continue
        data = payload.get("data")
        shotmap = data.get("shotmap") if isinstance(data, Mapping) else None
        if not isinstance(shotmap, list):
            continue
        for event in shotmap:
            player = event.get("player") if isinstance(event, Mapping) else None
            if not isinstance(player, Mapping) or player.get("id") != player_id:
                continue
            event_id = event.get("id")
            if isinstance(event_id, bool) or not isinstance(event_id, int) or event_id <= 0:
                continue
            identity = (match_id, event_id, player_id)
            if identity not in wanted:
                continue
            if identity in index:
                raise ValueError("duplicate native coordinate identity in raw snapshot")
            index[identity] = event
    return index


def _event(source: Mapping[str, Any], record: Mapping[str, Any], raw_event: Mapping[str, Any]) -> dict[str, Any]:
    raw_coordinates = {
        "playerCoordinates": deepcopy(raw_event.get("playerCoordinates")),
        "draw": deepcopy(raw_event.get("draw")),
        "goalMouthCoordinates": deepcopy(raw_event.get("goalMouthCoordinates")),
        "blockCoordinates": deepcopy(raw_event.get("blockCoordinates")),
    }
    plot = _origin_projection(raw_coordinates)
    return {
        "identity": {
            "mappingKey": source["mappingKey"],
            "sourcePlayerId": record["playerId"],
            "matchId": record["matchId"],
            "shotId": record["eventId"],
        },
        "bodyPart": record["bodyPart"],
        "shotType": record["shotType"],
        # Deliberately preserves the native provider taxonomy; a UI adapter may
        # map it only under its separately reviewed presentation contract.
        "outcome": record["shotType"],
        "isPenalty": record["isPenalty"],
        "xg": record["xg"],
        "xgot": record["xgot"],
        "rawCoordinates": raw_coordinates,
        "plot": plot,
        # A provider draw-plane target, not a claimed physical terminal point.
        "goalPlaneProjection": _goal_plane_projection(raw_coordinates),
        "blockProjection": _block_projection(raw_coordinates, record["shotType"]),
    }


def _origin_projection(raw_coordinates: Mapping[str, Any]) -> dict[str, Any]:
    player = raw_coordinates.get("playerCoordinates")
    draw = raw_coordinates.get("draw")
    if not isinstance(player, Mapping) or not isinstance(draw, Mapping):
        return _unlocated("native_coordinates_invalid")
    start = draw.get("start")
    if not isinstance(start, Mapping):
        return _unlocated("native_coordinates_invalid")
    values = (player.get("x"), player.get("y"), start.get("x"), start.get("y"))
    if not all(_display_number(value) for value in values):
        return _unlocated("native_coordinates_invalid")
    if not (start["x"] == player["y"] and start["y"] == player["x"]):
        return _unlocated("native_coordinate_mismatch")
    # ``draw`` is a goal-up image frame: rotate it into attack-relative pitch
    # space, then invert its downward image axis.  The resulting y keeps the
    # canonical contract's player-right (0) -> player-left (100) direction.
    return {"state": "projected", "x": round(100.0 - start["y"], 6), "y": round(100.0 - start["x"], 6),
            "reason": None, "transformVersion": _DISPLAY_TRANSFORM}


def _goal_plane_projection(raw_coordinates: Mapping[str, Any]) -> dict[str, Any]:
    player = raw_coordinates.get("playerCoordinates")
    draw = raw_coordinates.get("draw")
    mouth = raw_coordinates.get("goalMouthCoordinates")
    end = draw.get("end") if isinstance(draw, Mapping) else None
    if not isinstance(player, Mapping) or not isinstance(mouth, Mapping) or not isinstance(end, Mapping):
        return {"state": "unavailable", "x": None, "y": None, "reason": "native_goal_plane_invalid", "transformVersion": _DISPLAY_TRANSFORM}
    values = (end.get("x"), end.get("y"), mouth.get("y"), player.get("z"))
    if not all(_display_number(value) for value in values):
        return {"state": "unavailable", "x": None, "y": None, "reason": "native_goal_plane_invalid", "transformVersion": _DISPLAY_TRANSFORM}
    if end["x"] != 100 - mouth["y"] or end["y"] != player["z"]:
        return {"state": "unavailable", "x": None, "y": None, "reason": "native_goal_plane_mismatch", "transformVersion": _DISPLAY_TRANSFORM}
    return {"state": "available", "x": 100.0, "y": round(100.0 - end["x"], 6), "reason": None,
            "transformVersion": _DISPLAY_TRANSFORM}


def _block_projection(raw_coordinates: Mapping[str, Any], shot_type: str) -> dict[str, Any]:
    if shot_type != "block":
        return {"state": "unavailable", "x": None, "y": None, "reason": "not_block_shot", "transformVersion": _DISPLAY_TRANSFORM}
    draw = raw_coordinates.get("draw")
    block = draw.get("block") if isinstance(draw, Mapping) else None
    if not isinstance(block, Mapping) or not _display_number(block.get("x")) or not _display_number(block.get("y")):
        return {"state": "unavailable", "x": None, "y": None, "reason": "native_block_coordinates_invalid", "transformVersion": _DISPLAY_TRANSFORM}
    return {"state": "available", "x": round(100.0 - block["y"], 6), "y": round(100.0 - block["x"], 6), "reason": None,
            "transformVersion": _DISPLAY_TRANSFORM}


def _display_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0.0 <= value <= 100.0


def _unlocated(reason: str) -> dict[str, Any]:
    return {"state": "unlocated", "x": None, "y": None, "reason": reason, "transformVersion": _DISPLAY_TRANSFORM}


def _event_sort_key(event: Mapping[str, Any]) -> tuple[str, int, int]:
    identity = event["identity"]
    return identity["mappingKey"], identity["matchId"], identity["shotId"]


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
