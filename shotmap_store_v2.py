"""Hot-reload-safe access to sharded static shotmap snapshots."""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any


DATA_DIR = Path(__file__).with_name("data")


class ShotmapSnapshotError(RuntimeError):
    """A committed snapshot shard does not satisfy the storage contract."""


def _snapshot_paths() -> tuple[Path, ...]:
    return tuple(sorted(DATA_DIR.glob("tactical_shotmap_points*.json")))


def _snapshot_signature() -> tuple[tuple[str, int, int], ...]:
    """Change whenever a shard is added, replaced, or resized."""
    signature: list[tuple[str, int, int]] = []
    for path in _snapshot_paths():
        try:
            stat = path.stat()
        except OSError:
            continue
        signature.append((path.name, stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


@functools.lru_cache(maxsize=2)
def _load_shotmap_points(
    signature: tuple[tuple[str, int, int], ...],
) -> dict[str, list[Any]]:
    merged: dict[str, list[Any]] = {}
    for name, _, _ in signature:
        try:
            payload = json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ShotmapSnapshotError(f"Could not load shotmap snapshot shard: {name}") from exc
        if not isinstance(payload, dict):
            raise ShotmapSnapshotError(f"Shotmap snapshot shard must contain an object: {name}")
        for key, value in payload.items():
            if not isinstance(value, list):
                raise ShotmapSnapshotError(f"Shotmap snapshot entry must contain an array: {name}:{key}")
            merged[str(key)] = value
    return merged


@functools.lru_cache(maxsize=5)
def _load_shotmap_shard(path_text: str, version: tuple[int, int]) -> dict[str, list[Any]]:
    """Load only one season shard for detail-page traffic.

    A complete five-season merge is useful to offline audits, but a single
    player detail must not deserialize every shot in history on a 512 MB web
    instance. The explicit version keeps deployment/data refresh invalidation
    identical to the merged loader.
    """
    del version
    path = Path(path_text)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ShotmapSnapshotError(f"Could not load shotmap snapshot shard: {path.name}") from exc
    if not isinstance(payload, dict) or any(not isinstance(value, list) for value in payload.values()):
        raise ShotmapSnapshotError(f"Shotmap snapshot shard must contain object keys with arrays: {path.name}")
    return {str(key): value for key, value in payload.items()}


def load_shotmap_points() -> dict[str, list[Any]]:
    return _load_shotmap_points(_snapshot_signature())


def get_shotmap_snapshot(
    heatmap_key: str | None, season: str | None = None,
) -> tuple[bool, list[Any]]:
    """Return snapshot availability and every unmodified source record."""
    if not heatmap_key:
        return False, []
    if season:
        shard = DATA_DIR / f"tactical_shotmap_points_{season.replace('/', '_')}.json"
        try:
            stat = shard.stat()
        except OSError:
            return False, []
        snapshots = _load_shotmap_shard(str(shard), (stat.st_mtime_ns, stat.st_size))
        key = str(heatmap_key)
        return (True, list(snapshots[key])) if key in snapshots else (False, [])
    snapshots = load_shotmap_points()
    key = str(heatmap_key)
    if key not in snapshots:
        return False, []
    return True, list(snapshots[key])


def get_shotmap_points(heatmap_key: str | None, season: str | None = None) -> list[dict[str, Any]]:
    _, shots = get_shotmap_snapshot(heatmap_key, season)
    return [shot for shot in shots if isinstance(shot, dict)] if isinstance(shots, list) else []


def has_shotmap_snapshot(heatmap_key: str | None) -> bool:
    return bool(heatmap_key) and str(heatmap_key) in load_shotmap_points()
