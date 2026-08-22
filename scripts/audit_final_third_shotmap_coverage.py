"""Audit exact-context Final Third Shot Chart snapshot coverage.

The companion API is deliberately fail-closed: it can only use the committed
``heatmap_key`` for the player and competition selected by the caller.  This
audit turns that storage-level fact into two small, reviewable reports:

* coverage by season/mode/scope/competition; and
* the exact tactical sessions that remain unavailable.

It never calls FotMob or SportsAPI.  The reports therefore describe what a
deployed static snapshot can serve, rather than an optimistic provider probe.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path
import sys
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rankings import COMPARISON_SCOPES
from shotmap_store_v2 import load_shotmap_points


DATA_DIR = ROOT / "data"
TACTICAL_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
COVERAGE_PATH = DATA_DIR / "final_third_shotmap_coverage.csv"
UNAVAILABLE_PATH = DATA_DIR / "final_third_shotmap_unavailable_contexts.csv"
SOURCE_EXCEPTIONS_PATH = DATA_DIR / "shotmap_source_exceptions.csv"

EUROPE_COMPETITIONS = {
    "UEFA Champions League": "ucl",
    "UEFA Europa League": "uel",
    "UEFA Europa Conference League": "uecl",
}
DOMESTIC_LEAGUE_IDS = {
    "Premier League": 47,
    "LaLiga": 87,
    "Bundesliga": 54,
    "Serie A": 55,
    "Ligue 1": 53,
    "Eredivisie": 57,
    "Primeira Liga": 61,
    "Belgian Pro League": 40,
}

COVERAGE_FIELDS = (
    "season_name", "mode", "scope", "competition", "competition_name",
    "sessions", "snapshot_available", "snapshot_missing",
    "verified_zero_shot_sessions", "shots_total",
)
UNAVAILABLE_FIELDS = (
    "player_id", "player_name", "season_name", "mode", "scope",
    "competition", "competition_name", "heatmap_key", "reason",
)


def load_source_exceptions(path: Path = SOURCE_EXCEPTIONS_PATH) -> dict[str, str]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8", newline="") as source:
        return {
            str(row.get("heatmap_key") or "").strip(): str(row.get("reason") or "").strip()
            for row in csv.DictReader(source)
            if str(row.get("heatmap_key") or "").strip()
            and str(row.get("reason") or "").strip()
        }


def context_refs(row: dict[str, str]) -> tuple[tuple[str, str, str, str], ...]:
    """Return the exact API context families supported by one tactical row.

    League scope only changes the comparison cohort; it never changes the
    selected domestic player's shot-event source.  A row is listed once for
    every scope that can legitimately include its domestic league.
    """

    competition_name = str(row.get("competition_name") or "").strip()
    if competition_name in EUROPE_COMPETITIONS:
        return (("europe", "", EUROPE_COMPETITIONS[competition_name], competition_name),)
    league_id = DOMESTIC_LEAGUE_IDS.get(competition_name)
    if league_id is None:
        return ()
    return tuple(
        ("league", str(scope), "all", competition_name)
        for scope, league_ids in sorted(COMPARISON_SCOPES.items())
        if league_id in league_ids
    )


def _rows(path: Path = TACTICAL_PATH) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as source:
        return [row for row in csv.DictReader(source) if str(row.get("heatmap_key") or "").strip()]


def build_report(
    rows: Iterable[dict[str, str]], snapshots: dict[str, list[Any]],
    source_exceptions: dict[str, str],
) -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    """Return deterministic coverage and unavailable-context report rows."""

    grouped: dict[tuple[str, str, str, str, str], dict[str, int]] = defaultdict(
        lambda: {
            "sessions": 0, "snapshot_available": 0, "snapshot_missing": 0,
            "verified_zero_shot_sessions": 0, "shots_total": 0,
        }
    )
    unavailable: list[dict[str, str]] = []
    for row in rows:
        heatmap_key = str(row.get("heatmap_key") or "").strip()
        available = heatmap_key in snapshots
        points = snapshots.get(heatmap_key, [])
        for mode, scope, competition, competition_name in context_refs(row):
            key = (
                str(row.get("season_name") or ""), mode, scope,
                competition, competition_name,
            )
            summary = grouped[key]
            summary["sessions"] += 1
            if available:
                summary["snapshot_available"] += 1
                summary["shots_total"] += len(points)
                if not points:
                    summary["verified_zero_shot_sessions"] += 1
                continue
            summary["snapshot_missing"] += 1
            unavailable.append({
                "player_id": str(row.get("fotmob_player_id") or ""),
                "player_name": str(row.get("player_name") or ""),
                "season_name": key[0], "mode": mode, "scope": scope,
                "competition": competition, "competition_name": competition_name,
                "heatmap_key": heatmap_key,
                "reason": source_exceptions.get(heatmap_key, "snapshot_missing"),
            })
    coverage = [
        {
            "season_name": key[0], "mode": key[1], "scope": key[2],
            "competition": key[3], "competition_name": key[4], **counts,
        }
        for key, counts in sorted(grouped.items())
    ]
    unavailable.sort(key=lambda item: (
        item["season_name"], item["mode"], item["competition"], item["scope"],
        item["player_name"], item["player_id"],
    ))
    return coverage, unavailable


def write_reports(
    coverage: list[dict[str, object]], unavailable: list[dict[str, str]],
    *, coverage_path: Path = COVERAGE_PATH, unavailable_path: Path = UNAVAILABLE_PATH,
) -> None:
    for path, fields, report in (
        (coverage_path, COVERAGE_FIELDS, coverage),
        (unavailable_path, UNAVAILABLE_FIELDS, unavailable),
    ):
        with path.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=fields, lineterminator="\n")
            writer.writeheader()
            writer.writerows(report)


def main() -> None:
    coverage, unavailable = build_report(
        _rows(), load_shotmap_points(), load_source_exceptions(),
    )
    write_reports(coverage, unavailable)
    total = sum(int(row["sessions"]) for row in coverage)
    available = sum(int(row["snapshot_available"]) for row in coverage)
    print(
        "Final Third exact-context coverage: "
        f"{available}/{total}; unavailable contexts: {len(unavailable)}"
    )


if __name__ == "__main__":
    main()
