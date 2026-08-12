"""Offline StatsBomb Open Data adapter for spatially weighted duel PoCs.

The command accepts either one StatsBomb event JSON or a directory containing
match event JSON files. It never downloads data. Raw StatsBomb coordinates are
120 x 80 and already oriented for the action-executing team to attack from
left to right. The lateral axis is inverted after scaling because StatsBomb's
``y=0`` side is the opposite of the project's Lane 1 convention.

Official Open Data semantics used here:

* ``Duel`` / ``Tackle`` uses ``duel.outcome`` for ground wins and losses.
* ``Duel`` / ``Aerial Lost`` is the losing player's aerial event.
* aerial winners are paired ``Pass``, ``Shot``, ``Clearance`` or ``Miscontrol``
  events whose type-specific object contains ``aerial_won: true``.

Unknown outcomes, missing locations and incomplete player attribution are
counted in the audit output and never guessed.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from spatial_duels import (  # noqa: E402
    COORDINATE_SYSTEM, GRID_VERSION, DuelEvent, calculate_spatial_duels,
)


GROUND_WIN_OUTCOMES = frozenset({"Won", "Success", "Success In Play", "Success Out"})
GROUND_LOSS_OUTCOMES = frozenset({"Lost In Play", "Lost Out"})
AERIAL_WIN_EVENT_TYPES = frozenset({"Pass", "Shot", "Clearance", "Miscontrol"})
RED_CARDS = frozenset({"Red Card", "Second Yellow"})


@dataclass(frozen=True)
class ClassifiedDuel:
    player_id: str
    player_name: str
    duel: DuelEvent


@dataclass
class PlayerAggregate:
    player_id: str
    player_name: str
    minutes: float = 0.0
    events: list[DuelEvent] = field(default_factory=list)


def _object_name(value: object) -> str:
    return str(value.get("name", "")).strip() if isinstance(value, dict) else ""


def normalize_statsbomb_location(location: object) -> tuple[float, float]:
    """Scale 120 x 80 to M.E.S.S.I. 0..100 and preserve its lane labels."""
    if not isinstance(location, (list, tuple)) or len(location) < 2:
        raise ValueError("missing_location")
    try:
        x, y = float(location[0]), float(location[1])
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid_location") from exc
    if not (0.0 <= x <= 120.0 and 0.0 <= y <= 80.0):
        raise ValueError("location_out_of_bounds")
    return round(x / 120.0 * 100.0, 6), round(100.0 - y / 80.0 * 100.0, 6)


def classify_statsbomb_duel(event: object) -> tuple[ClassifiedDuel | None, str | None]:
    """Translate one unflattened StatsBomb event, preserving uncertainty."""
    if not isinstance(event, dict):
        return None, None
    event_type = _object_name(event.get("type"))
    payload: dict[str, Any] | None = None
    duel_type = ""
    outcome = ""

    if event_type == "Duel":
        value = event.get("duel")
        if not isinstance(value, dict):
            return None, "missing_duel_payload"
        payload = value
        duel_type = _object_name(payload.get("type"))
        outcome = _object_name(payload.get("outcome"))
        if duel_type == "Aerial Lost":
            classified_type, won = "aerial", False
        elif duel_type == "Tackle":
            if outcome in GROUND_WIN_OUTCOMES:
                classified_type, won = "ground", True
            elif outcome in GROUND_LOSS_OUTCOMES:
                classified_type, won = "ground", False
            else:
                return None, "ambiguous_ground_outcome"
        else:
            return None, "unsupported_duel_type"
    elif event_type in AERIAL_WIN_EVENT_TYPES:
        key = event_type.lower()
        value = event.get(key)
        if not isinstance(value, dict) or "aerial_won" not in value:
            return None, None
        marker = value.get("aerial_won")
        if marker is not True:
            return None, "ambiguous_aerial_marker"
        classified_type, won = "aerial", True
    else:
        return None, None

    player = event.get("player")
    if not isinstance(player, dict) or player.get("id") in (None, ""):
        return None, "missing_player"
    player_id = str(player["id"])
    player_name = str(player.get("name") or player_id)
    try:
        x, y = normalize_statsbomb_location(event.get("location"))
    except ValueError as exc:
        return None, str(exc)
    return ClassifiedDuel(player_id, player_name, DuelEvent(classified_type, won, x, y)), None


def _event_time(event: dict[str, Any], match_minutes: float) -> float:
    try:
        value = float(event.get("minute", 0)) + float(event.get("second", 0)) / 60.0
    except (TypeError, ValueError):
        value = 0.0
    return max(0.0, min(match_minutes, value))


def _match_minutes(events: list[dict[str, Any]]) -> float:
    periods = {event.get("period") for event in events}
    return 120.0 if 3 in periods or 4 in periods else 90.0


def participation_minutes(events: list[dict[str, Any]]) -> tuple[dict[str, float], dict[str, str]]:
    """Infer regulation playing time from Starting XI and player movement events."""
    match_minutes = _match_minutes(events)
    active_since: dict[str, float] = {}
    elapsed: defaultdict[str, float] = defaultdict(float)
    names: dict[str, str] = {}

    def activate(player: object, at: float) -> None:
        if not isinstance(player, dict) or player.get("id") in (None, ""):
            return
        player_id = str(player["id"])
        names[player_id] = str(player.get("name") or player_id)
        active_since.setdefault(player_id, at)

    def deactivate(player: object, at: float) -> None:
        if not isinstance(player, dict) or player.get("id") in (None, ""):
            return
        player_id = str(player["id"])
        names[player_id] = str(player.get("name") or player_id)
        start = active_since.pop(player_id, None)
        if start is not None:
            elapsed[player_id] += max(0.0, at - start)

    for event in events:
        if _object_name(event.get("type")) != "Starting XI":
            continue
        tactics = event.get("tactics")
        lineup = tactics.get("lineup") if isinstance(tactics, dict) else None
        if not isinstance(lineup, list):
            continue
        for entry in lineup:
            if isinstance(entry, dict):
                activate(entry.get("player"), 0.0)

    ordered = sorted(events, key=lambda event: (int(event.get("period") or 0), _event_time(event, match_minutes), int(event.get("index") or 0)))
    for event in ordered:
        event_type = _object_name(event.get("type"))
        at = _event_time(event, match_minutes)
        player = event.get("player")
        if isinstance(player, dict) and player.get("id") not in (None, ""):
            names[str(player["id"])] = str(player.get("name") or player["id"])
        if event_type == "Substitution":
            deactivate(player, at)
            substitution = event.get("substitution")
            if isinstance(substitution, dict):
                activate(substitution.get("replacement"), at)
        elif event_type == "Player Off":
            deactivate(player, at)
        elif event_type == "Player On":
            activate(player, at)
        elif event_type in {"Foul Committed", "Bad Behaviour"}:
            key = "foul_committed" if event_type == "Foul Committed" else "bad_behaviour"
            detail = event.get(key)
            card = _object_name(detail.get("card")) if isinstance(detail, dict) else ""
            if card in RED_CARDS:
                deactivate(player, at)

    for player_id, start in active_since.items():
        elapsed[player_id] += max(0.0, match_minutes - start)
    return dict(elapsed), names


def load_event_matches(input_path: Path) -> list[tuple[str, list[dict[str, Any]]]]:
    """Load one match JSON or an offline competition directory."""
    paths = sorted(input_path.rglob("*.json")) if input_path.is_dir() else [input_path]
    if not paths or any(not path.is_file() for path in paths):
        raise ValueError("input must be an event JSON file or a directory containing JSON files")
    matches: list[tuple[str, list[dict[str, Any]]]] = []
    for path in paths:
        raw = json.loads(path.read_text(encoding="utf-8"))
        events = raw.get("events") if isinstance(raw, dict) else raw
        if not isinstance(events, list) or not all(isinstance(event, dict) for event in events):
            raise ValueError(f"{path} is not a StatsBomb event JSON")
        grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for event in events:
            match_id = str(event.get("match_id") or path.stem)
            grouped[match_id].append(event)
        matches.extend(sorted(grouped.items()))
    return matches


def _ranks(values: dict[str, float]) -> dict[str, int]:
    return {player_id: 1 + sum(candidate > value for candidate in values.values()) for player_id, value in values.items()}


def build_poc(input_path: Path, minimum_minutes: float = 1.0) -> dict[str, object]:
    aggregates: dict[str, PlayerAggregate] = {}
    audit: Counter[str] = Counter()
    match_count = 0
    match_ids: list[str] = []

    for match_id, events in load_event_matches(input_path):
        match_count += 1
        match_ids.append(match_id)
        minutes, names = participation_minutes(events)
        for player_id, value in minutes.items():
            aggregate = aggregates.setdefault(player_id, PlayerAggregate(player_id, names.get(player_id, player_id)))
            aggregate.minutes += value
            aggregate.player_name = names.get(player_id, aggregate.player_name)
        for event in events:
            if event.get("period") == 5:
                audit["excluded_shootout_event"] += 1
                continue
            classified, reason = classify_statsbomb_duel(event)
            if reason:
                audit[f"excluded_{reason}"] += 1
            if classified is None:
                continue
            audit[f"classified_{classified.duel.duel_type}_{'won' if classified.duel.won else 'lost'}"] += 1
            aggregate = aggregates.get(classified.player_id)
            if aggregate is None:
                audit["excluded_missing_minutes"] += 1
                continue
            aggregate.events.append(classified.duel)

    eligible = {
        player_id: aggregate for player_id, aggregate in aggregates.items()
        if aggregate.minutes >= minimum_minutes
    }
    metrics = {
        player_id: calculate_spatial_duels(aggregate.events, aggregate.minutes)
        for player_id, aggregate in eligible.items()
    }
    raw_ground = {player_id: value.ground_wins * 90.0 / value.minutes_played for player_id, value in metrics.items()}
    raw_aerial = {player_id: value.aerial_wins * 90.0 / value.minutes_played for player_id, value in metrics.items()}
    weighted_ground = {player_id: value.ground_weighted_wins_per90 for player_id, value in metrics.items()}
    weighted_aerial = {player_id: value.aerial_weighted_wins_per90 for player_id, value in metrics.items()}
    raw_total = {player_id: raw_ground[player_id] + raw_aerial[player_id] for player_id in metrics}
    weighted_total = {player_id: weighted_ground[player_id] + weighted_aerial[player_id] for player_id in metrics}
    rank_sets = {
        "existingGroundRank": _ranks(raw_ground), "newGroundRank": _ranks(weighted_ground),
        "existingAerialRank": _ranks(raw_aerial), "newAerialRank": _ranks(weighted_aerial),
        "existingOverallRank": _ranks(raw_total), "newOverallRank": _ranks(weighted_total),
    }

    rows: list[dict[str, object]] = []
    for player_id, value in metrics.items():
        aggregate = eligible[player_id]
        row: dict[str, object] = {
            "playerId": player_id, "playerName": aggregate.player_name,
            "minutes": round(aggregate.minutes, 2),
            "groundRawWins": value.ground_wins, "aerialRawWins": value.aerial_wins,
            "groundRawWinsPer90": round(raw_ground[player_id], 4),
            "aerialRawWinsPer90": round(raw_aerial[player_id], 4),
            "groundWeightedWins": value.ground_weighted_wins,
            "aerialWeightedWins": value.aerial_weighted_wins,
            "groundWeightedWinsPer90": value.ground_weighted_wins_per90,
            "aerialWeightedWinsPer90": value.aerial_weighted_wins_per90,
            "groundBoxDuelsWon": value.ground_box_wins,
            "aerialBoxDuelsWon": value.aerial_box_wins,
            "boxDuelsWon": value.box_duels_won,
            "groundWinsByCell": value.ground_wins_by_cell,
            "aerialWinsByCell": value.aerial_wins_by_cell,
        }
        for key, ranks in rank_sets.items():
            row[key] = ranks[player_id]
        row["groundRankDelta"] = int(row["existingGroundRank"]) - int(row["newGroundRank"])
        row["aerialRankDelta"] = int(row["existingAerialRank"]) - int(row["newAerialRank"])
        row["overallRankDelta"] = int(row["existingOverallRank"]) - int(row["newOverallRank"])
        rows.append(row)
    rows.sort(key=lambda row: (int(row["newOverallRank"]), str(row["playerName"]), str(row["playerId"])))
    return {
        "meta": {
            "source": "StatsBomb Open Data", "gridVersion": GRID_VERSION,
            "coordinateSystem": COORDINATE_SYSTEM, "matchCount": match_count,
            "matchIds": match_ids, "playerCount": len(rows),
            "minimumMinutes": minimum_minutes,
            "rankBasis": "wins-per-90 versus spatially-weighted-wins-per-90",
            "groundMetricSemantics": "StatsBomb Duel/Tackle; not provider-agnostic all-ground-duels",
        },
        "audit": dict(sorted(audit.items())), "players": rows,
    }


def write_outputs(result: dict[str, object], output_prefix: Path) -> tuple[Path, Path]:
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    json_path = output_prefix.with_suffix(".json")
    csv_path = output_prefix.with_suffix(".csv")
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rows = result.get("players")
    player_rows = rows if isinstance(rows, list) else []
    fieldnames = list(player_rows[0]) if player_rows else ["playerId", "playerName"]
    with csv_path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames)
        writer.writeheader()
        for raw_row in player_rows:
            row = dict(raw_row)
            for key in ("groundWinsByCell", "aerialWinsByCell"):
                row[key] = json.dumps(row[key], ensure_ascii=False, separators=(",", ":"))
            writer.writerow(row)
    return csv_path, json_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="StatsBomb match event JSON or offline competition directory")
    parser.add_argument("--output-prefix", type=Path, required=True, help="Output path without .csv/.json suffix")
    parser.add_argument("--minimum-minutes", type=float, default=1.0)
    args = parser.parse_args(argv)
    if args.minimum_minutes <= 0:
        parser.error("--minimum-minutes must be positive")
    result = build_poc(args.input, args.minimum_minutes)
    csv_path, json_path = write_outputs(result, args.output_prefix)
    print(f"Wrote {len(result['players'])} players to {csv_path} and {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
