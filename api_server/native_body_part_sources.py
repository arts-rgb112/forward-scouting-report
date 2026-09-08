"""Decode saved SportsAPI records under an explicit existing player mapping.

Caller owns reading CSV/manifest/JSON. No coordinate or FotMob event joins exist.
"""
from collections.abc import Mapping
import re
from typing import Any

from api_server.native_body_part_core import aggregate_native_body_parts


_RECORDED_SITUATIONS = frozenset({"assisted", "corner", "fast-break", "free-kick", "penalty", "regular", "set-piece"})
_RECORDED_BODY_PARTS = frozenset({"head", "left-foot", "right-foot", "other"})


def _id(value: Any, label: str) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value):
        return int(value)
    raise ValueError(f"{label} must be a positive native ID")


def aggregate_mapped_native_body_parts(
    mapping_row: Mapping[str, Any],
    manifest: Mapping[str, Any],
    match_snapshots: Mapping[int, Any],
    *,
    include_penalties: bool = True,
) -> dict[str, Any]:
    """Use the CSV player/context bridge only, never a cross-provider event bridge."""
    if not isinstance(mapping_row, Mapping) or not isinstance(manifest, Mapping):
        raise ValueError("mapping and manifest must be explicit decoded objects")
    fotmob = _id(mapping_row.get("fotmob_player_id"), "fotmob_player_id")
    sportsapi = _id(mapping_row.get("sportsapi_player_id"), "sportsapi_player_id")
    tournament = _id(mapping_row.get("tournament_id"), "tournament_id")
    season_id = _id(mapping_row.get("season_id"), "season_id")
    season = mapping_row.get("season_name")
    competition = mapping_row.get("competition_name")
    if not isinstance(season, str) or not re.fullmatch(r"20\d{2}/20\d{2}", season) or int(season[5:]) != int(season[:4]) + 1:
        raise ValueError("mapping canonical season is invalid")
    if not isinstance(competition, str) or not competition.strip():
        raise ValueError("mapping competition is required")
    if mapping_row.get("heatmap_key") != f"{fotmob}:{tournament}:{season_id}":
        raise ValueError("mapping heatmap key contradicts identity")
    if (_id(manifest.get("tournamentId"), "manifest tournamentId"), _id(manifest.get("seasonId"), "manifest seasonId"), manifest.get("seasonName"), manifest.get("competition")) != (tournament, season_id, season, competition):
        raise ValueError("manifest does not match selected player context")
    expected = manifest.get("matchIds")
    if not isinstance(expected, list) or not expected:
        raise ValueError("manifest requires explicit nonempty matchIds")
    if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in expected) or len(set(expected)) != len(expected):
        raise ValueError("manifest matchIds must be unique positive integers")
    match_count = manifest.get("finishedExactContextMatchCount")
    if isinstance(match_count, bool) or not isinstance(match_count, int) or match_count != len(expected):
        raise ValueError("manifest match count contradicts exact matchIds")
    if not isinstance(match_snapshots, Mapping):
        raise ValueError("snapshots must be keyed by native matchId")
    if any(isinstance(key, bool) or not isinstance(key, int) or key not in expected for key in match_snapshots):
        raise ValueError("snapshot key is outside exact manifest selection")
    normalized = {}
    invalid_reasons = {}
    for match_id, payload in match_snapshots.items():
        try:
            normalized[match_id] = _match_records(match_id, sportsapi, payload)
        except ValueError as error:
            # Present-invalid is not an absent or an observed-empty source.
            normalized[match_id] = None
            invalid_reasons[str(match_id)] = str(error)
    aggregate = aggregate_native_body_parts(sportsapi, expected, normalized, include_penalties=include_penalties)
    aggregate["coverage"]["invalidReasons"].update(invalid_reasons)
    return {
        "source": {"provider": "sportsapi", "fotmobPlayerId": fotmob, "sourcePlayerId": sportsapi,
                   "tournamentId": tournament, "seasonId": season_id, "season": season,
                   "competition": competition, "mappingKey": mapping_row["heatmap_key"]},
        "aggregate": aggregate,
    }


def _match_records(match_id: int, player_id: int, payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, Mapping) or payload.get("success") is not True:
        raise ValueError("native match payload is not successful")
    if isinstance(payload.get("matchId"), bool) or not isinstance(payload.get("matchId"), int) or payload["matchId"] != match_id:
        raise ValueError("native outer matchId mismatch")
    if payload.get("endpoint") != "shotmap":
        raise ValueError("native endpoint is not shotmap")
    data = payload.get("data")
    if not isinstance(data, Mapping) or not isinstance(data.get("shotmap"), list):
        raise ValueError("native shotmap list missing")
    records = []
    for event in data["shotmap"]:
        if not isinstance(event, Mapping) or not isinstance(event.get("player"), Mapping):
            raise ValueError("native event player identity missing")
        native_player = event["player"].get("id")
        if isinstance(native_player, bool) or not isinstance(native_player, int) or native_player <= 0:
            raise ValueError("native event player identity invalid")
        if native_player != player_id:
            continue
        records.append({"matchId": match_id, "playerId": player_id, "eventId": event.get("id"),
                        "bodyPart": _body_part(event), "shotType": event.get("shotType"),
                        "isPenalty": _is_penalty(event), "xg": event.get("xg"), "xgot": event.get("xgot")})
    return records


def _body_part(event: Mapping[str, Any]) -> str:
    value = event.get("bodyPart")
    if value is None:
        return "unknown"
    if not isinstance(value, str):
        raise ValueError("native event bodyPart is malformed")
    return value if value in _RECORDED_BODY_PARTS else "unknown"


def _is_penalty(event: Mapping[str, Any]) -> bool:
    situation = event.get("situation")
    if not isinstance(situation, str) or situation not in _RECORDED_SITUATIONS:
        raise ValueError("native event situation is invalid")
    return situation == "penalty"
