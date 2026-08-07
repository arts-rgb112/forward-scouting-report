"""Static Heat Ratio data access shared by ranking and Streamlit layers."""

from __future__ import annotations

import csv
import functools
from pathlib import Path
from typing import Optional


DATA_PATH = Path(__file__).with_name("data") / "tactical_ratio.csv"


@functools.lru_cache(maxsize=1)
def load_tactical_ratios() -> dict[str, dict[str, float]]:
    """Read ETL output keyed by the FotMob player ID used by this dashboard."""
    if not DATA_PATH.exists():
        return {}
    ratios: dict[str, dict[str, float]] = {}
    try:
        with DATA_PATH.open(encoding="utf-8", newline="") as source:
            for row in csv.DictReader(source):
                player_id = str(row.get("fotmob_player_id", "")).strip()
                if not player_id:
                    continue
                mid = float(row["mid_third_ratio"])
                final = float(row["final_third_ratio"])
                if 0 <= mid <= 100 and 0 <= final <= 100:
                    ratios[player_id] = {"mid_third_ratio": mid, "final_third_ratio": final}
    except (OSError, KeyError, TypeError, ValueError):
        return {}
    return ratios


def get_tactical_ratio(player_id: str | int) -> Optional[dict[str, float]]:
    return load_tactical_ratios().get(str(player_id))


def passes_final_third_filter(player_id: str | int, minimum_ratio: int) -> bool:
    """Keep legacy behaviour at 0%; require ETL data for any active threshold."""
    ratio = get_tactical_ratio(player_id)
    return minimum_ratio <= 0 or (ratio is not None and ratio["final_third_ratio"] >= minimum_ratio)
