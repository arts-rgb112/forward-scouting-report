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
                        ratios[player_id] = {
                            "mid_third_ratio": mid,
                            "in_box_ratio": in_box,
                            "out_box_final_ratio": out_box,
                            "final_third_ratio": final,
                            "sportsapi_player_id": sportsapi_player_id,
                            "player_name": str(row.get("player_name", "")).strip(),
                        }
                else:
                    final = float(row["final_third_ratio"])
                    if 0 <= mid <= 100 and 0 <= final <= 100:
                        ratios[player_id] = {"mid_third_ratio": mid, "final_third_ratio": final, "sportsapi_player_id": sportsapi_player_id, "player_name": str(row.get("player_name", "")).strip()}
    except (OSError, KeyError, TypeError, ValueError):
        return {}
    return ratios


def get_tactical_ratio(player_id: str | int) -> Optional[dict[str, float]]:
    return load_tactical_ratios().get(str(player_id))


def get_tactical_ratio_by_name(player_name: str) -> Optional[dict[str, float]]:
    """Use only an unambiguous normalized-name fallback for duplicate search IDs."""
    normalized = re.sub(r"[^a-z0-9]", "", player_name.lower())
    matches = [ratio for ratio in load_tactical_ratios().values() if re.sub(r"[^a-z0-9]", "", str(ratio.get("player_name", "")).lower()) == normalized]
    return matches[0] if len(matches) == 1 else None


@functools.lru_cache(maxsize=1)
def load_heatmap_points() -> dict[str, list[list[float]]]:
    try:
        raw = json.loads(HEATMAP_POINTS_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def get_heatmap_points(player_id: str | int) -> list[list[float]]:
    points = load_heatmap_points().get(str(player_id), [])
    return points if isinstance(points, list) else []


def passes_final_third_filter(player_id: str | int, minimum_ratio: int) -> bool:
    """Keep legacy behaviour at 0%; require ETL data for any active threshold."""
    ratio = get_tactical_ratio(player_id)
    return minimum_ratio <= 0 or (ratio is not None and ratio["final_third_ratio"] >= minimum_ratio)
