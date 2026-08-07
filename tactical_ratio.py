"""Static Heat Ratio data access shared by ranking and Streamlit layers."""

from __future__ import annotations

import csv
import functools
from pathlib import Path
from typing import Optional


DATA_DIR = Path(__file__).with_name("data")
THREE_ZONE_DATA_PATH = DATA_DIR / "tactical_3zone_ratio.csv"
LEGACY_DATA_PATH = DATA_DIR / "tactical_ratio.csv"


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
                        }
                else:
                    final = float(row["final_third_ratio"])
                    if 0 <= mid <= 100 and 0 <= final <= 100:
                        ratios[player_id] = {"mid_third_ratio": mid, "final_third_ratio": final, "sportsapi_player_id": sportsapi_player_id}
    except (OSError, KeyError, TypeError, ValueError):
        return {}
    return ratios


def get_tactical_ratio(player_id: str | int) -> Optional[dict[str, float]]:
    return load_tactical_ratios().get(str(player_id))


def passes_final_third_filter(player_id: str | int, minimum_ratio: int) -> bool:
    """Keep legacy behaviour at 0%; require ETL data for any active threshold."""
    ratio = get_tactical_ratio(player_id)
    return minimum_ratio <= 0 or (ratio is not None and ratio["final_third_ratio"] >= minimum_ratio)
