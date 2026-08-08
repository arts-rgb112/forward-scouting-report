"""Populate missing season-specific team names in the static S.P.E.A.R. cohort.

This intentionally resolves each distinct FotMob team ID once instead of
fetching a player profile for every cohort row.  It is safe to run after a
cohort refresh, or by itself to repair an existing static snapshot.
"""

from __future__ import annotations

import csv
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fotmob_client import fetch_team_name
from spear_cohort import CSV_FIELDS, DATA_PATH


def main() -> None:
    if not DATA_PATH.exists():
        raise SystemExit("Static cohort CSV is missing.")
    with DATA_PATH.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))

    team_ids = sorted({
        int(row["team_id"])
        for row in rows
        if row.get("team_id") and not row.get("team_name")
    })
    if not team_ids:
        print("All static S.P.E.A.R. cohort rows already have a team name.")
        return

    team_names: dict[int, str] = {}
    for index, team_id in enumerate(team_ids):
        if index:
            time.sleep(0.12)
        if team_name := fetch_team_name(team_id):
            team_names[team_id] = team_name
    print(f"Resolved {len(team_names)} / {len(team_ids)} unique team IDs.")

    updated = 0
    for row in rows:
        if row.get("team_name"):
            continue
        try:
            team_id = int(row["team_id"])
        except (TypeError, ValueError):
            continue
        team_name = team_names.get(team_id)
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
