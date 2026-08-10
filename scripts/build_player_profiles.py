"""Build the FotMob birth-date snapshot used by the M.E.S.S.I. API."""

from __future__ import annotations

import argparse
import csv
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
COHORT_PATH = ROOT / "data" / "spear_cohort.csv"
OUTPUT_PATH = ROOT / "data" / "player_profiles.csv"


def fetch_birth_date(player_id: str) -> str | None:
    request = Request(
        f"https://www.fotmob.com/api/data/playerData?id={player_id}",
        headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 (M.E.S.S.I. profile snapshot)"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None
    birth_date = payload.get("birthDate") if isinstance(payload, dict) else None
    value = birth_date.get("utcTime") if isinstance(birth_date, dict) else None
    return str(value)[:10] if value else None


def source_players() -> dict[str, str]:
    with COHORT_PATH.open(encoding="utf-8", newline="") as source:
        return {
            str(row["player_id"]): str(row.get("player_name", "")).strip()
            for row in csv.DictReader(source)
            if str(row.get("player_id", "")).strip()
        }


def existing_profiles() -> dict[str, dict[str, str]]:
    if not OUTPUT_PATH.exists():
        return {}
    with OUTPUT_PATH.open(encoding="utf-8", newline="") as source:
        return {
            str(row["player_id"]): row
            for row in csv.DictReader(source)
            if row.get("player_id") and row.get("birth_date")
        }


def write_profiles(profiles: dict[str, dict[str, str]]) -> None:
    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    temporary = OUTPUT_PATH.with_suffix(".csv.tmp")
    with temporary.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=("player_id", "player_name", "birth_date"))
        writer.writeheader()
        writer.writerows(profiles[player_id] for player_id in sorted(profiles, key=int))
    temporary.replace(OUTPUT_PATH)


def main() -> None:
    parser = argparse.ArgumentParser(description="Snapshot FotMob player birth dates for the static API.")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0, help="Optional cap for an incremental backfill.")
    args = parser.parse_args()

    players = source_players()
    profiles = existing_profiles()
    pending = [player_id for player_id in players if player_id not in profiles]
    if args.limit:
        pending = pending[:args.limit]
    print(f"Profile snapshot: {len(profiles)} present, {len(pending)} pending.")
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(fetch_birth_date, player_id): player_id for player_id in pending}
        for index, future in enumerate(as_completed(futures), start=1):
            player_id = futures[future]
            birth_date = future.result()
            if birth_date:
                profiles[player_id] = {
                    "player_id": player_id,
                    "player_name": players[player_id],
                    "birth_date": birth_date,
                }
            if index % 100 == 0 or index == len(pending):
                print(f"Fetched {index}/{len(pending)}; valid profiles: {len(profiles)}.")
    write_profiles(profiles)
    print(f"Wrote {len(profiles)} profiles to {OUTPUT_PATH}.")


if __name__ == "__main__":
    main()
