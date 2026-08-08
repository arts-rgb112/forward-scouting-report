"""Build cached S.P.E.A.R. F/M comparison cohorts for Streamlit."""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fotmob_client import FotMobError, fetch_league_stat_table
from rankings import _fetch_live_spear_cohort
from spear_cohort import CSV_FIELDS, DATA_PATH


COMPETITIONS = {
    "Premier League": 47,
    "LaLiga": 87,
    "Bundesliga": 54,
    "Serie A": 55,
    "Ligue 1": 53,
    "Eredivisie": 57,
    "Primeira Liga": 61,
    "UEFA Champions League": 42,
    "UEFA Europa League": 73,
    "UEFA Europa Conference League": 102,
}


def build(season_name: str) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    for competition_name, league_id in COMPETITIONS.items():
        try:
            metrics_by_player, _ = _fetch_live_spear_cohort(
                league_id, season_name, True, 0,
            )
            name_rows = fetch_league_stat_table(league_id, season_name, "won_contest")
        except FotMobError as exc:
            print(f"Skipping {competition_name}: {exc}")
            continue
        names = {str(row.get("id")): str(row.get("name", "Unknown")) for row in name_rows}
        for player_id, metric in metrics_by_player.items():
            output.append({
                "player_id": player_id,
                "player_name": names.get(player_id, "Unknown"),
                "season_name": season_name,
                **asdict(metric),
            })
        print(f"{competition_name}: cached {len(metrics_by_player)} same-competition xG1+ players")
    return output


def write(rows: list[dict[str, object]]) -> None:
    """Replace one season while retaining every previously cached season.

    The former writer overwrote ``spear_cohort.csv`` on every workflow run.
    That made an older season silently fall back to live requests and produced
    under-sized historical comparison populations in the dashboard.
    """
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    refreshed_seasons = {str(row.get("season_name", "")).strip() for row in rows}
    retained: list[dict[str, str]] = []
    if DATA_PATH.exists():
        with DATA_PATH.open(encoding="utf-8", newline="") as source:
            retained = [
                row for row in csv.DictReader(source)
                if str(row.get("season_name", "")).strip() not in refreshed_seasons
            ]
    with DATA_PATH.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(retained)
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name", default="2025/2026")
    args = parser.parse_args()
    rows = build(args.season_name)
    if not rows:
        raise SystemExit("No S.P.E.A.R. cohort rows were generated; preserving no partial data.")
    write(rows)
    print(f"Wrote {len(rows)} rows at {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
