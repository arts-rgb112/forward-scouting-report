"""Build static FotMob shot coordinates keyed to tactical heatmap sessions.

The Streamlit detail route must remain network-free.  This batch process is
therefore the only place where raw shot events are fetched; the app and API
read the committed JSON snapshot.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fotmob_client import FotMobError, fetch_player_multi_season_data
from tactical_ratio import _same_competition


DATA_DIR = ROOT / "data"
TACTICAL_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
OUTPUT_PATH = DATA_DIR / "tactical_shotmap_points.json"
FOTMOB_PITCH_LENGTH = 105.0
FOTMOB_PITCH_WIDTH = 68.0


def _number(value: object) -> float | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def shot_outcome(shot: dict[str, Any]) -> str:
    event = str(shot.get("eventType") or shot.get("event_type") or "").casefold()
    if shot.get("isGoal") is True or event == "goal":
        return "goal"
    if shot.get("isBlocked") is True or "block" in event:
        return "blocked"
    if shot.get("isOnTarget") is True or any(token in event for token in ("save", "saved", "on target")):
        return "on_target"
    return "off_target"


def shot_trajectory(
    shot: dict[str, Any], outcome: str,
) -> dict[str, object] | None:
    """Return only provider-backed endpoints in the public 0..100 pitch space.

    FotMob shotmaps use a 105 x 68 pitch for shot and block locations.  The
    provider's ``goalCrossedY`` is the lateral goal-line crossing coordinate
    on that same 68-unit width; ``goalCrossedZ`` is height in metres.  A
    blocked shot must use its observed ``blockedX``/``blockedY`` location and
    must never be projected to the goal line.
    """

    if outcome == "blocked":
        blocked_x = _number(shot.get("blockedX"))
        blocked_y = _number(shot.get("blockedY"))
        if (
            blocked_x is None or blocked_y is None
            or not (0.0 <= blocked_x <= FOTMOB_PITCH_LENGTH)
            or not (0.0 <= blocked_y <= FOTMOB_PITCH_WIDTH)
        ):
            return None
        return {
            "schemaVersion": "shotmap-trajectory-v1",
            "endpointKind": "blocked",
            "endX": round(blocked_x / FOTMOB_PITCH_LENGTH * 100.0, 3),
            "endY": round(blocked_y / FOTMOB_PITCH_WIDTH * 100.0, 3),
            "endZMeters": None,
            "source": "fotmob",
        }

    crossed_y = _number(shot.get("goalCrossedY"))
    if crossed_y is None or not (0.0 <= crossed_y <= FOTMOB_PITCH_WIDTH):
        return None
    crossed_z = _number(shot.get("goalCrossedZ"))
    if crossed_z is not None and crossed_z < 0.0:
        crossed_z = None
    return {
        "schemaVersion": "shotmap-trajectory-v1",
        "endpointKind": "goal_mouth",
        "endX": 100.0,
        "endY": round(crossed_y / FOTMOB_PITCH_WIDTH * 100.0, 3),
        "endZMeters": round(crossed_z, 3) if crossed_z is not None else None,
        "source": "fotmob",
    }


def normalize_shotmap(payload: object) -> list[dict[str, object]]:
    shots: list[dict[str, object]] = []
    if not isinstance(payload, list):
        return shots
    for shot in payload:
        if not isinstance(shot, dict) or shot.get("isOwnGoal"):
            continue
        source_x, source_y = _number(shot.get("x")), _number(shot.get("y"))
        if (
            source_x is None or source_y is None
            or not (0.0 <= source_x <= FOTMOB_PITCH_LENGTH)
            or not (0.0 <= source_y <= FOTMOB_PITCH_WIDTH)
        ):
            continue
        # FotMob shotmaps use a 105 x 68 pitch. Activity heatmaps and the
        # supplied positional pitch use 0..100 on each axis.
        x = source_x / FOTMOB_PITCH_LENGTH * 100.0
        y = source_y / FOTMOB_PITCH_WIDTH * 100.0
        outcome = shot_outcome(shot)
        normalized: dict[str, object] = {
            "x": round(x, 3), "y": round(y, 3), "outcome": outcome,
            "xg": round(value, 4) if (value := _number(shot.get("expectedGoals"))) is not None else None,
            "xgot": round(value, 4) if (value := _number(shot.get("expectedGoalsOnTarget"))) is not None else None,
        }
        if (trajectory := shot_trajectory(shot, outcome)) is not None:
            normalized["trajectory"] = trajectory
        shots.append(normalized)
    return shots


def _targets(
    season: str | None, player_id: str | None = None,
) -> dict[tuple[str, str], list[dict[str, str]]]:
    with TACTICAL_PATH.open(encoding="utf-8", newline="") as source:
        rows = [row for row in csv.DictReader(source) if row.get("heatmap_key")]
    grouped: dict[tuple[str, str], list[dict[str, str]]] = {}
    for row in rows:
        if season and row.get("season_name") != season:
            continue
        if player_id and str(row.get("fotmob_player_id")) != str(player_id):
            continue
        grouped.setdefault(
            (str(row.get("fotmob_player_id")), str(row.get("season_name"))), []
        ).append(row)
    return grouped


def _output_path(season: str | None) -> Path:
    if not season:
        return OUTPUT_PATH
    return DATA_DIR / f"tactical_shotmap_points_{season.replace('/', '_')}.json"


def build(
    season: str | None = None,
    limit: int | None = None,
    player_id: str | None = None,
    refresh_existing: bool = False,
) -> tuple[int, int]:
    output_path = _output_path(season)
    existing: dict[str, list[dict[str, object]]] = {}
    if output_path.exists():
        try:
            raw = json.loads(output_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                existing = raw
        except ValueError:
            pass
    completed = 0
    preserved_invalid_sources = 0
    targets = list(_targets(season, player_id).items())
    if limit is not None:
        targets = targets[:limit]
    for index, ((player_id, season_name), rows) in enumerate(targets):
        if (
            not refresh_existing
            and rows
            and all(str(row["heatmap_key"]) in existing for row in rows)
        ):
            continue
        if index:
            time.sleep(1.2)
        try:
            payload = fetch_player_multi_season_data(player_id, target_season=season_name)
        except FotMobError:
            continue
        for record in payload.get("season_records", []):
            if not isinstance(record, dict):
                continue
            match = next((
                row for row in rows
                if _same_competition(str(row.get("competition_name")), str(record.get("league_name")))
            ), None)
            if match is None:
                continue
            stats = record.get("stats")
            shotmap = stats.get("shotmap") if isinstance(stats, dict) else None
            if not isinstance(shotmap, list):
                # Missing/malformed source data is not evidence of a zero-shot
                # season. Preserve any committed snapshot and surface the
                # anomaly in workflow logs. Only an explicit [] is verified zero.
                preserved_invalid_sources += 1
                print(
                    "Shotmap source unavailable: preserved session "
                    f"{match['heatmap_key']} (expected list, got "
                    f"{type(shotmap).__name__})",
                    file=sys.stderr,
                    flush=True,
                )
                continue
            existing[str(match["heatmap_key"])] = normalize_shotmap(shotmap)
            completed += 1
        if index % 20 == 0 or completed % 25 == 0:
            output_path.write_text(json.dumps(existing, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            print(f"Shotmap progress: {index + 1}/{len(targets)} player-season targets; {completed} sessions updated", flush=True)
    output_path.write_text(json.dumps(existing, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if preserved_invalid_sources:
        print(
            "Shotmap source anomalies: "
            f"{preserved_invalid_sources} session(s) preserved without overwrite",
            file=sys.stderr,
            flush=True,
        )
    return len(targets), completed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--player-id")
    parser.add_argument(
        "--refresh-existing",
        action="store_true",
        help=(
            "Refetch and replace existing player-season sessions. Required for "
            "deterministic trajectory backfills; omitted by normal incremental runs."
        ),
    )
    args = parser.parse_args()
    targets, completed = build(
        args.season_name, args.limit, args.player_id, args.refresh_existing,
    )
    print(f"Shotmap snapshot: {completed}/{targets} player-season targets updated")


if __name__ == "__main__":
    main()
