"""Populate missing season-specific team names in the static S.P.E.A.R. cohort.

This intentionally uses one FotMob stat-table request per league/season group
instead of a player-profile request for every row.  It is safe to run after a
cohort refresh, or by itself to repair an existing static snapshot.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fotmob_client import FotMobError, fetch_league_stat_table
from spear_cohort import CSV_FIELDS, DATA_PATH
from build_spear_cohort import _team_name_from_leaderboard_row


def main() -> None:
    if not DATA_PATH.exists():
        raise SystemExit("Static cohort CSV is missing.")
    with DATA_PATH.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))

    targets = {
        (int(row["league_id"]), str(row["season_name"]))
        for row in rows
        if row.get("league_id") and row.get("season_name") and not row.get("team_name")
    }
    if not targets:
        print("All static S.P.E.A.R. cohort rows already have a team name.")
        return

    team_maps: dict[tuple[int, str], dict[str, str]] = {}
    for league_id, season_name in sorted(targets):
        try:
            leaderboard = fetch_league_stat_table(league_id, season_name, "won_contest")
        except FotMobError as exc:
            print(f"Skipping {league_id} / {season_name}: {exc}")
            continue
        team_maps[(league_id, season_name)] = {
            str(row.get("id")): _team_name_from_leaderboard_row(row)
            for row in leaderboard
            if row.get("id") and _team_name_from_leaderboard_row(row)
        }
        print(f"{league_id} / {season_name}: {len(team_maps[(league_id, season_name)])} team mappings")

    updated = 0
    for row in rows:
        if row.get("team_name"):
            continue
        try:
            key = (int(row["league_id"]), str(row["season_name"]))
        except (TypeError, ValueError):
            continue
        team_name = team_maps.get(key, {}).get(str(row.get("player_id", "")))
        if team_name:
            row["team_name"] = team_name
            updated += 1

    with DATA_PATH.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Updated {updated} cohort rows with season-specific team names.")


if __name__ == "__main__":
    main()
