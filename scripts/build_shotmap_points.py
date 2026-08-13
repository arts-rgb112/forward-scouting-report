"""Build static FotMob shot coordinates keyed to tactical heatmap sessions.

The Streamlit detail route must remain network-free.  This batch process is
therefore the only place where raw shot events are fetched; the app and API
read the committed JSON snapshot.
"""

from __future__ import annotations

import argparse
import csv
import json
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


def _number(value: object) -> float | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def shot_outcome(shot: dict[str, Any]) -> str:
    event = str(shot.get("eventType") or shot.get("event_type") or "").casefold()
    if shot.get("isGoal") is True or event == "goal":
        return "goal"
    if any(token in event for token in ("save", "saved", "on target", "post")):
        return "on_target"
    if "block" in event:
        return "blocked"
    return "off_target"


def normalize_shotmap(payload: object) -> list[dict[str, object]]:
    shots: list[dict[str, object]] = []
    if not isinstance(payload, list):
        return shots
    for shot in payload:
        if not isinstance(shot, dict) or shot.get("isOwnGoal"):
            continue
        x, y = _number(shot.get("x")), _number(shot.get("y"))
        if x is None or y is None or not (0.0 <= x <= 100.0 and 0.0 <= y <= 100.0):
            continue
        shots.append({
            "x": round(x, 3), "y": round(y, 3), "outcome": shot_outcome(shot),
            "xg": round(value, 4) if (value := _number(shot.get("expectedGoals"))) is not None else None,
            "xgot": round(value, 4) if (value := _number(shot.get("expectedGoalsOnTarget"))) is not None else None,
        })
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


def build(
    season: str | None = None, limit: int | None = None, player_id: str | None = None,
) -> tuple[int, int]:
    existing: dict[str, list[dict[str, object]]] = {}
    if OUTPUT_PATH.exists():
        try:
            raw = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                existing = raw
        except ValueError:
            pass
    completed = 0
    targets = list(_targets(season, player_id).items())
    if limit is not None:
        targets = targets[:limit]
    for index, ((player_id, season_name), rows) in enumerate(targets):
        if rows and all(str(row["heatmap_key"]) in existing for row in rows):
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
            existing[str(match["heatmap_key"])] = normalize_shotmap(shotmap)
            completed += 1
        if completed and completed % 25 == 0:
            OUTPUT_PATH.write_text(json.dumps(existing, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    OUTPUT_PATH.write_text(json.dumps(existing, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(targets), completed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--player-id")
    args = parser.parse_args()
    targets, completed = build(args.season_name, args.limit, args.player_id)
    print(f"Shotmap snapshot: {completed}/{targets} player-season targets updated")


if __name__ == "__main__":
    main()
