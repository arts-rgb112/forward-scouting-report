"""Static S.P.E.A.R. comparison-cohort storage and loading."""

from __future__ import annotations

import csv
import functools
from dataclasses import fields
from pathlib import Path

from metrics import DecisionMetrics


DATA_PATH = Path(__file__).with_name("data") / "spear_cohort.csv"
TEXT_FIELDS = {
    "league_name", "team_name", "position", "position_group",
    "recoveries_source", "final_third_possessions_won_source",
}
METRIC_FIELDS = tuple(field.name for field in fields(DecisionMetrics))
CSV_FIELDS = ("player_id", "player_name", "season_name", *METRIC_FIELDS)


def spear_cohort_data_version() -> tuple[int, int] | None:
    """Return a cache token that changes with each deployed cohort snapshot."""
    try:
        stat = DATA_PATH.stat()
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return None


def _metric_from_row(row: dict[str, str]) -> DecisionMetrics | None:
    try:
        values: dict[str, object] = {}
        for name in METRIC_FIELDS:
            value = row.get(name, "")
            if value == "":
                values[name] = None
            elif name in TEXT_FIELDS:
                values[name] = value
            elif name in {"league_id", "team_id"}:
                values[name] = int(float(value))
            else:
                values[name] = float(value)
        return DecisionMetrics(**values)
    except (TypeError, ValueError):
        return None


@functools.lru_cache(maxsize=1)
def load_spear_cohort() -> dict[tuple[int, str], dict[str, tuple[str, DecisionMetrics]]]:
    """Load precomputed league/season F/M cohorts without network calls."""
    if not DATA_PATH.exists():
        return {}
    cohorts: dict[tuple[int, str], dict[str, tuple[str, DecisionMetrics]]] = {}
    try:
        with DATA_PATH.open(encoding="utf-8", newline="") as source:
            for row in csv.DictReader(source):
                metric = _metric_from_row(row)
                player_id = str(row.get("player_id", "")).strip()
                season_name = str(row.get("season_name", "")).strip()
                if metric is None or metric.league_id is None or not player_id or not season_name:
                    continue
                cohorts.setdefault((metric.league_id, season_name), {})[player_id] = (
                    str(row.get("player_name", "Unknown")).strip() or "Unknown",
                    metric,
                )
    except OSError:
        return {}
    return cohorts


def get_static_spear_cohort(
    league_id: int, season_name: str,
) -> tuple[dict[str, DecisionMetrics], dict[str, str]]:
    rows = load_spear_cohort().get((int(league_id), season_name), {})
    metrics = {player_id: metric for player_id, (_, metric) in rows.items()}
    names = {player_id: name for player_id, (name, _) in rows.items()}
    return metrics, names
