"""30-zone cumulative-density True Core calculation.

This lives outside ``positional_grid`` so Streamlit hot reloads never try to
import a newly-added symbol from an older cached positional-grid module.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from math import isfinite

from positional_grid import (
    POSITIONAL_CELL_FIELDS,
    POSITIONAL_DEPTH_BOUNDARIES,
    POSITIONAL_LANE_BOUNDARIES,
)


TRUE_CORE_DENSITY_TARGET_PCT = 50.0
POSITIONAL_DISTRIBUTION_TOLERANCE_PCT = 0.25


def _cell_area_pct(depth: int, lane: int) -> float:
    depth_span = POSITIONAL_DEPTH_BOUNDARIES[depth] - POSITIONAL_DEPTH_BOUNDARIES[depth - 1]
    lane_span = POSITIONAL_LANE_BOUNDARIES[lane] - POSITIONAL_LANE_BOUNDARIES[lane - 1]
    return depth_span * lane_span / 100.0


def true_core_zones(occupancy: Mapping[str, object]) -> dict[str, object]:
    """Select the minimum positive 30-zone set reaching 50% activity."""
    missing = [field for field in POSITIONAL_CELL_FIELDS if field not in occupancy]
    if missing:
        raise ValueError(f"positional occupancy is missing {len(missing)} cells")

    parsed: list[tuple[float, int, int]] = []
    for depth in range(1, 7):
        for lane in range(1, 6):
            field = f"grid_d{depth}_l{lane}_ratio"
            raw = occupancy[field]
            if isinstance(raw, bool):
                raise ValueError(f"{field} must be a finite percentage")
            try:
                density = float(raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{field} must be a finite percentage") from exc
            if not isfinite(density) or density < 0.0 or density > 100.0:
                raise ValueError(f"{field} must be between 0 and 100")
            parsed.append((density, depth, lane))

    total = sum(density for density, _, _ in parsed)
    if total == 0.0:
        return {
            "zoneIds": [], "zoneCount": 0, "coreAreaPct": 0.0,
            "achievedDensityPct": 0.0, "zones": [],
        }
    if abs(total - 100.0) > POSITIONAL_DISTRIBUTION_TOLERANCE_PCT:
        raise ValueError(f"positional occupancy must total 100%, got {total:.4f}%")

    positive = sorted(
        ((density / total * 100.0, depth, lane) for density, depth, lane in parsed if density > 0.0),
        key=lambda item: (-item[0], item[1], item[2]),
    )
    zones: list[dict[str, object]] = []
    achieved_density = 0.0
    core_area = 0.0
    for density, depth, lane in positive:
        if achieved_density + 1e-9 >= TRUE_CORE_DENSITY_TARGET_PCT:
            break
        area = _cell_area_pct(depth, lane)
        achieved_density += density
        core_area += area
        zones.append({
            "id": f"depth{depth}_lane{lane}",
            "depth": depth,
            "lane": lane,
            "densityPct": round(density, 4),
            "areaPct": round(area, 4),
        })

    return {
        "zoneIds": [zone["id"] for zone in zones],
        "zoneCount": len(zones),
        "coreAreaPct": round(core_area, 4),
        "achievedDensityPct": round(achieved_density, 4),
        "zones": zones,
    }


def true_core_zones_from_points(points: Iterable[tuple[float, float]]) -> dict[str, object]:
    """Calculate True Core from exact counts before display rounding."""
    counts = {field: 0 for field in POSITIONAL_CELL_FIELDS}

    def segment(value: float, boundaries: tuple[float, ...]) -> int:
        for index, edge in enumerate(boundaries[1:], start=1):
            if value < edge or index == len(boundaries) - 1:
                return index
        raise AssertionError("positional grid must cover the whole pitch")

    total = 0
    for point in points:
        try:
            x, y = float(point[0]), float(point[1])  # type: ignore[index]
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if not (isfinite(x) and isfinite(y) and 0.0 <= x <= 100.0 and 0.0 <= y <= 100.0):
            continue
        depth = segment(x, POSITIONAL_DEPTH_BOUNDARIES)
        lane = segment(y, POSITIONAL_LANE_BOUNDARIES)
        counts[f"grid_d{depth}_l{lane}_ratio"] += 1
        total += 1
    if total == 0:
        return true_core_zones({field: 0.0 for field in POSITIONAL_CELL_FIELDS})
    return true_core_zones({field: count / total * 100.0 for field, count in counts.items()})
