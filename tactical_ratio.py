"""Static Heat Ratio data access shared by ranking and Streamlit layers."""

from __future__ import annotations

import csv
import functools
import json
import re
from pathlib import Path
from typing import Optional


DATA_DIR = Path(__file__).with_name("data")
THREE_ZONE_DATA_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
LEGACY_DATA_PATH = DATA_DIR / "tactical_ratio.csv"
HEATMAP_POINTS_PATH = DATA_DIR / "tactical_heatmap_points.json"
TOURNAMENT_NAMES = {"17": "Premier League", "8": "LaLiga", "35": "Bundesliga", "23": "Serie A", "34": "Ligue 1"}


def _normalise(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _same_competition(left: object, right: object) -> bool:
    aliases = {"laliga": "laliga", "laligaea": "laliga", "uefachampionsleague": "championsleague"}
    return aliases.get(_normalise(left), _normalise(left)) == aliases.get(_normalise(right), _normalise(right))


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
                        ratios[ratio_key] = {
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
                else:
                    final = float(row["final_third_ratio"])
                    if 0 <= mid <= 100 and 0 <= final <= 100:
                        ratios[player_id] = {"fotmob_player_id": player_id, "mid_third_ratio": mid, "final_third_ratio": final, "sportsapi_player_id": sportsapi_player_id, "player_name": str(row.get("player_name", "")).strip()}
    except (OSError, KeyError, TypeError, ValueError):
        return {}
    return ratios


def get_tactical_ratio(player_id: str | int) -> Optional[dict[str, float]]:
    matches = [row for row in load_tactical_ratios().values() if str(row.get("fotmob_player_id")) == str(player_id)]
    return matches[0] if matches else None


def get_tactical_ratio_by_name(player_name: str) -> Optional[dict[str, float]]:
    """Use only an unambiguous normalized-name fallback for duplicate search IDs."""
    normalized = re.sub(r"[^a-z0-9]", "", player_name.lower())
    matches = [ratio for ratio in load_tactical_ratios().values() if re.sub(r"[^a-z0-9]", "", str(ratio.get("player_name", "")).lower()) == normalized]
    return matches[0] if len(matches) == 1 else None


def get_tactical_ratio_for_session(player_id: str | int, competition_name: str, season_label: str) -> Optional[dict[str, float]]:
    """Return one player's one competition-season row; never blend sessions."""
    candidates = [
        row for row in load_tactical_ratios().values()
        if str(row.get("fotmob_player_id")) == str(player_id)
        and _same_competition(row.get("competition_name") or TOURNAMENT_NAMES.get(str(row.get("tournament_id")), ""), competition_name)
        and (not row.get("season_name") or str(row.get("season_name")) == season_label)
    ]
    return candidates[0] if len(candidates) == 1 else None


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
