"""Audit static shot-coordinate coverage against every tactical session."""

from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shotmap_store_v2 import load_shotmap_points
from api_server.schemas import ShotmapPoint


RATIOS_PATH = ROOT / "data" / "tactical_3zone_ratio.csv"
REPORT_PATH = ROOT / "data" / "missing_shotmap_sessions.csv"
SOURCE_EXCEPTIONS_PATH = ROOT / "data" / "shotmap_source_exceptions.csv"
REPORT_FIELDS = (
    "fotmob_player_id", "player_name", "competition_name", "season_name",
    "heatmap_key", "reason",
)


def load_source_exceptions(path: Path = SOURCE_EXCEPTIONS_PATH) -> dict[str, str]:
    """Return reviewed source failures keyed by the exact tactical session."""
    if not path.exists():
        return {}
    with path.open(encoding="utf-8", newline="") as source:
        return {
            str(row.get("heatmap_key") or "").strip(): str(row.get("reason") or "").strip()
            for row in csv.DictReader(source)
            if str(row.get("heatmap_key") or "").strip()
            and str(row.get("reason") or "").strip()
        }


def audit() -> tuple[int, int, int, Counter[str]]:
    snapshots = load_shotmap_points()
    source_exceptions = load_source_exceptions()
    with RATIOS_PATH.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    missing: list[dict[str, str]] = []
    covered = 0
    empty = 0
    by_season: Counter[str] = Counter()
    for row in rows:
        key = str(row.get("heatmap_key") or "").strip()
        if key in snapshots:
            covered += 1
            empty += not bool(snapshots[key])
            continue
        season = str(row.get("season_name") or "")
        by_season[season] += 1
        missing.append({
            field: (
                source_exceptions.get(key, "snapshot_missing") if field == "reason"
                else str(row.get(field) or "")
            )
            for field in REPORT_FIELDS
        })
    with REPORT_PATH.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=REPORT_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(missing)
    return len(rows), covered, empty, by_season


def audit_trajectories() -> tuple[int, int, int, Counter[str], Counter[str]]:
    """Audit optional endpoint enrichment without treating legacy rows as invalid."""

    snapshots = load_shotmap_points()
    with RATIOS_PATH.open(encoding="utf-8", newline="") as source:
        season_by_key = {
            str(row.get("heatmap_key") or "").strip(): str(row.get("season_name") or "")
            for row in csv.DictReader(source)
        }
    total_shots = 0
    enriched = 0
    invalid = 0
    by_kind: Counter[str] = Counter()
    missing_by_season: Counter[str] = Counter()
    for key, records in snapshots.items():
        season = season_by_key.get(key, "unknown")
        for record in records:
            total_shots += 1
            try:
                point = ShotmapPoint.model_validate(record)
            except (TypeError, ValueError):
                invalid += 1
                continue
            if point.trajectory is None:
                missing_by_season[season] += 1
                continue
            enriched += 1
            by_kind[point.trajectory.endpointKind] += 1
    return total_shots, enriched, invalid, by_kind, missing_by_season


if __name__ == "__main__":
    total, covered, empty, by_season = audit()
    print(f"Shotmap coverage: {covered}/{total}; verified zero-shot sessions: {empty}")
    print("Missing by season: " + ", ".join(f"{season}={count}" for season, count in sorted(by_season.items())))
    total_shots, enriched, invalid, by_kind, trajectory_missing = audit_trajectories()
    print(
        f"Trajectory coverage: {enriched}/{total_shots}; invalid enriched records: {invalid}; "
        + "kinds: " + ", ".join(f"{kind}={count}" for kind, count in sorted(by_kind.items()))
    )
    print(
        "Shots without provider-backed trajectory by season: "
        + ", ".join(f"{season}={count}" for season, count in sorted(trajectory_missing.items()))
    )
