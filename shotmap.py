"""Static per-session shot-coordinate snapshot access."""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any


SHOTMAP_POINTS_PATH = Path(__file__).with_name("data") / "tactical_shotmap_points.json"


@functools.lru_cache(maxsize=1)
def load_shotmap_points() -> dict[str, list[dict[str, Any]]]:
    merged: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(SHOTMAP_POINTS_PATH.parent.glob("tactical_shotmap_points*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(payload, dict):
            merged.update({str(key): value for key, value in payload.items() if isinstance(value, list)})
    return merged


def get_shotmap_points(heatmap_key: str | None) -> list[dict[str, Any]]:
    if not heatmap_key:
        return []
    shots = load_shotmap_points().get(str(heatmap_key), [])
    return [shot for shot in shots if isinstance(shot, dict)] if isinstance(shots, list) else []


def has_shotmap_snapshot(heatmap_key: str | None) -> bool:
    """Distinguish a verified zero-shot session from a missing snapshot."""
    return bool(heatmap_key) and str(heatmap_key) in load_shotmap_points()
