"""Static Heat Ratio data access shared by ranking and Streamlit layers."""

from __future__ import annotations

import csv
import functools
import json
import re
from pathlib import Path
from typing import Optional

from positional_grid import POSITIONAL_CELL_FIELDS, POSITIONAL_DEPTH_FIELDS, positional_grid_metrics
from true_core import true_core_zones, true_core_zones_from_points
from continuous_core import continuous_core_summary


DATA_DIR = Path(__file__).with_name("data")
THREE_ZONE_DATA_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
LEGACY_DATA_PATH = DATA_DIR / "tactical_ratio.csv"
HEATMAP_POINTS_PATH = DATA_DIR / "tactical_heatmap_points.json"
TOURNAMENT_NAMES = {
    "17": "Premier League", "8": "LaLiga", "35": "Bundesliga",
    "23": "Serie A", "34": "Ligue 1", "40": "First Division A",
}
SPATIAL_FIELDS = (
    "cca_area_pct",
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
    continuous = continuous_core_summary(points) if points else None
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


@functools.lru_cache(maxsize=1)
def load_tactical_ratios() -> dict[str, dict[str, float]]:
    """Read 3-Zone ETL output, falling back to the legacy two-zone CSV."""
    data_path = THREE_ZONE_DATA_PATH if THREE_ZONE_DATA_PATH.exists() else LEGACY_DATA_PATH
    if not data_path.exists():
        return {}
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


def get_tactical_ratio(player_id: str | int) -> Optional[dict[str, float]]:
    matches = [row for row in load_tactical_ratios().values() if str(row.get("fotmob_player_id")) == str(player_id)]
    return _with_current_spatial_definition(matches[0]) if matches else None


def get_tactical_ratio_by_name(player_name: str) -> Optional[dict[str, float]]:
    """Use only an unambiguous normalized-name fallback for duplicate search IDs."""
    normalized = re.sub(r"[^a-z0-9]", "", player_name.lower())
    matches = [ratio for ratio in load_tactical_ratios().values() if re.sub(r"[^a-z0-9]", "", str(ratio.get("player_name", "")).lower()) == normalized]
    return _with_current_spatial_definition(matches[0]) if len(matches) == 1 else None


def get_tactical_ratio_for_session(player_id: str | int, competition_name: str, season_label: str) -> Optional[dict[str, float]]:
    """Return one player's one competition-season row; never blend sessions."""
    candidates = [
        row for row in load_tactical_ratios().values()
        if str(row.get("fotmob_player_id")) == str(player_id)
        and _same_competition(row.get("competition_name") or TOURNAMENT_NAMES.get(str(row.get("tournament_id")), ""), competition_name)
        and (not row.get("season_name") or _same_season(row.get("season_name"), season_label))
    ]
    if not candidates:
        return None
    # Historical provider remaps produced two duplicate rows for a handful of
    # identical FotMob sessions. A shared heatmap key proves they represent the
    # same persisted spatial sample, so resolve deterministically instead of
    # hiding the complete player session.
    heatmap_keys = {str(row.get("heatmap_key") or "") for row in candidates}
    return _with_current_spatial_definition(candidates[0]) if len(heatmap_keys) == 1 else None


@functools.lru_cache(maxsize=1)
def load_heatmap_points() -> dict[str, list[list[float]]]:
    try:
        raw = json.loads(HEATMAP_POINTS_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def get_heatmap_points(player_id: str | int, heatmap_key: str | None = None) -> list[list[float]]:
    points = load_heatmap_points().get(heatmap_key or str(player_id), [])
    return points if isinstance(points, list) else []


def passes_final_third_filter(player_id: str | int, minimum_ratio: int) -> bool:
    """Keep legacy behaviour at 0%; require ETL data for any active threshold."""
    ratio = get_tactical_ratio(player_id)
    return minimum_ratio <= 0 or (ratio is not None and ratio["final_third_ratio"] >= minimum_ratio)
