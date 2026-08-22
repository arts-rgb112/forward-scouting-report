"""Build static FotMob shot coordinates keyed to tactical heatmap sessions.

The Streamlit detail route must remain network-free.  This batch process is
therefore the only place where raw shot events are fetched; the app and API
read the committed JSON snapshot.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from dataclasses import dataclass
import json
import math
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fotmob_client import (
    FotMobError,
    configure_request_start_interval,
    fetch_player_multi_season_data,
)
from tactical_ratio import _same_competition


DATA_DIR = ROOT / "data"
TACTICAL_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
OUTPUT_PATH = DATA_DIR / "tactical_shotmap_points.json"
FOTMOB_PITCH_LENGTH = 105.0
FOTMOB_PITCH_WIDTH = 68.0
MIN_REQUEST_INTERVAL_SECONDS = 0.65
CHECKPOINT_TARGET_INTERVAL = 50


class ShotmapBackfillError(RuntimeError):
    pass


@dataclass(frozen=True)
class TargetResult:
    index: int
    updates: tuple[tuple[str, list[dict[str, object]]], ...] = ()
    anomalies: tuple[str, ...] = ()
    fetch_error: str | None = None
    fatal_error: str | None = None


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


def _write_snapshot_atomic(
    output_path: Path,
    snapshot: dict[str, list[dict[str, object]]],
) -> None:
    temporary_path = output_path.with_name(
        f".{output_path.name}.{os.getpid()}.tmp"
    )
    try:
        with temporary_path.open("w", encoding="utf-8") as target:
            json.dump(snapshot, target, ensure_ascii=False, separators=(",", ":"))
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _fetch_target(
    task: tuple[int, tuple[tuple[str, str], list[dict[str, str]]]],
) -> TargetResult:
    index, ((player_id, season_name), rows) = task
    try:
        payload = fetch_player_multi_season_data(
            player_id, target_season=season_name,
        )
    except FotMobError as exc:
        return TargetResult(index=index, fetch_error=str(exc))
    except Exception as exc:  # preserve other workers, then fail after checkpoint
        return TargetResult(
            index=index,
            fatal_error=f"{type(exc).__name__}: {exc}",
        )

    updates: list[tuple[str, list[dict[str, object]]]] = []
    anomalies: list[str] = []
    records = payload.get("season_records", []) if isinstance(payload, dict) else []
    for record in records if isinstance(records, list) else []:
        if not isinstance(record, dict):
            continue
        match = next((
            row for row in rows
            if _same_competition(
                str(row.get("competition_name")),
                str(record.get("league_name")),
            )
        ), None)
        if match is None:
            continue
        stats = record.get("stats")
        shotmap = stats.get("shotmap") if isinstance(stats, dict) else None
        if not isinstance(shotmap, list):
            anomalies.append(
                "Shotmap source unavailable: preserved session "
                f"{match['heatmap_key']} (expected list, got "
                f"{type(shotmap).__name__})"
            )
            continue
        updates.append((
            str(match["heatmap_key"]),
            normalize_shotmap(shotmap),
        ))
    return TargetResult(
        index=index,
        updates=tuple(updates),
        anomalies=tuple(anomalies),
    )


def build(
    season: str | None = None,
    limit: int | None = None,
    player_id: str | None = None,
    refresh_existing: bool = False,
    workers: int = 1,
    request_interval_seconds: float = MIN_REQUEST_INTERVAL_SECONDS,
) -> tuple[int, int]:
    if workers not in {1, 3}:
        raise ValueError("workers must be 1 or 3")
    if request_interval_seconds < MIN_REQUEST_INTERVAL_SECONDS:
        raise ValueError(
            f"request_interval_seconds must be >= {MIN_REQUEST_INTERVAL_SECONDS}"
        )
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
    fetch_errors = 0
    fatal_errors: list[str] = []
    initial_keys = frozenset(existing)
    targets = list(_targets(season, player_id).items())
    if limit is not None:
        targets = targets[:limit]
    pending = [
        (index, target)
        for index, target in enumerate(targets)
        if refresh_existing or not (
            target[1]
            and all(str(row["heatmap_key"]) in existing for row in target[1])
        )
    ]
    previous_interval = configure_request_start_interval(
        request_interval_seconds,
    )
    processed = 0
    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            # executor.map yields input order even when workers finish out of
            # order, so insertion/overwrite order stays deterministic.
            for result in executor.map(_fetch_target, pending):
                processed += 1
                for message in result.anomalies:
                    preserved_invalid_sources += 1
                    print(message, file=sys.stderr, flush=True)
                if result.fetch_error:
                    fetch_errors += 1
                    print(
                        f"Shotmap fetch unavailable at target {result.index + 1}: "
                        f"{result.fetch_error}",
                        file=sys.stderr,
                        flush=True,
                    )
                if result.fatal_error:
                    fatal_errors.append(
                        f"target {result.index + 1}: {result.fatal_error}"
                    )
                for key, points in result.updates:
                    existing[key] = points
                    completed += 1
                if not initial_keys.issubset(existing):
                    raise ShotmapBackfillError(
                        "shotmap refresh removed an existing session key"
                    )
                if processed % CHECKPOINT_TARGET_INTERVAL == 0:
                    _write_snapshot_atomic(output_path, existing)
                    print(
                        f"Shotmap progress: {processed}/{len(pending)} pending "
                        f"targets; {completed} sessions updated",
                        flush=True,
                    )
        _write_snapshot_atomic(output_path, existing)
    finally:
        configure_request_start_interval(previous_interval)
    if preserved_invalid_sources:
        print(
            "Shotmap source anomalies: "
            f"{preserved_invalid_sources} session(s) preserved without overwrite",
            file=sys.stderr,
            flush=True,
        )
    if fetch_errors:
        print(
            f"Shotmap fetch errors: {fetch_errors} target(s) preserved",
            file=sys.stderr,
            flush=True,
        )
    if fatal_errors:
        raise ShotmapBackfillError(
            "Unexpected worker failures after preserving checkpoints: "
            + "; ".join(fatal_errors)
        )
    return len(targets), completed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--player-id")
    parser.add_argument("--workers", type=int, choices=(1, 3), default=3)
    parser.add_argument(
        "--request-interval-seconds",
        type=float,
        default=MIN_REQUEST_INTERVAL_SECONDS,
    )
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
        args.season_name,
        args.limit,
        args.player_id,
        args.refresh_existing,
        args.workers,
        args.request_interval_seconds,
    )
    print(f"Shotmap snapshot: {completed}/{targets} player-season targets updated")


if __name__ == "__main__":
    main()
