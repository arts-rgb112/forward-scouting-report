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
import unicodedata
from collections import Counter
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
    ("premier league", "england"): "Premier League",
    ("laliga", "spain"): "LaLiga",
    ("la liga", "spain"): "LaLiga",
    ("bundesliga", "germany"): "Bundesliga",
    ("serie a", "italy"): "Serie A",
    ("ligue 1", "france"): "Ligue 1",
    ("eredivisie", "netherlands"): "Eredivisie",
    ("primeira liga", "portugal"): "Primeira Liga",
    ("liga portugal", "portugal"): "Primeira Liga",
    ("uefa champions league", "europe"): "UEFA Champions League",
    ("champions league", "europe"): "UEFA Champions League",
    ("uefa europa league", "europe"): "UEFA Europa League",
    ("europa league", "europe"): "UEFA Europa League",
    ("uefa europa conference league", "europe"): "UEFA Europa Conference League",
    ("uefa conference league", "europe"): "UEFA Europa Conference League",
    ("europa conference league", "europe"): "UEFA Europa Conference League",
}
# UEFA competitions have unique names but SportsAPI's country label has varied
# between "Europe", "International", and an empty string in historic catalog
# responses. Domestic names such as Premier League remain country-qualified;
# only these unambiguous UEFA names intentionally ignore country metadata.
UEFA_TOURNAMENT_NAMES = {
    "uefa champions league": "UEFA Champions League",
    "champions league": "UEFA Champions League",
    "uefa europa league": "UEFA Europa League",
    "europa league": "UEFA Europa League",
    "uefa europa conference league": "UEFA Europa Conference League",
    "uefa conference league": "UEFA Europa Conference League",
    "europa conference league": "UEFA Europa Conference League",
}
# The production dashboard covers seven domestic leagues and the three UEFA
# competitions. IDs remain dynamically discovered; these are stable display
# labels used only to validate source coverage.
REQUIRED_HEATMAP_COMPETITIONS = (
    "Premier League",
    "LaLiga",
    "Bundesliga",
    "Serie A",
    "Ligue 1",
    "Eredivisie",
    "Primeira Liga",
    "UEFA Champions League",
    "UEFA Europa League",
    "UEFA Europa Conference League",
)
# Static M.E.S.S.I. snapshots use FotMob's competition labels.  The tactical
# ETL uses SportsAPI's canonical display labels, so bridge the three UEFA
# names before looking for cohort players that still need a heatmap session.
COHORT_COMPETITION_NAMES = {
    "Premier League": "Premier League",
    "LaLiga": "LaLiga",
    "Bundesliga": "Bundesliga",
    "Serie A": "Serie A",
    "Ligue 1": "Ligue 1",
    "Eredivisie": "Eredivisie",
    "Primeira Liga": "Primeira Liga",
    "UEFA Champions League": "Champions League",
    "UEFA Europa League": "Europa League",
    "UEFA Europa Conference League": "Europa Conference League",
}
ATTACKING_POSITION_TOKENS = ("attacker", "forward", "striker", "centre-forward", "center-forward", "attacking midfielder", " cf", "st")
ACTIVITY_GRID_SIZE = 5.0
MIN_CELL_OVERLAP = 3
ACTIVITY_FILTER_VERSION = "cluster-v1"
CORE_COVERAGE_SHARE = 0.50
PITCH_AREA = 100.0 * 100.0
GOLD_ZONE_WEIGHT = 1.50
SILVER_ZONE_WEIGHT = 1.00
BRONZE_ZONE_WEIGHT = 0.50
ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class SportsApiQuotaExceeded(RuntimeError):
    """Raised when SportsAPI rejects a request because the quota is exhausted."""


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
                    if exc.code == 429:
                        retry_after = (exc.headers or {}).get("Retry-After", "unknown")
                        raise SportsApiQuotaExceeded(
                            "SportsAPI request quota or rate limit has been reached while "
                            f"requesting '{path}' (Retry-After: {retry_after}). "
                            "Stopping without publishing partial tactical data; run the "
                            "workflow again after the quota resets."
                        ) from exc
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


def cached_tournament_discoveries() -> dict[str, dict[str, Any]]:
    """Reuse IDs dynamically discovered by a prior successful refresh.

    The all-leagues catalog can temporarily expose only domestic competitions
    for a valid key.  Tournament IDs are stable entity identifiers, and the
    cache contains IDs obtained from previous API discovery rather than any
    hardcoded value.  The current season is still discovered and validated via
    ``/tournaments/{id}/seasons`` before a request is made.
    """
    path = DATA_DIR / "tactical_3zone_ratio.csv"
    if not path.exists():
        return {}
    recovered: dict[str, dict[str, Any]] = {}
    try:
        with path.open(encoding="utf-8", newline="") as source:
            for row in csv.DictReader(source):
                name = str(row.get("competition_name", "")).strip()
                tournament_id = str(row.get("tournament_id", "")).strip()
                if name in REQUIRED_HEATMAP_COMPETITIONS and tournament_id:
                    recovered.setdefault(name, {"id": tournament_id, "name": name})
    except OSError:
        return {}
    return recovered


def discover_tournaments(client: SportsApiClient) -> list[dict[str, Any]]:
    payload = client.get("tournaments?refresh=false", "all_leagues")
    matches: dict[str, dict[str, Any]] = {}
    # The scoped all-leagues endpoint returns direct league records.  The
    # country qualifier prevents unrelated competitions also called e.g.
    # "Premier League" from entering the five-major-league population.
    leagues = payload.get("leagues") if isinstance(payload, dict) else None
    for candidate in leagues if isinstance(leagues, list) else []:
        if not isinstance(candidate, dict):
            continue
        identifier = candidate.get("id")
        key = (
            str(candidate.get("name", "")).strip().lower(),
            str(candidate.get("countryName", "")).strip().lower(),
        )
        canonical_name = TARGET_TOURNAMENTS.get(key) or UEFA_TOURNAMENT_NAMES.get(key[0])
        if identifier is not None and canonical_name:
            matches.setdefault(canonical_name, {"id": identifier, "name": canonical_name})
    recovered = cached_tournament_discoveries()
    recovered_names = [name for name in recovered if name not in matches]
    for name in recovered_names:
        matches[name] = recovered[name]
    if not matches:
        root_keys = ",".join(sorted(payload.keys())) if isinstance(payload, dict) else type(payload).__name__
        print(f"No target leagues found. Root keys: {root_keys}")
    source_note = f"; recovered from prior discovery: {', '.join(sorted(recovered_names))}" if recovered_names else ""
    print(f"Discovered target competitions: {', '.join(sorted(matches)) or 'none'}{source_note}")
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
            position_values = []
            # Reuse position metadata already present in the top-player
            # response.  Do not issue an additional /players/{id} request for
            # every candidate: that was the source of runaway ticket usage.
            for source in (candidate, item):
                for key in ("position", "positionName", "positionCode", "positions"):
                    value = source.get(key)
                    if isinstance(value, list):
                        position_values.extend(str(part) for part in value)
                    elif value is not None:
                        position_values.append(str(value))
            players[str(identifier)] = {
                "id": identifier,
                "name": str(name),
                "team_name": str(candidate.get("teamName") or item.get("teamName") or ""),
                "positions": position_values,
            }
    return players


def is_target_position(values: Iterable[str]) -> bool:
    values = list(values)
    if not values:
        return False
    text = " ".join(values).lower()
    codes = set(re.findall(r"\b[a-z]{1,}\b", text))
    # SportsAPI's Top Players route exposes only F/M/D/G.  `M` includes the
    # requested wingers and attacking midfielders (for example Lamine Yamal),
    # while the finer FotMob position filter continues to control rankings.
    return any(token in text for token in ATTACKING_POSITION_TOKENS[:-1]) or bool({"f", "m", "st", "cf"} & codes)


def core_activity_points(payload: Any) -> list[tuple[float, float]]:
    """Keep only repeated 5x5m activity cells; discard one-off noise points."""
    points: list[tuple[float, float]] = []
    # The API payload is nested dictionaries, while the static visual cache is
    # a compact ``[[x, y], ...]`` list.  Supporting both lets the no-API
    # backfill reproduce the same activity rules from already saved sessions.
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                x, y = as_number(item[0]), as_number(item[1])
                if x is not None and y is not None and 0 <= x <= 100 and 0 <= y <= 100:
                    points.append((x, y))
    for item in walk_dicts(payload):
        x, y = as_number(item.get("x")), as_number(item.get("y"))
        if x is not None and y is not None and 0 <= x <= 100 and 0 <= y <= 100:
            points.append((x, y))
    cell_counts = Counter((int(x // ACTIVITY_GRID_SIZE), int(y // ACTIVITY_GRID_SIZE)) for x, y in points)
    return [
        (x, y) for x, y in points
        if cell_counts[(int(x // ACTIVITY_GRID_SIZE), int(y // ACTIVITY_GRID_SIZE))] >= MIN_CELL_OVERLAP
    ]


def _convex_hull_area(points: list[tuple[float, float]]) -> float:
    """Return the area covered by a point cloud's convex hull in pitch units."""
    unique = sorted(set(points))
    if len(unique) < 3:
        return 0.0

    def cross(origin: tuple[float, float], left: tuple[float, float], right: tuple[float, float]) -> float:
        return (left[0] - origin[0]) * (right[1] - origin[1]) - (left[1] - origin[1]) * (right[0] - origin[0])

    lower: list[tuple[float, float]] = []
    for point in unique:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper: list[tuple[float, float]] = []
    for point in reversed(unique):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    hull = lower[:-1] + upper[:-1]
    return abs(sum(
        hull[index][0] * hull[(index + 1) % len(hull)][1]
        - hull[index][1] * hull[(index + 1) % len(hull)][0]
        for index in range(len(hull))
    )) / 2.0


def spatial_metrics(points: list[tuple[float, float]]) -> dict[str, float]:
    """Derive S.P.E.A.R. 2.0 spatial features from repeated activity points.

    Heatmap coordinates represent activity, not shots.  The micro-zone values
    therefore measure *where a player operates inside the box* and are later
    combined with FotMob's shot-derived finishing metric; they do not pretend
    to be shot-location percentages on their own.
    """
    empty = {
        "cca_area_pct": 0.0,
        "lane_1_ratio": 0.0, "lane_2_ratio": 0.0, "lane_3_ratio": 0.0,
        "lane_4_ratio": 0.0, "lane_5_ratio": 0.0,
        "danger_zone_density": 0.0,
        "box_six_yard_ratio": 0.0, "box_penalty_spot_ratio": 0.0,
        "box_wide_ratio": 0.0, "deep_box_zone_score": 0.0,
    }
    if not points:
        return empty

    # CCA: retain the densest cells until they contain the core 50% of the
    # repeated activity population, then calculate their convex-hull area.
    cell_counts = Counter((int(x // ACTIVITY_GRID_SIZE), int(y // ACTIVITY_GRID_SIZE)) for x, y in points)
    core_target = len(points) * CORE_COVERAGE_SHARE
    selected_cells: set[tuple[int, int]] = set()
    selected_count = 0
    for cell, count in sorted(cell_counts.items(), key=lambda item: (-item[1], item[0])):
        selected_cells.add(cell)
        selected_count += count
        if selected_count >= core_target:
            break
    core_points = [
        point for point in points
        if (int(point[0] // ACTIVITY_GRID_SIZE), int(point[1] // ACTIVITY_GRID_SIZE)) in selected_cells
    ]
    empty["cca_area_pct"] = round(min(100.0, _convex_hull_area(core_points) / PITCH_AREA * 100.0), 2)

    total = float(len(points))
    lane_counts = [0, 0, 0, 0, 0]
    # Provider attacking orientation: y=0 is the player's right touchline
    # (screen top in the app), and y=100 is the left touchline. Keep the raw
    # Lane 1..5 keys stable; the UI owns the human-readable flank labels.
    for _, y in points:
        lane_counts[min(4, int(y // 20.0))] += 1
    for index, count in enumerate(lane_counts, start=1):
        empty[f"lane_{index}_ratio"] = round(count / total * 100.0, 2)

    # Zone 14 and the two advanced half-spaces are the dangerous central
    # channels.  This remains an activity-density signal, not a progression
    # event count.
    danger_points = [
        (x, y) for x, y in points
        if x >= 66.0 and 20.0 <= y <= 80.0
    ]
    empty["danger_zone_density"] = round(len(danger_points) / total * 100.0, 2)

    box_points = [(x, y) for x, y in points if x >= 83.0 and 21.1 <= y <= 78.9]
    if box_points:
        box_total = float(len(box_points))
        six_yard = sum(x >= 94.0 and 36.8 <= y <= 63.2 for x, y in box_points)
        # Keep the three zones exhaustive and mutually exclusive.  The whole
        # central corridor is Silver; only the lateral sides of the box are
        # Bronze.  Treating x=83..88 central activity as a Bronze residual
        # falsely labelled central strikers as wide-box players.
        central_box = sum(83.0 <= x < 94.0 and 36.8 <= y <= 63.2 for x, y in box_points)
        empty["box_six_yard_ratio"] = round(six_yard / box_total * 100.0, 2)
        empty["box_penalty_spot_ratio"] = round(central_box / box_total * 100.0, 2)
        empty["box_wide_ratio"] = round((box_total - six_yard - central_box) / box_total * 100.0, 2)
        # Gold (six-yard), Silver (central box), Bronze (wide box).  This
        # activity-location score remains distinct from shot quality and is
        # combined with FotMob's in-box finishing only at ranking time.
        # Normalise by the Gold weight so a pure 6-yard profile remains 100,
        # while Silver and Bronze profiles receive 66.7 and 33.3 respectively.
        empty["deep_box_zone_score"] = round(
            ((empty["box_six_yard_ratio"] * GOLD_ZONE_WEIGHT)
            + (empty["box_penalty_spot_ratio"] * SILVER_ZONE_WEIGHT)
            + (empty["box_wide_ratio"] * BRONZE_ZONE_WEIGHT)) / GOLD_ZONE_WEIGHT,
            2,
        )
    return empty


def heat_ratio(payload: Any) -> tuple[int, int, int, int] | None:
    """Return 3-Zone ratios from repeated (not one-off) activity cells only."""
    points = core_activity_points(payload)
    in_box = sum(x >= 83 and 21.1 <= y <= 78.9 for x, y in points)
    out_box_final = sum(x >= 66 and not (x >= 83 and 21.1 <= y <= 78.9) for x, y in points)
    mid = sum(33 <= x < 66 for x, _ in points)
    total = in_box + out_box_final + mid
    if total == 0:
        return None
    raw = [in_box * 100 / total, out_box_final * 100 / total, mid * 100 / total]
    rounded = [int(value) for value in raw]
    for index in sorted(range(3), key=lambda item: raw[item] - rounded[item], reverse=True)[:100 - sum(rounded)]:
        rounded[index] += 1
    return rounded[0], rounded[1], rounded[2], total


def heatmap_visual_points(payload: Any, limit: int = 180) -> list[list[float]]:
    """Visualise the same repeated-activity population used by 3-Zone ratios."""
    points = [[round(x, 2), round(y, 2)] for x, y in core_activity_points(payload)]
    if len(points) <= limit:
        return points
    stride = len(points) / limit
    return [points[int(index * stride)] for index in range(limit)]


def read_fotmob_map(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8", newline="") as source:
        return {row["sportsapi_player_id"].strip(): row["fotmob_player_id"].strip() for row in csv.DictReader(source) if row.get("sportsapi_player_id") and row.get("fotmob_player_id")}


def _normalise_name(value: str) -> str:
    """Compare names across providers without losing accented letters.

    SportsAPI commonly supplies the native spelling (for example ``Dženan
    Pejčinović``), while FotMob's search index often uses an ASCII spelling.
    The former ASCII-only expression silently discarded those letters, making
    otherwise unique candidates look different.  Transliterate first, then
    compare the remaining alphanumeric characters.  A few letters do not
    decompose under Unicode normalisation, so handle those explicitly.
    """
    replacements = str.maketrans({
        "ł": "l", "ø": "o", "ß": "ss", "æ": "ae", "œ": "oe",
        "đ": "d", "ð": "d", "þ": "th", "ı": "i",
    })
    ascii_name = unicodedata.normalize("NFKD", value.lower().translate(replacements))
    ascii_name = ascii_name.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]", "", ascii_name)


def resolve_fotmob_id(player_name: str) -> str | None:
    """Auto-map only an unambiguous exact-name match; never guess otherwise."""
    try:
        from fotmob_client import FotMobError, search_players
        target = _normalise_name(player_name)
        # The same player can appear in more than one result group.  Deduplicate
        # by player ID before deciding whether a match is unambiguous.
        matches = {
            candidate.player_id
            for candidate in search_players(player_name)
            if _normalise_name(candidate.name) == target
        }
        return next(iter(matches)) if len(matches) == 1 else None
    except (ImportError, FotMobError):
        return None


def static_cohort_name_map(season_name: str) -> dict[str, str]:
    """Return only unambiguous name → FotMob IDs from the M.E.S.S.I. cohort.

    The cohort is already the authoritative comparison population for a season.
    Prefer it over a live search response, whose similarly named candidates can
    otherwise make a known player look "unmatched" and lose their heatmap.
    """
    try:
        from spear_cohort import load_spear_cohort
        matches: dict[str, set[str]] = {}
        for (_, cohort_season), cohort in load_spear_cohort().items():
            if cohort_season != season_name:
                continue
            for fotmob_id, (player_name, _) in cohort.items():
                matches.setdefault(_normalise_name(player_name), set()).add(str(fotmob_id))
        return {name: next(iter(ids)) for name, ids in matches.items() if len(ids) == 1}
    except (ImportError, OSError, ValueError):
        return {}


def static_cohort_candidates(season_name: str, competition_name: str) -> list[dict[str, str]]:
    """Return static M.E.S.S.I. players eligible for one competition/session.

    ``top-players`` is a useful low-ticket bootstrap but is not a roster: it
    omits legitimate cohort players such as Heung-Min Son.  This reader gives
    the ETL an authoritative, bounded backfill source without widening the
    dashboard's comparison population.
    """
    cohort_competition = COHORT_COMPETITION_NAMES.get(competition_name, competition_name)
    path = DATA_DIR / "spear_cohort.csv"
    if not path.exists():
        return []
    candidates: dict[str, dict[str, str]] = {}
    try:
        with path.open(encoding="utf-8", newline="") as source:
            for row in csv.DictReader(source):
                fotmob_id = str(row.get("player_id", "")).strip()
                if (
                    row.get("season_name") != season_name
                    or row.get("league_name") != cohort_competition
                    or not fotmob_id
                ):
                    continue
                candidates[fotmob_id] = {
                    "fotmob_player_id": fotmob_id,
                    "name": str(row.get("player_name", "")).strip(),
                    "team_name": str(row.get("team_name", "")).strip(),
                }
    except OSError:
        return []
    return list(candidates.values())


def resolve_sportsapi_id(client: SportsApiClient, player_name: str) -> str | None:
    """Resolve one missing static player via the documented V2 search route.

    Only exact transliterated-name matches are accepted.  Ambiguous or absent
    search responses are deliberately left for the unmatched report instead of
    risking a heatmap from a namesake.
    """
    target = _normalise_name(player_name)
    if not target:
        return None
    try:
        payload = client.get(f"search?q={quote(player_name)}", "player")
    except (HTTPError, URLError, TimeoutError):
        return None
    matches: set[str] = set()
    for item in walk_dicts(payload):
        candidates: list[dict[str, Any]] = []
        nested = item.get("player") if isinstance(item, dict) else None
        if isinstance(nested, dict):
            candidates.append(nested)
        if isinstance(item, dict):
            item_type = str(item.get("type") or item.get("entityType") or "").lower()
            if item_type in {"player", "athlete"} or any(
                key in item for key in ("position", "positionName", "positionCode")
            ):
                candidates.append(item)
        for candidate in candidates:
            identifier = candidate.get("id")
            name = candidate.get("name")
            if identifier is not None and name and _normalise_name(str(name)) == target:
                matches.add(str(identifier))
    return next(iter(matches)) if len(matches) == 1 else None


OUTPUT_FIELDS = ["fotmob_player_id", "sportsapi_player_id", "player_name", "team_name", "competition_name", "season_name", "tournament_id", "season_id", "heatmap_key", "activity_filter", "in_box_ratio", "out_box_final_ratio", "mid_third_ratio", "final_third_ratio", "cca_area_pct", "lane_1_ratio", "lane_2_ratio", "lane_3_ratio", "lane_4_ratio", "lane_5_ratio", "danger_zone_density", "box_six_yard_ratio", "box_penalty_spot_ratio", "box_wide_ratio", "deep_box_zone_score", "sample_points", "generated_at"]
MISSING_SESSION_FIELDS = [
    "fotmob_player_id", "player_name", "team_name", "competition_name",
    "season_name", "reason",
]


def missing_static_cohort_sessions(
    output: list[dict[str, Any]], cohort_rows: list[dict[str, str]] | None = None,
    visual_points: dict[str, list[list[float]]] | None = None,
) -> list[dict[str, str]]:
    """List every static comparison session without a stored heatmap.

    The former unmatched report only described the last ETL invocation and
    therefore hid missing players from other seasons.  This audit is rebuilt
    from the authoritative S.P.E.A.R. snapshot on every checkpoint, so it
    always describes the complete live-data gap.
    """
    if cohort_rows is None:
        path = DATA_DIR / "spear_cohort.csv"
        if not path.exists():
            return []
        try:
            with path.open(encoding="utf-8", newline="") as source:
                cohort_rows = list(csv.DictReader(source))
        except OSError:
            return []

    session_rows = {
        (
            str(row.get("fotmob_player_id", "")).strip(),
            str(row.get("competition_name", "")).strip(),
            str(row.get("season_name", "")).strip(),
        ): row
        for row in output
        if row.get("fotmob_player_id")
    }
    completed = {
        key
        for key, row in session_rows.items()
        if row.get("heatmap_key")
        and (
            visual_points is None
            or bool(visual_points.get(str(row.get("heatmap_key", ""))))
        )
    }
    missing: list[dict[str, str]] = []
    for row in cohort_rows:
        competition_name = next(
            (
                tactical_name
                for tactical_name, cohort_name in COHORT_COMPETITION_NAMES.items()
                if cohort_name == str(row.get("league_name", "")).strip()
            ),
            str(row.get("league_name", "")).strip(),
        )
        key = (
            str(row.get("player_id", "")).strip(),
            competition_name,
            str(row.get("season_name", "")).strip(),
        )
        if not key[0] or key in completed:
            continue
        reason = (
            "missing_heatmap_points"
            if key in session_rows
            else "missing_heatmap_session"
        )
        missing.append({
            "fotmob_player_id": key[0],
            "player_name": str(row.get("player_name", "")).strip(),
            "team_name": str(row.get("team_name", "")).strip(),
            "competition_name": competition_name,
            "season_name": key[2],
            "reason": reason,
        })
    return sorted(
        missing,
        key=lambda row: (
            row["season_name"], row["competition_name"], row["player_name"],
            row["fotmob_player_id"],
        ),
    )


def read_checkpoint(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as source:
        return [row for row in csv.DictReader(source) if row.get("sportsapi_player_id") and row.get("tournament_id") and row.get("season_id")]


def enrich_checkpoint_spatial_metrics(
    rows: list[dict[str, Any]], visual_points: dict[str, list[list[float]]],
) -> None:
    """Backfill S.P.E.A.R. 2.0 columns from the stored visual point sample.

    Existing season rows are checkpointed so an ETL refresh must not re-request
    every historical heatmap merely to add derived columns.  New rows use the
    full response above; legacy rows use their evenly sampled persisted points,
    which preserves the same spatial distribution without consuming tickets.
    """
    for row in rows:
        if row.get("cca_area_pct") not in (None, ""):
            continue
        raw_points = visual_points.get(str(row.get("heatmap_key", "")), [])
        points = [
            (float(point[0]), float(point[1]))
            for point in raw_points
            if isinstance(point, list) and len(point) == 2
            and as_number(point[0]) is not None and as_number(point[1]) is not None
        ]
        row.update(spatial_metrics(points))


def write_outputs(output: list[dict[str, Any]], unmatched: list[dict[str, Any]], auto_mapped: list[dict[str, Any]], visual_points: dict[str, list[list[float]]]) -> None:
    with (DATA_DIR / "tactical_3zone_ratio.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=OUTPUT_FIELDS)
        writer.writeheader(); writer.writerows(output)
    with (DATA_DIR / "unmatched_sportsapi_players.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["sportsapi_player_id", "name", "team_name"], extrasaction="ignore")
        writer.writeheader(); writer.writerows(unmatched)
    with (DATA_DIR / "auto_matched_fotmob_players.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=["sportsapi_player_id", "fotmob_player_id", "name", "team_name"], extrasaction="ignore")
        writer.writeheader(); writer.writerows(auto_mapped)
    with (DATA_DIR / "missing_tactical_sessions.csv").open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=MISSING_SESSION_FIELDS)
        writer.writeheader(); writer.writerows(
            missing_static_cohort_sessions(output, visual_points=visual_points)
        )
    with (DATA_DIR / "tactical_heatmap_points.json").open("w", encoding="utf-8") as target:
        json.dump(visual_points, target, ensure_ascii=False, separators=(",", ":"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season-name", required=True, help='display label, e.g. "2025/2026"')
    parser.add_argument(
        "--competitions", nargs="+", choices=REQUIRED_HEATMAP_COMPETITIONS,
        help="Optional dynamically-discovered competition labels to refresh. Defaults to all required competitions.",
    )
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
    cohort_name_map = static_cohort_name_map(args.season_name)
    output_path = DATA_DIR / "tactical_3zone_ratio.csv"
    # A legacy two-zone row cannot be a valid checkpoint for the new schema.
    # The first 3-Zone refresh must re-read each eligible heatmap once.
    output = read_checkpoint(output_path)
    point_path = DATA_DIR / "tactical_heatmap_points.json"
    try:
        visual_points = json.loads(point_path.read_text(encoding="utf-8")) if point_path.exists() else {}
    except (OSError, ValueError):
        visual_points = {}
    if not visual_points or any(row.get("activity_filter") != ACTIVITY_FILTER_VERSION for row in output):
        output = []
        visual_points = {}
    enrich_checkpoint_spatial_metrics(output, visual_points)
    completed = {(row["sportsapi_player_id"], row["tournament_id"], row["season_id"]) for row in output if str(row.get("heatmap_key", "")) in visual_points}
    completed_fotmob = {
        (str(row.get("fotmob_player_id", "")), str(row.get("tournament_id", "")), str(row.get("season_id", "")))
        for row in output
        if str(row.get("fotmob_player_id", "")) and str(row.get("heatmap_key", "")) in visual_points
    }
    known_sports_ids: dict[str, set[str]] = {}
    for row in output:
        fotmob_id = str(row.get("fotmob_player_id", "")).strip()
        sports_id = str(row.get("sportsapi_player_id", "")).strip()
        if fotmob_id and sports_id:
            known_sports_ids.setdefault(fotmob_id, set()).add(sports_id)
    unmatched, auto_mapped = [], []
    discovered = {item["name"]: item for item in discover_tournaments(client)}
    requested_competitions = tuple(args.competitions or REQUIRED_HEATMAP_COMPETITIONS)
    missing_competitions = [name for name in requested_competitions if name not in discovered]
    if missing_competitions:
        raise SystemExit(
            "Incomplete SportsAPI tournament discovery; no data was refreshed for "
            f"{args.season_name}. Missing: {', '.join(missing_competitions)}"
        )

    for competition_name in requested_competitions:
        tournament = discovered[competition_name]
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
        players = discover_players(ranking)
        counts = {"top_players": len(players), "with_embedded_position": 0, "eligible_positions": 0, "heatmaps_with_ratio": 0, "mapped": 0, "unmatched": 0, "cohort_backfill_candidates": 0, "cohort_backfilled": 0}
        position_labels: Counter[str] = Counter()
        for sports_id, player in players.items():
            checkpoint_key = (sports_id, str(tournament["id"]), str(season_id))
            if checkpoint_key in completed:
                continue
            if player["positions"]:
                counts["with_embedded_position"] += 1
                position_labels.update(player["positions"])
            if not is_target_position(player["positions"]):
                continue
            try:
                counts["eligible_positions"] += 1
                heatmap = client.get(f"players/{sports_id}/tournament/{tournament['id']}/season/{season_id}/heatmap?type=overall", "player")
                ratios = heat_ratio(heatmap)
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue
            if ratios is None:
                continue
            counts["heatmaps_with_ratio"] += 1
            fotmob_id = (
                id_map.get(sports_id)
                or cohort_name_map.get(_normalise_name(player["name"]))
                or resolve_fotmob_id(player["name"])
            )
            if not fotmob_id:
                unmatched.append({"sportsapi_player_id": sports_id, **player})
                counts["unmatched"] += 1
                continue
            if sports_id not in id_map:
                auto_mapped.append({"sportsapi_player_id": sports_id, "fotmob_player_id": fotmob_id, **player})
            in_box, out_box_final, mid, samples = ratios
            space = spatial_metrics(core_activity_points(heatmap))
            heatmap_key = f"{fotmob_id}:{tournament['id']}:{season_id}"
            visual_points[heatmap_key] = heatmap_visual_points(heatmap)
            output.append({
                "fotmob_player_id": fotmob_id, "sportsapi_player_id": sports_id,
                "player_name": player["name"], "team_name": player["team_name"],
                "competition_name": tournament["name"], "season_name": args.season_name,
                "tournament_id": tournament["id"], "season_id": season_id, "heatmap_key": heatmap_key,
                "activity_filter": ACTIVITY_FILTER_VERSION,
                "in_box_ratio": in_box, "out_box_final_ratio": out_box_final,
                "mid_third_ratio": mid, "final_third_ratio": in_box + out_box_final,
                **space,
                "sample_points": samples, "generated_at": datetime.now(timezone.utc).isoformat(),
            })
            completed_fotmob.add((str(fotmob_id), str(tournament["id"]), str(season_id)))
            known_sports_ids.setdefault(str(fotmob_id), set()).add(str(sports_id))
            counts["mapped"] += 1

        # Top-player rankings are not a complete roster.  Backfill only the
        # static M.E.S.S.I. cohort members that still lack this exact
        # tournament/season session.  This is deliberately idempotent: every
        # successfully stored player is skipped on the next workflow run.
        candidates = static_cohort_candidates(args.season_name, competition_name)
        counts["cohort_backfill_candidates"] = len(candidates)
        for candidate in candidates:
            fotmob_id = candidate["fotmob_player_id"]
            fotmob_checkpoint = (fotmob_id, str(tournament["id"]), str(season_id))
            if fotmob_checkpoint in completed_fotmob:
                continue
            known_ids = known_sports_ids.get(fotmob_id, set())
            sports_id = next(iter(known_ids)) if len(known_ids) == 1 else None
            if not sports_id:
                sports_id = resolve_sportsapi_id(client, candidate["name"])
            if not sports_id:
                unmatched.append({"sportsapi_player_id": "", "name": candidate["name"], "team_name": candidate["team_name"]})
                counts["unmatched"] += 1
                continue
            checkpoint_key = (sports_id, str(tournament["id"]), str(season_id))
            if checkpoint_key in completed:
                continue
            try:
                heatmap = client.get(f"players/{sports_id}/tournament/{tournament['id']}/season/{season_id}/heatmap?type=overall", "player")
                ratios = heat_ratio(heatmap)
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue
            if ratios is None:
                continue
            in_box, out_box_final, mid, samples = ratios
            space = spatial_metrics(core_activity_points(heatmap))
            heatmap_key = f"{fotmob_id}:{tournament['id']}:{season_id}"
            visual_points[heatmap_key] = heatmap_visual_points(heatmap)
            output.append({
                "fotmob_player_id": fotmob_id, "sportsapi_player_id": sports_id,
                "player_name": candidate["name"], "team_name": candidate["team_name"],
                "competition_name": tournament["name"], "season_name": args.season_name,
                "tournament_id": tournament["id"], "season_id": season_id, "heatmap_key": heatmap_key,
                "activity_filter": ACTIVITY_FILTER_VERSION,
                "in_box_ratio": in_box, "out_box_final_ratio": out_box_final,
                "mid_third_ratio": mid, "final_third_ratio": in_box + out_box_final,
                **space,
                "sample_points": samples, "generated_at": datetime.now(timezone.utc).isoformat(),
            })
            completed.add(checkpoint_key)
            completed_fotmob.add(fotmob_checkpoint)
            known_sports_ids.setdefault(fotmob_id, set()).add(sports_id)
            counts["cohort_backfilled"] += 1
        # A successful league survives a later rate-limit/network failure.
        write_outputs(output, unmatched, auto_mapped, visual_points)
        print(f"{tournament['name']} pipeline counts: {counts}")
        # Bounded, non-identifying diagnostics for API position-code mapping.
        print(f"{tournament['name']} position labels: {position_labels.most_common(12)}")
    write_outputs(output, unmatched, auto_mapped, visual_points)
    print(f"Wrote {len(output)} matched ratios ({len(auto_mapped)} auto-mapped) and {len(unmatched)} unmatched players.")


if __name__ == "__main__":
    main()
