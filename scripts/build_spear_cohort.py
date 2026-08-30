"""Build cached S.P.E.A.R. F/M comparison cohorts for Streamlit."""

from __future__ import annotations

import argparse
import csv
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fotmob_client import FotMobError, fetch_team_name
from rankings import _fetch_live_spear_cohort, cohort_candidate_rows
from spear_cohort import CSV_FIELDS, DATA_PATH


COMPETITIONS = {
    "Premier League": 47,
    "LaLiga": 87,
    "Bundesliga": 54,
    "Serie A": 55,
    "Ligue 1": 53,
    "Eredivisie": 57,
    "Primeira Liga": 61,
    "Belgian Pro League": 40,
    "UEFA Champions League": 42,
    "UEFA Europa League": 73,
    "UEFA Europa Conference League": 108,
}

def build(
    season_name: str, competition_names: tuple[str, ...] | list[str] | None = None,
) -> list[dict[str, object]]:
    """Build one season, optionally refreshing only selected competition slices."""
    output: list[dict[str, object]] = []
    selected_competitions = tuple(competition_names or COMPETITIONS.keys())
    for competition_name in selected_competitions:
        league_id = COMPETITIONS[competition_name]
        try:
            metrics_by_player, _ = _fetch_live_spear_cohort(
                league_id, season_name, True, 0,
            )
            # Candidate discovery is the same union used by the scorer.  Do
            # not name expected-goals-only entrants as "Unknown".
            name_rows = cohort_candidate_rows(league_id, season_name).values()
        except FotMobError as exc:
            print(f"Skipping {competition_name}: {exc}")
            continue
        names = {str(row.get("id")): str(row.get("name", "Unknown")) for row in name_rows}
        # Stat-table rows expose a team ID rather than a team name.  Resolve
        # each distinct team once, never once per player.
        team_ids = sorted({int(metric.team_id) for metric in metrics_by_player.values() if metric.team_id})
        teams_by_id: dict[int, str] = {}
        for index, team_id in enumerate(team_ids):
            if index:
                time.sleep(0.12)
            if team_name := fetch_team_name(team_id):
                teams_by_id[team_id] = team_name
        for player_id, metric in metrics_by_player.items():
            payload = asdict(metric)
            # Resolve the season record's team ID only when metrics did not
            # already include a team label.
            if not payload.get("team_name"):
                payload["team_name"] = teams_by_id.get(metric.team_id or 0, "")
            output.append({
                "player_id": player_id,
                "player_name": names.get(player_id, "Unknown"),
                "season_name": season_name,
                **payload,
            })
        print(f"{competition_name}: cached {len(metrics_by_player)} eligible players")
    return output


def write(rows: list[dict[str, object]]) -> None:
    """Replace only refreshed competition/season slices of the static cache.

    A refresh can legitimately fail for one historical competition while the
    other competitions still return rows. Replacing a whole season in that
    situation used to erase an intact snapshot and make historic reports
    silently incomplete. Preserve every slice this run did not replace.
    """
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    refreshed_slices = {
        (
            str(row.get("season_name", "")).strip(),
            str(row.get("league_id", "")).strip(),
        )
        for row in rows
    }
    retained: list[dict[str, str]] = []
    if DATA_PATH.exists():
        with DATA_PATH.open(encoding="utf-8", newline="") as source:
            retained = [
                row for row in csv.DictReader(source)
                if (
                    str(row.get("season_name", "")).strip(),
                    str(row.get("league_id", "")).strip(),
                ) not in refreshed_slices
            ]
    with DATA_PATH.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(retained)
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name", default="2025/2026")
    parser.add_argument(
        "--competitions", nargs="+", choices=tuple(COMPETITIONS),
        help="Optional competition slices to refresh; defaults to every supported competition.",
    )
    args = parser.parse_args()
    rows = build(args.season_name, args.competitions)
    if not rows:
        raise SystemExit("No S.P.E.A.R. cohort rows were generated; preserving no partial data.")
    write(rows)
    print(f"Wrote {len(rows)} rows at {datetime.now(timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
