"""Build static Heat Ratio data from SportsAPI Pro Football V2.

Usage (PowerShell):
  $env:SPORTSAPIPRO_API_KEY = "..."
  python scripts/build_tactical_ratios.py --season-name "2025/2026"

The script discovers tournament and season IDs at runtime, checkpoints partial
results, throttles every request, and never writes an unverified
SportsAPI-to-FotMob player mapping.
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


# Prefer the canonical path-based endpoint. Some accounts are still rolling
# onto that host, so a 403 safely falls back to the permanent V2 subdomain.
BASE_URLS = (
    "https://api.sportsapipro.com/v2/football",
    "https://v2.football.sportsapipro.com/api",
)
# Key aliases are normalised API display names; values are the one label shown
# in logs and retained in checkpoints.  Each target is processed at most once.
TARGET_TOURNAMENTS = {
    "premier league": "Premier League",
    "laliga": "LaLiga",
    "la liga": "LaLiga",
    "bundesliga": "Bundesliga",
    "serie a": "Serie A",
    "ligue 1": "Ligue 1",
}
ATTACKING_POSITION_TOKENS = ("attacker", "forward", "striker", "centre-forward", "center-forward", "attacking midfielder", " cf", "st")
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class SportsApiClient:
    def __init__(self, api_keys: dict[str, str], delay_seconds: float) -> None:
        self.api_keys = api_keys
        self.delay_seconds = delay_seconds

    def get(self, path: str, key_scope: str) -> Any:
        api_key = self.api_keys[key_scope]
        last_error: Exception | None = None
        for base_url in BASE_URLS:
            url = f"{base_url}/{path.lstrip('/')}"
            for attempt in range(6):
                try:
                    request = Request(url, headers={
                        "x-api-key": api_key,
                        "Accept": "application/json",
                        # SportsAPI accepts the same key via curl but rejects
                        # Python's default user agent with 403 on some routes.
                        "User-Agent": "Mozilla/5.0 (compatible; ForwardScoutingHeatRatio/1.0)",
                    })
                    with urlopen(request, timeout=30) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                    time.sleep(self.delay_seconds)
                    return payload
                except HTTPError as exc:
                    last_error = exc
                    # The canonical host can reject accounts that have not been
                    # rolled out yet; immediately try the documented legacy URL.
                    if exc.code == 403:
                        break
                    if exc.code not in (429, 500, 502, 503, 504) or attempt == 5:
                        raise
                except URLError as exc:
                    last_error = exc
                    if attempt == 5:
                        break
                retry_after = 0.0
                if isinstance(last_error, HTTPError):
                    retry_after = as_number(last_error.headers.get("Retry-After")) or 0.0
                time.sleep(max(retry_after, max(self.delay_seconds, 1.0) * (2 ** attempt)))
        if last_error:
            raise last_error
        raise RuntimeError(f"request retries exhausted: {path}")


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
    payload = client.get("tournaments?refresh=false", "all_leagues")
    matches: dict[str, dict[str, Any]] = {}
    target_objects: list[str] = []
    for item in walk_dicts(payload):
        raw_label = str(item.get("name", "")).strip().lower()
        if raw_label in TARGET_TOURNAMENTS:
            # Safe diagnostics only: these reveal the response shape, never
            # secret values or the full API response.
            target_objects.append(
                f"{item.get('name')!s} keys={','.join(sorted(item.keys()))}"
            )
        # The all-leagues response can contain teams, categories and seasons.
        # Only `uniqueTournament` is the canonical tournament entity; generic
        # recursive `{id, name}` discovery previously selected wrong IDs.
        candidates = []
        if isinstance(item.get("uniqueTournament"), dict):
            candidates.append(item["uniqueTournament"])
        if isinstance(item.get("uniqueTournaments"), list):
            candidates.extend(candidate for candidate in item["uniqueTournaments"] if isinstance(candidate, dict))
        for candidate in candidates:
            identifier = candidate.get("id")
            label = str(candidate.get("name", "")).strip()
            canonical_name = TARGET_TOURNAMENTS.get(label.lower())
            if identifier is None or not canonical_name:
                continue
            matches.setdefault(canonical_name, {"id": identifier, "name": canonical_name})
    if not matches:
        root_keys = ",".join(sorted(payload.keys())) if isinstance(payload, dict) else type(payload).__name__
        print(f"No canonical tournaments found. Root keys: {root_keys}")
        for description in target_objects[:10]:
            print(f"Target-label response shape: {description}")
    return [matches[name] for name in sorted(matches)]


def discover_season(client: SportsApiClient, tournament: dict[str, Any], season_name: str) -> dict[str, Any] | None:
    payload = client.get(f"tournaments/{tournament['id']}/seasons", "tournament")
    candidates: list[dict[str, Any]] = []
    for item in walk_dicts(payload):
        seasons = item.get("seasons")
        if isinstance(seasons, list):
            candidates.extend(season for season in seasons if isinstance(season, dict) and season.get("id") is not None)
    year_parts = re.findall(r"\d+", season_name)
    expected = {season_name.lower(), season_name.replace("/", "-").lower()}
    if len(year_parts) == 2:
        expected.update({f"{year_parts[0][-2:]}/{year_parts[1][-2:]}", f"{year_parts[0][-2:]}-{year_parts[1][-2:]}"})
    for item in candidates:
        label = " ".join(str(item.get(key, "")) for key in ("name", "year", "displayName")).lower()
        if any(token in label for token in expected):
            return item
    return None


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
    points: list[tuple[float, float]] = []
    for item in walk_dicts(payload):
        x, y = as_number(item.get("x")), as_number(item.get("y"))
        if x is not None and y is not None and 0 <= x <= 100 and 0 <= y <= 100:
            # Points are activity events, so identical coordinates still count
            # as separate observations in the density ratio.
            points.append((x, y))
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


OUTPUT_FIELDS = ["fotmob_player_id", "sportsapi_player_id", "player_name", "team_name", "tournament_id", "season_id", "mid_third_ratio", "final_third_ratio", "sample_points", "generated_at"]


def read_checkpoint(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as source:
        return [row for row in csv.DictReader(source) if row.get("sportsapi_player_id") and row.get("tournament_id") and row.get("season_id")]


def write_outputs(output: list[dict[str, Any]], unmatched: list[dict[str, Any]], auto_mapped: list[dict[str, Any]]) -> None:
    with (DATA_DIR / "tactical_ratio.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=OUTPUT_FIELDS)
        writer.writeheader(); writer.writerows(output)
    with (DATA_DIR / "unmatched_sportsapi_players.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["sportsapi_player_id", "name", "team_name"])
        writer.writeheader(); writer.writerows(unmatched)
    with (DATA_DIR / "auto_matched_fotmob_players.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["sportsapi_player_id", "fotmob_player_id", "name", "team_name"])
        writer.writeheader(); writer.writerows(auto_mapped)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name", required=True, help='display label, e.g. "2025/2026"')
    parser.add_argument("--delay", type=float, default=0.5, help="seconds between requests")
    args = parser.parse_args()
    api_keys = {
        "all_leagues": os.getenv("SPORTSAPIPRO_ALL_LEAGUES_API_KEY", ""),
        "tournament": os.getenv("SPORTSAPIPRO_TOURNAMENT_API_KEY", ""),
        "player": os.getenv("SPORTSAPIPRO_API_KEY", ""),
    }
    missing_scopes = [scope for scope, value in api_keys.items() if not value]
    if missing_scopes:
        raise SystemExit(f"Set the required SportsAPI keys for: {', '.join(missing_scopes)}. Do not put them in the repository.")

    DATA_DIR.mkdir(exist_ok=True)
    client = SportsApiClient(api_keys, args.delay)
    id_map = read_fotmob_map(DATA_DIR / "fotmob_player_map.csv")
    output = read_checkpoint(DATA_DIR / "tactical_ratio.csv")
    completed = {(row["sportsapi_player_id"], row["tournament_id"], row["season_id"]) for row in output}
    unmatched, auto_mapped = [], []
    for tournament in discover_tournaments(client):
        try:
            season = discover_season(client, tournament, args.season_name)
        except (HTTPError, URLError, TimeoutError) as exc:
            print(f"Skipping {tournament['name']}: seasons unavailable ({exc.code if isinstance(exc, HTTPError) else 'network'}).")
            continue
        if not season:
            print(f"Skipping {tournament['name']}: no exact {args.season_name} season found.")
            continue
        season_id = season["id"]
        print(f"Processing {tournament['name']}: tournament={tournament['id']}, season={season_id}")
        try:
            ranking = client.get(f"tournament/{tournament['id']}/season/{season_id}/top-players", "tournament")
        except (HTTPError, URLError) as exc:
            print(f"Skipping {tournament['name']}: top-players unavailable ({exc.code if isinstance(exc, HTTPError) else 'network'}).")
            continue
        for sports_id, player in discover_players(ranking).items():
            checkpoint_key = (sports_id, str(tournament["id"]), str(season_id))
            if checkpoint_key in completed:
                continue
            try:
                profile = client.get(f"players/{sports_id}", "player")
                if not is_target_position(profile):
                    continue
                heatmap = client.get(f"players/{sports_id}/tournament/{tournament['id']}/season/{season_id}/heatmap?type=overall", "player")
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
        # A successful league survives a later rate-limit/network failure.
        write_outputs(output, unmatched, auto_mapped)
    write_outputs(output, unmatched, auto_mapped)
    print(f"Wrote {len(output)} matched ratios ({len(auto_mapped)} auto-mapped) and {len(unmatched)} unmatched players.")


if __name__ == "__main__":
    main()
