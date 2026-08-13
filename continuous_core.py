"""Continuous 50% highest-density activity region (HDR).

The positional 30-zone grid remains the tactical reference system.  CCA is a
different question: how much of the pitch is occupied by the densest region
that contains half of the player's observed activity?  This module estimates
that region on the same raster used by the Streamlit heatmap and never fills
the rest of a selected tactical cell.
"""

from __future__ import annotations

from collections.abc import Iterable
from math import isfinite

import numpy as np


CONTINUOUS_CORE_TARGET_PCT = 50.0
CONTINUOUS_CORE_GRID_COLUMNS = 32
CONTINUOUS_CORE_GRID_ROWS = 22
CONTINUOUS_CORE_DEFINITION_VERSION = "continuous-hdr-50-v1"
_SMOOTHING_KERNEL = np.array([1, 4, 6, 4, 1], dtype=float) / 16.0


def _valid_points(points: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    valid: list[tuple[float, float]] = []
    for point in points:
        try:
            x, y = float(point[0]), float(point[1])  # type: ignore[index]
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if isfinite(x) and isfinite(y) and 0.0 <= x <= 100.0 and 0.0 <= y <= 100.0:
            valid.append((x, y))
    return valid


def activity_density_grid(
    points: Iterable[tuple[float, float]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return the deterministic smoothed density raster used by CCA and UI."""
    valid = _valid_points(points)
    density, y_edges, x_edges = np.histogram2d(
        [point[1] for point in valid],
        [point[0] for point in valid],
        bins=(CONTINUOUS_CORE_GRID_ROWS, CONTINUOUS_CORE_GRID_COLUMNS),
        range=((0.0, 100.0), (0.0, 100.0)),
    )
    for axis in (0, 1):
        density = np.apply_along_axis(
            lambda row: np.convolve(
                np.pad(row, 2, mode="edge"), _SMOOTHING_KERNEL, mode="valid"
            ),
            axis,
            density,
        )
    return density, x_edges, y_edges


def continuous_core_from_points(
    points: Iterable[tuple[float, float]],
) -> dict[str, object]:
    """Calculate the 50% HDR area without promoting whole positional zones."""
    density, x_edges, y_edges = activity_density_grid(points)
    total_mass = float(density.sum())
    peak = float(density.max()) if density.size else 0.0
    if total_mass <= 0.0 or peak <= 0.0:
        return {
            "definitionVersion": CONTINUOUS_CORE_DEFINITION_VERSION,
            "targetDensityPct": CONTINUOUS_CORE_TARGET_PCT,
            "achievedDensityPct": 0.0,
            "coreAreaPct": 0.0,
            "densityThreshold": 0.0,
            "thresholdOfPeak": 0.0,
            "gridColumns": CONTINUOUS_CORE_GRID_COLUMNS,
            "gridRows": CONTINUOUS_CORE_GRID_ROWS,
            "density": density,
            "normalizedDensity": density,
            "coreMask": np.zeros_like(density, dtype=bool),
            "xEdges": x_edges,
            "yEdges": y_edges,
        }

    descending = np.sort(density[density > 0.0].ravel())[::-1]
    target_mass = total_mass * CONTINUOUS_CORE_TARGET_PCT / 100.0
    threshold_index = min(
        int(np.searchsorted(np.cumsum(descending), target_mass, side="left")),
        len(descending) - 1,
    )
    threshold = float(descending[threshold_index])
    # Include equal-density raster cells together.  This avoids arbitrary
    # left/right bias when symmetrical high-density islands share a value.
    core_mask = density >= threshold - np.finfo(float).eps * max(1.0, peak)
    achieved = float(density[core_mask].sum() / total_mass * 100.0)
    return {
        "definitionVersion": CONTINUOUS_CORE_DEFINITION_VERSION,
        "targetDensityPct": CONTINUOUS_CORE_TARGET_PCT,
        "achievedDensityPct": round(achieved, 4),
        "coreAreaPct": round(float(core_mask.mean() * 100.0), 4),
        "densityThreshold": round(threshold, 8),
        "thresholdOfPeak": round(threshold / peak, 8),
        "gridColumns": CONTINUOUS_CORE_GRID_COLUMNS,
        "gridRows": CONTINUOUS_CORE_GRID_ROWS,
        "density": density,
        "normalizedDensity": density / peak,
        "coreMask": core_mask,
        "xEdges": x_edges,
        "yEdges": y_edges,
    }


def continuous_core_summary(points: Iterable[tuple[float, float]]) -> dict[str, object]:
    """Return the JSON-safe persisted/API subset of the continuous core."""
    core = continuous_core_from_points(points)
    return {
        key: core[key]
        for key in (
            "definitionVersion", "targetDensityPct", "achievedDensityPct",
            "coreAreaPct", "densityThreshold", "thresholdOfPeak",
            "gridColumns", "gridRows",
        )
    }
