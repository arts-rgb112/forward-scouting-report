"""Build static Heat Ratio data from SportsAPI Pro Football V2.

Usage (PowerShell):
  $env:SPORTSAPIPRO_API_KEY = "..."
  python scripts/build_tactical_ratios.py --season-name "2025/2026"

The script discovers tournament and season IDs at runtime, throttles every
request, and never writes an unverified SportsAPI-to-FotMob player mapping.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


# Canonical path-based V2 URL. The legacy subdomain remains compatible, but
# this avoids mixing endpoint shapes across the ETL and documentation.
BASE_URL = "https://api.sportsapipro.com/v2/football"
TARGET_TOURNAMENTS = {"premier league", "laliga", "la liga", "bundesliga", "serie a", "ligue 1"}
ATTACKING_POSITION_TOKENS = ("attacker", "forward", "striker", "centre-forward", "center-forward", "attacking midfielder", " cf", "st")
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class SportsApiClient:
    def __init__(self, api_key: str, delay_seconds: float) -> None:
        self.api_key = api_key
        self.delay_seconds = delay_seconds

    def get(self, path: str) -> Any:
        url = f"{BASE_URL}/{path.lstrip('/')}"
        for attempt in range(4):
            try:
                request = Request(url, headers={"x-api-key": self.api_key, "Accept": "application/json"})
                with urlopen(request, timeout=30) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                time.sleep(self.delay_seconds)
                return payload
            except HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise
            except URLError:
                if attempt == 3:
                    raise
            time.sleep(max(self.delay_seconds, 1.0) * (2 ** attempt))
        raise RuntimeError(f"request retries exhausted: {url}")


def walk_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def as_number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def discover_tournaments(client: SportsApiClient) -> list[dict[str, Any]]:
    payload = client.get("tournaments?refresh=false")
    matches: dict[str, dict[str, Any]] = {}
    for item in walk_dicts(payload):
        identifier, name = item.get("id"), str(item.get("name", "")).strip()
        if identifier is None or not any(target in name.lower() for target in TARGET_TOURNAMENTS):
            continue
        matches[str(identifier)] = {"id": identifier, "name": name}
    return list(matches.values())


def discover_season(client: SportsApiClient, tournament: dict[str, Any], season_name: str) -> dict[str, Any] | None:
    payload = client.get(f"tournament/{tournament['id']}/seasons")
    candidates = [item for item in walk_dicts(payload) if item.get("id") is not None]
    normalized = season_name.replace("/", "-").lower()
    for item in candidates:
        label = " ".join(str(item.get(key, "")) for key in ("name", "year", "displayName")).lower()
        if normalized in label or season_name.lower() in label:
            return item
    return candidates[0] if candidates else None


def discover_players(payload: Any) -> dict[str, dict[str, Any]]:
    players: dict[str, dict[str, Any]] = {}
    for item in walk_dicts(payload):
        # Tournament top-player records nest the player object. Do not accept
        # arbitrary {id, name} objects here: those include teams and tournaments.
        candidate = item.get("player") if isinstance(item.get("player"), dict) else None
        identifier = candidate.get("id") if candidate else None
        name = candidate.get("name") if candidate else None
        if identifier is not None and name:
            players[str(identifier)] = {"id": identifier, "name": str(name), "team_name": str(candidate.get("teamName") or "")}
    return players


def is_target_position(profile: Any) -> bool:
    values = []
    for item in walk_dicts(profile):
        for key in ("position", "positionName", "positionCode", "positions"):
            value = item.get(key)
            if isinstance(value, list):
                values.extend(str(part) for part in value)
            elif value is not None:
                values.append(str(value))
    text = " ".join(values).lower()
    codes = set(re.findall(r"\b[a-z]{2,}\b", text))
    return any(token in text for token in ATTACKING_POSITION_TOKENS[:-1]) or bool({"st", "cf"} & codes)


def heat_ratio(payload: Any) -> tuple[int, int, int] | None:
    points: set[tuple[float, float]] = set()
    for item in walk_dicts(payload):
        x, y = as_number(item.get("x")), as_number(item.get("y"))
        if x is not None and y is not None and 0 <= x <= 100 and 0 <= y <= 100:
            points.add((x, y))
    mid = sum(33 <= x < 66 for x, _ in points)
    final = sum(66 <= x <= 100 for x, _ in points)
    total = mid + final
    if total == 0:
        return None
    return round(mid * 100 / total), round(final * 100 / total), total


def read_fotmob_map(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8", newline="") as source:
        return {row["sportsapi_player_id"].strip(): row["fotmob_player_id"].strip() for row in csv.DictReader(source) if row.get("sportsapi_player_id") and row.get("fotmob_player_id")}


def _normalise_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def resolve_fotmob_id(player_name: str) -> str | None:
    """Auto-map only an unambiguous exact-name match; never guess otherwise."""
    try:
        from fotmob_client import FotMobError, search_players
        target = _normalise_name(player_name)
        matches = [candidate for candidate in search_players(player_name) if _normalise_name(candidate.name) == target]
        return matches[0].player_id if len(matches) == 1 else None
    except (ImportError, FotMobError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name", required=True, help='display label, e.g. "2025/2026"')
    parser.add_argument("--delay", type=float, default=0.2, help="seconds between requests")
    args = parser.parse_args()
    api_key = os.getenv("SPORTSAPIPRO_API_KEY")
    if not api_key:
        raise SystemExit("Set SPORTSAPIPRO_API_KEY; do not put it in the repository.")

    DATA_DIR.mkdir(exist_ok=True)
    client = SportsApiClient(api_key, args.delay)
    id_map = read_fotmob_map(DATA_DIR / "fotmob_player_map.csv")
    output, unmatched, auto_mapped = [], [], []
    for tournament in discover_tournaments(client):
        season = discover_season(client, tournament, args.season_name)
        if not season:
            continue
        season_id = season["id"]
        ranking = client.get(f"tournament/{tournament['id']}/season/{season_id}/top-players")
        for sports_id, player in discover_players(ranking).items():
            try:
                profile = client.get(f"players/{sports_id}")
                if not is_target_position(profile):
                    continue
                heatmap = client.get(f"players/{sports_id}/tournament/{tournament['id']}/season/{season_id}/heatmap?type=overall")
                ratios = heat_ratio(heatmap)
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue
            if ratios is None:
                continue
            fotmob_id = id_map.get(sports_id) or resolve_fotmob_id(player["name"])
            if not fotmob_id:
                unmatched.append({"sportsapi_player_id": sports_id, **player})
                continue
            if sports_id not in id_map:
                auto_mapped.append({"sportsapi_player_id": sports_id, "fotmob_player_id": fotmob_id, **player})
            mid, final, samples = ratios
            output.append({
                "fotmob_player_id": fotmob_id, "sportsapi_player_id": sports_id,
                "player_name": player["name"], "team_name": player["team_name"],
                "tournament_id": tournament["id"], "season_id": season_id,
                "mid_third_ratio": mid, "final_third_ratio": final,
                "sample_points": samples, "generated_at": datetime.now(timezone.utc).isoformat(),
            })

    fields = ["fotmob_player_id", "sportsapi_player_id", "player_name", "team_name", "tournament_id", "season_id", "mid_third_ratio", "final_third_ratio", "sample_points", "generated_at"]
    with (DATA_DIR / "tactical_ratio.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fields)
        writer.writeheader(); writer.writerows(output)
    with (DATA_DIR / "unmatched_sportsapi_players.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["sportsapi_player_id", "name", "team_name"])
        writer.writeheader(); writer.writerows(unmatched)
    with (DATA_DIR / "auto_matched_fotmob_players.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["sportsapi_player_id", "fotmob_player_id", "name", "team_name"])
        writer.writeheader(); writer.writerows(auto_mapped)
    print(f"Wrote {len(output)} matched ratios ({len(auto_mapped)} auto-mapped) and {len(unmatched)} unmatched players.")


if __name__ == "__main__":
    main()
