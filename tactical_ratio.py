"""Static Heat Ratio data access shared by ranking and Streamlit layers."""

from __future__ import annotations

import csv
import functools
import json
import re
import threading
from pathlib import Path
from typing import Optional

from positional_grid import POSITIONAL_CELL_FIELDS, POSITIONAL_DEPTH_FIELDS, positional_grid_metrics
from true_core import true_core_zones, true_core_zones_from_points
from continuous_core import continuous_core_summary


DATA_DIR = Path(__file__).with_name("data")
THREE_ZONE_DATA_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
LEGACY_DATA_PATH = DATA_DIR / "tactical_ratio.csv"
HEATMAP_POINTS_PATH = DATA_DIR / "tactical_heatmap_points.json"
# A display-only Tier 3 aggregate.  It deliberately does not participate in
# ``tactical_data_version()``: score caches must remain tied to the released
# max-180 spatial snapshot until a separately approved scoring release.
FULL_ACTIVITY_AGGREGATE_PATH = DATA_DIR / "tactical_full_activity_aggregate.json"
TOURNAMENT_NAMES = {
    "17": "Premier League", "8": "LaLiga", "35": "Bundesliga",
    "23": "Serie A", "34": "Ligue 1", "40": "First Division A",
}
SPATIAL_FIELDS = (
    "cca_area_pct",
    # This is the existing fixed-N/max-180 source count that qualified the
    # same static CCA row used by rankings.py.  It is display provenance only;
    # loading it never switches to the separate full Tier 3 aggregate.
    "activity_valid_point_count",
    "lane_1_ratio", "lane_2_ratio", "lane_3_ratio", "lane_4_ratio", "lane_5_ratio",
    "danger_zone_density",
    "box_six_yard_ratio", "box_penalty_spot_ratio", "box_wide_ratio", "deep_box_zone_score",
    *POSITIONAL_DEPTH_FIELDS,
    *POSITIONAL_CELL_FIELDS,
)
def _micro_zone_metrics(points: list[list[float]]) -> dict[str, float] | None:
    """Classify stored box activity using mutually exclusive spatial zones.

    The former Bronze calculation was a residual bucket: it included central
    activity between the box edge and the penalty spot.  That made a player
    who occupied the middle of the box appear to be a wide-box player.  Gold
    is the six-yard box, Silver is the remaining central box corridor, and
    Bronze is now reserved for the actual wide sides of the penalty area.
    """
    parsed_points: list[tuple[float, float]] = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        try:
            parsed_points.append((float(point[0]), float(point[1])))
        except (TypeError, ValueError):
            continue

    box_points = [
        (x, y) for x, y in parsed_points
        if x >= 83.0 and 21.1 <= y <= 78.9
    ]
    if not box_points:
        return None

    total = float(len(box_points))
    central = [(x, y) for x, y in box_points if 36.8 <= y <= 63.2]
    gold = [(x, y) for x, y in central if x >= 94.0]
    # The central corridor from the penalty-area edge to the six-yard box is
    # one continuous cutback/finishing zone.  It must not be labelled "wide".
    silver = [(x, y) for x, y in central if x < 94.0]
    bronze = [(x, y) for x, y in box_points if not (36.8 <= y <= 63.2)]

    gold_ratio = round(len(gold) / total * 100.0, 2)
    silver_ratio = round(len(silver) / total * 100.0, 2)
    bronze_ratio = round(len(bronze) / total * 100.0, 2)
    return {
        "box_six_yard_ratio": gold_ratio,
        "box_penalty_spot_ratio": silver_ratio,
        "box_wide_ratio": bronze_ratio,
        "deep_box_zone_score": round(
            (gold_ratio * 1.5 + silver_ratio * 1.0 + bronze_ratio * 0.5) / 1.5,
            2,
        ),
    }


def _with_current_micro_zone_definition(ratio: dict[str, float]) -> dict[str, float]:
    """Apply the corrected zone definition to historical static rows too.

    This uses already stored visual points only; it never calls SportsAPI.
    Consequently deployed historical sessions are corrected immediately while
    the next ETL refresh writes the same definition to the CSV.
    """
    points = get_heatmap_points(
        str(ratio.get("fotmob_player_id", "")),
        str(ratio.get("heatmap_key", "")) or None,
    )
    metrics = _micro_zone_metrics(points)
    if not metrics:
        return ratio
    corrected = dict(ratio)
    corrected.update(metrics)
    return corrected


def _with_true_core_definition(ratio: dict[str, float]) -> dict[str, float]:
    """Recalculate every historical CCA from its complete 30-zone density."""
    corrected = dict(ratio)
    points = get_heatmap_points(
        str(ratio.get("fotmob_player_id", "")),
        str(ratio.get("heatmap_key", "")) or None,
    )
    core = true_core_zones_from_points(points) if points else true_core_zones(corrected)
    continuous = continuous_core_summary(
        points, heatmap_key=str(ratio.get("heatmap_key") or "")
    ) if points else None
    if continuous is not None:
        corrected["cca_area_pct"] = float(continuous["coreAreaPct"])
        corrected["continuous_core"] = continuous
    else:
        corrected["cca_area_pct"] = float(core["coreAreaPct"])
    corrected["true_core_zone_ids"] = list(core["zoneIds"])
    corrected["true_core_zone_count"] = int(core["zoneCount"])
    corrected["true_core_density_pct"] = float(core["achievedDensityPct"])
    corrected["true_core_zones"] = list(core["zones"])
    return corrected


def _with_current_spatial_definition(ratio: dict[str, float]) -> dict[str, float]:
    return _with_true_core_definition(_with_current_micro_zone_definition(ratio))


def _normalise(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _same_competition(left: object, right: object) -> bool:
    aliases = {
        "laliga": "laliga", "laligaea": "laliga",
        "primeiraliga": "ligaportugal",
        "ligaportugal": "ligaportugal",
        "firstdivisiona": "belgianproleague",
        "belgianproleague": "belgianproleague",
        "jupilerproleague": "belgianproleague",
        "jupilerleague": "belgianproleague",
        "uefachampionsleague": "championsleague",
        "uefaeuropaleague": "europaleague",
        "uefaeuropaconferenceleague": "europaconferenceleague",
        "uefaconferenceleague": "europaconferenceleague",
        "conferenceleague": "europaconferenceleague",
    }
    left_token = _normalise(left)
    right_token = _normalise(right)
    # FotMob separates the Belgian regular season and post-season groups in
    # player statistics even though SportsAPI supplies one Pro League heatmap
    # session.  Treat those suffixes as the same league; the season remains an
    # independent key, so data cannot leak across campaigns.
    for token_name, token in (("left", left_token), ("right", right_token)):
        if token.startswith("belgianproleagueplayoff"):
            if token_name == "left":
                left_token = "belgianproleague"
            else:
                right_token = "belgianproleague"
    return aliases.get(left_token, left_token) == aliases.get(right_token, right_token)


def _same_season(left: object, right: object) -> bool:
    """Treat UI short seasons (25/26) and ETL seasons (2025/2026) as equal."""
    def canonical(value: object) -> str:
        digits = re.sub(r"\D", "", str(value or ""))
        if len(digits) == 4:
            return f"20{digits[:2]}20{digits[2:]}"
        return digits

    return canonical(left) == canonical(right)


def _file_version(path: Path) -> tuple[int, int] | None:
    """Return a cheap cache key that changes after a deployed data refresh."""
    try:
        stat = path.stat()
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return None


def tactical_data_version() -> tuple[tuple[int, int] | None, tuple[int, int] | None]:
    """Version the ratio and coordinate snapshots used by score caches."""
    data_path = THREE_ZONE_DATA_PATH if THREE_ZONE_DATA_PATH.exists() else LEGACY_DATA_PATH
    return _file_version(data_path), _file_version(HEATMAP_POINTS_PATH)


@functools.lru_cache(maxsize=4)
def _load_tactical_ratios(
    data_path_text: str, _version: tuple[int, int],
) -> dict[str, dict[str, float]]:
    data_path = Path(data_path_text)
    ratios: dict[str, dict[str, float]] = {}
    try:
        with data_path.open(encoding="utf-8", newline="") as source:
            for row in csv.DictReader(source):
                player_id = str(row.get("fotmob_player_id", "")).strip()
                sportsapi_player_id = str(row.get("sportsapi_player_id", "")).strip()
                if not player_id:
                    continue
                mid = float(row["mid_third_ratio"])
                if "in_box_ratio" in row and "out_box_final_ratio" in row:
                    in_box = float(row["in_box_ratio"])
                    out_box = float(row["out_box_final_ratio"])
                    final = in_box + out_box
                    if all(0 <= value <= 100 for value in (mid, in_box, out_box)):
                        ratio_key = f"{player_id}:{row.get('tournament_id', '')}:{row.get('season_id', '')}"
                        ratio = {
                            "fotmob_player_id": player_id,
                            "mid_third_ratio": mid,
                            "in_box_ratio": in_box,
                            "out_box_final_ratio": out_box,
                            "final_third_ratio": final,
                            "sportsapi_player_id": sportsapi_player_id,
                            "player_name": str(row.get("player_name", "")).strip(),
                            "tournament_id": str(row.get("tournament_id", "")).strip(),
                            "season_id": str(row.get("season_id", "")).strip(),
                            "season_name": str(row.get("season_name", "")).strip(),
                            "competition_name": str(row.get("competition_name", "")).strip(),
                            "heatmap_key": str(row.get("heatmap_key", "")).strip() or ratio_key,
                        }
                        for field in SPATIAL_FIELDS:
                            try:
                                value = row.get(field)
                                if value not in (None, ""):
                                    ratio[field] = float(value)
                            except (TypeError, ValueError):
                                continue
                        ratios[ratio_key] = ratio
                else:
                    final = float(row["final_third_ratio"])
                    if 0 <= mid <= 100 and 0 <= final <= 100:
                        ratios[player_id] = {"fotmob_player_id": player_id, "mid_third_ratio": mid, "final_third_ratio": final, "sportsapi_player_id": sportsapi_player_id, "player_name": str(row.get("player_name", "")).strip()}
    except (OSError, KeyError, TypeError, ValueError):
        return {}
    return ratios


def load_tactical_ratios() -> dict[str, dict[str, float]]:
    """Read ETL output and invalidate cache whenever its deployed file changes."""
    data_path = THREE_ZONE_DATA_PATH if THREE_ZONE_DATA_PATH.exists() else LEGACY_DATA_PATH
    version = _file_version(data_path)
    if version is None:
        return {}
    return _load_tactical_ratios(str(data_path), version)


@functools.lru_cache(maxsize=4)
def _tactical_ratios_by_player(
    data_path_text: str, version: tuple[int, int],
) -> dict[str, tuple[dict[str, float], ...]]:
    """Index static tactical rows once instead of scanning every row per player.

    S.P.E.A.R. cohort construction resolves a tactical row for every eligible
    player.  Re-filtering the complete multi-season CSV for each lookup turns a
    cold history request into a quadratic scan and can exceed Render's browser
    request budget.  The index retains the existing session checks below; it
    only narrows each lookup to that player's own rows.
    """
    indexed: dict[str, list[dict[str, float]]] = {}
    for row in _load_tactical_ratios(data_path_text, version).values():
        player_id = str(row.get("fotmob_player_id", "")).strip()
        if player_id:
            indexed.setdefault(player_id, []).append(row)
    return {player_id: tuple(rows) for player_id, rows in indexed.items()}


def _tactical_rows_for_player(player_id: str | int) -> tuple[dict[str, float], ...]:
    data_path = THREE_ZONE_DATA_PATH if THREE_ZONE_DATA_PATH.exists() else LEGACY_DATA_PATH
    version = _file_version(data_path)
    if version is None:
        return ()
    return _tactical_ratios_by_player(str(data_path), version).get(str(player_id), ())


def get_tactical_ratio(player_id: str | int) -> Optional[dict[str, float]]:
    matches = _tactical_rows_for_player(player_id)
    return _with_current_spatial_definition(matches[0]) if matches else None


def get_tactical_ratio_by_name(player_name: str) -> Optional[dict[str, float]]:
    """Use only an unambiguous normalized-name fallback for duplicate search IDs."""
    normalized = re.sub(r"[^a-z0-9]", "", player_name.lower())
    matches = [ratio for ratio in load_tactical_ratios().values() if re.sub(r"[^a-z0-9]", "", str(ratio.get("player_name", "")).lower()) == normalized]
    return _with_current_spatial_definition(matches[0]) if len(matches) == 1 else None


def get_tactical_session_row(player_id: str | int, competition_name: str, season_label: str) -> Optional[dict[str, float]]:
    """Return one raw player competition-season row; never blend sessions.

    Consumers that only need the immutable ``heatmap_key`` (for example the
    final-third shot snapshot companion) must not trigger spatial recalculation
    or read activity coordinates merely to locate that source session.
    """
    candidates = [
        row for row in _tactical_rows_for_player(player_id)
        if _same_competition(row.get("competition_name") or TOURNAMENT_NAMES.get(str(row.get("tournament_id")), ""), competition_name)
        and (not row.get("season_name") or _same_season(row.get("season_name"), season_label))
    ]
    if not candidates:
        return None
    # Historical provider remaps produced two duplicate rows for a handful of
    # identical FotMob sessions. A shared heatmap key proves they represent the
    # same persisted spatial sample, so resolve deterministically instead of
    # hiding the complete player session.
    heatmap_keys = {str(row.get("heatmap_key") or "") for row in candidates}
    return dict(candidates[0]) if len(heatmap_keys) == 1 else None


def get_tactical_ratio_for_session(player_id: str | int, competition_name: str, season_label: str) -> Optional[dict[str, float]]:
    """Return one player's one competition-season spatial row."""
    row = get_tactical_session_row(player_id, competition_name, season_label)
    return _with_current_spatial_definition(row) if row is not None else None


@functools.lru_cache(maxsize=1)
def _load_heatmap_points(
    path_text: str, _version: tuple[int, int],
) -> dict[str, list[list[float]]]:
    try:
        raw = json.loads(Path(path_text).read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def load_heatmap_points() -> dict[str, list[list[float]]]:
    version = _file_version(HEATMAP_POINTS_PATH)
    if version is None:
        return {}
    return _load_heatmap_points(str(HEATMAP_POINTS_PATH), version)


_HEATMAP_INDEX_LOCK = threading.Lock()
_HEATMAP_OFFSET_VERSIONS: dict[tuple[str, tuple[int, int]], dict[str, int]] = {}


def _skip_json_value(data: bytes, start: int) -> int:
    """Return the byte immediately after one JSON array/object value.

    Stored heatmap values are arrays, but handling quoted strings and nested
    JSON containers keeps the offset index safe if a future snapshot includes
    metadata.  This runs once per deployed file version, not once per player.
    """
    if start >= len(data) or data[start] not in (ord("["), ord("{")):
        return start
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(data)):
        byte = data[index]
        if in_string:
            if escaped:
                escaped = False
            elif byte == ord("\\"):
                escaped = True
            elif byte == ord('"'):
                in_string = False
            continue
        if byte == ord('"'):
            in_string = True
        elif byte in (ord("["), ord("{")):
            depth += 1
        elif byte in (ord("]"), ord("}")):
            depth -= 1
            if depth == 0:
                return index + 1
    return start


def _parse_heatmap_value_offsets(data: bytes) -> dict[str, int]:
    """Parse the outer object once and retain only its member offsets."""
    offsets: dict[str, int] = {}
    index = 0
    length = len(data)
    whitespace = b" \t\r\n"
    try:
        while index < length and data[index] in whitespace:
            index += 1
        if index >= length or data[index] != ord("{"):
            return {}
        index += 1
        while index < length:
            while index < length and data[index] in whitespace + b",":
                index += 1
            if index >= length or data[index] == ord("}"):
                break
            if data[index] != ord('"'):
                return {}
            key_start = index
            index += 1
            escaped = False
            while index < length:
                byte = data[index]
                index += 1
                if escaped:
                    escaped = False
                elif byte == ord("\\"):
                    escaped = True
                elif byte == ord('"'):
                    break
            key = json.loads(data[key_start:index].decode("utf-8"))
            while index < length and data[index] in whitespace:
                index += 1
            if index >= length or data[index] != ord(":"):
                return {}
            index += 1
            while index < length and data[index] in whitespace:
                index += 1
            value_start = index
            value_end = _skip_json_value(data, value_start)
            if value_end == value_start:
                return {}
            if isinstance(key, str) and data[value_start] == ord("["):
                offsets[key] = value_start
            index = value_end
    except (UnicodeDecodeError, ValueError):
        return {}
    return offsets


@functools.lru_cache(maxsize=1)
def _heatmap_value_offsets(
    path_text: str, version: tuple[int, int],
) -> dict[str, int]:
    """Build a compact key → byte-offset index for the heatmap snapshot.

    The previous request path streamed the 19.5 MB JSON document from byte
    zero for *every* eligible player during a cold leaderboard build.  That
    made four historical summary requests contend for disk/CPU on Render.
    This index reads the document once per version, retains only key offsets,
    and leaves individual point arrays lazily decoded below.
    """
    cache_key = (path_text, version)
    with _HEATMAP_INDEX_LOCK:
        existing = _HEATMAP_OFFSET_VERSIONS.get(cache_key)
        if existing is not None:
            return existing
        try:
            data = Path(path_text).read_bytes()
        except OSError:
            return {}
        offsets = _parse_heatmap_value_offsets(data)
        # Only one deployed file version is normally live.  Drop obsolete
        # offset maps so a data refresh cannot accumulate process memory.
        _HEATMAP_OFFSET_VERSIONS.clear()
        _HEATMAP_OFFSET_VERSIONS[cache_key] = offsets
        return offsets


def _read_heatmap_array_at_offset(path: Path, offset: int) -> tuple[tuple[float, ...], ...]:
    array = bytearray()
    depth = 0
    in_string = False
    escaped = False
    try:
        with path.open("rb") as handle:
            handle.seek(offset)
            while chunk := handle.read(64 * 1024):
                for byte in chunk:
                    array.append(byte)
                    if in_string:
                        if escaped:
                            escaped = False
                        elif byte == ord("\\"):
                            escaped = True
                        elif byte == ord('"'):
                            in_string = False
                        continue
                    if byte == ord('"'):
                        in_string = True
                    elif byte == ord("["):
                        depth += 1
                    elif byte == ord("]"):
                        depth -= 1
                        if depth == 0:
                            payload = json.loads(array.decode("utf-8"))
                            if not isinstance(payload, list):
                                return ()
                            return tuple(
                                tuple(point) for point in payload
                                if isinstance(point, (list, tuple))
                            )
    except (OSError, UnicodeDecodeError, ValueError):
        return ()
    return ()


@functools.lru_cache(maxsize=256)
def _load_heatmap_points_for_key(
    path_text: str, version: tuple[int, int], heatmap_key: str,
) -> tuple[tuple[float, ...], ...]:
    offset = _heatmap_value_offsets(path_text, version).get(str(heatmap_key))
    if offset is None:
        return ()
    return _read_heatmap_array_at_offset(Path(path_text), offset)


def get_heatmap_points(player_id: str | int, heatmap_key: str | None = None) -> list[list[float]]:
    if heatmap_key:
        version = _file_version(HEATMAP_POINTS_PATH)
        if version is not None:
            points = _load_heatmap_points_for_key(str(HEATMAP_POINTS_PATH), version, str(heatmap_key))
            return [list(point) for point in points]
    points = load_heatmap_points().get(heatmap_key or str(player_id), [])
    return points if isinstance(points, list) else []


@functools.lru_cache(maxsize=4)
def _load_full_activity_contexts(
    path_text: str, version: tuple[int, int],
) -> dict[str, dict[str, object]]:
    """Load the versioned full-source aggregate without touching score inputs."""
    try:
        payload = json.loads(Path(path_text).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    if payload.get("activitySourceDefinitionVersion") != "sportsapi-heatmap-points-count-weighted-full-v1":
        return {}
    contexts = payload.get("contexts")
    if not isinstance(contexts, dict):
        return {}
    return {
        str(key): value for key, value in contexts.items()
        if isinstance(value, dict)
    }


def full_activity_aggregate_version() -> tuple[int, int] | None:
    """A cache input for additive display APIs only, never M.E.S.S.I. scoring."""
    return _file_version(FULL_ACTIVITY_AGGREGATE_PATH)


def get_full_activity_context(heatmap_key: str) -> dict[str, object] | None:
    """Return one exact full-source context, with no max-180 fallback."""
    version = full_activity_aggregate_version()
    if version is None:
        return None
    return _load_full_activity_contexts(
        str(FULL_ACTIVITY_AGGREGATE_PATH), version,
    ).get(str(heatmap_key))


def passes_final_third_filter(
    player_id: str | int,
    minimum_ratio: int,
    competition_name: str,
    season_label: str,
) -> bool:
    """Apply an active filter only to the requested competition-season."""
    if minimum_ratio <= 0:
        return True
    ratio = get_tactical_ratio_for_session(player_id, competition_name, season_label)
    return ratio is not None and ratio["final_third_ratio"] >= minimum_ratio
