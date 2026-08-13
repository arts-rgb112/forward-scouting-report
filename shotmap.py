"""Static per-session shot-coordinate snapshot access."""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any


SHOTMAP_POINTS_PATH = Path(__file__).with_name("data") / "tactical_shotmap_points.json"


@functools.lru_cache(maxsize=1)
def load_shotmap_points() -> dict[str, list[dict[str, Any]]]:
    try:
        payload = json.loads(SHOTMAP_POINTS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def get_shotmap_points(heatmap_key: str | None) -> list[dict[str, Any]]:
    if not heatmap_key:
        return []
    shots = load_shotmap_points().get(str(heatmap_key), [])
    return [shot for shot in shots if isinstance(shot, dict)] if isinstance(shots, list) else []
