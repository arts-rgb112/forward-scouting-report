"""Continuous activity-core analysis used by the legacy spatial pitch.

The positional 30-zone grid remains the tactical reference system.  CCA is a
different question: how much of the pitch is occupied by the densest region
that contains half of the player's observed activity?  This module estimates
that region on the same raster used by the Streamlit heatmap and never fills
the rest of a selected tactical cell.
"""

from __future__ import annotations

from collections.abc import Iterable
import hashlib
from math import isfinite
import random

import numpy as np


CONTINUOUS_CORE_TARGET_PCT = 50.0
CONTINUOUS_CORE_GRID_COLUMNS = 32
CONTINUOUS_CORE_GRID_ROWS = 22
CONTINUOUS_CORE_DEFINITION_VERSION = "fixed-n60-r20-v2"
CONTINUOUS_CORE_BASE_SEED = 20260826
CONTINUOUS_CORE_SAMPLE_SIZE = 60
CONTINUOUS_CORE_RESAMPLES = 20
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
    # Equivalent to the former per-row ``np.apply_along_axis`` convolution,
    # but vectorised: fixed-N/R20 backfill needs 20 rasters per session and
    # must remain practical for all 10,412 static rows.  The grid and kernel
    # themselves remain byte-for-byte the documented 32×22/[1,4,6,4,1] rule.
    for axis in (0, 1):
        pad_width = ((2, 2), (0, 0)) if axis == 0 else ((0, 0), (2, 2))
        padded = np.pad(density, pad_width, mode="edge")
        if axis == 0:
            density = sum(
                weight * padded[index:index + CONTINUOUS_CORE_GRID_ROWS, :]
                for index, weight in enumerate(_SMOOTHING_KERNEL)
            )
        else:
            density = sum(
                weight * padded[:, index:index + CONTINUOUS_CORE_GRID_COLUMNS]
                for index, weight in enumerate(_SMOOTHING_KERNEL)
            )
    return density, x_edges, y_edges


def _hdr_from_density(density: np.ndarray) -> tuple[np.ndarray, float, float, float]:
    """Return the legacy 50%-mass HDR mask and its area/threshold/mass."""
    total_mass = float(density.sum())
    peak = float(density.max()) if density.size else 0.0
    if total_mass <= 0.0 or peak <= 0.0:
        return np.zeros_like(density, dtype=bool), 0.0, 0.0, 0.0
    descending = np.sort(density[density > 0.0].ravel())[::-1]
    target_mass = total_mass * CONTINUOUS_CORE_TARGET_PCT / 100.0
    threshold_index = min(
        int(np.searchsorted(np.cumsum(descending), target_mass, side="left")),
        len(descending) - 1,
    )
    threshold = float(descending[threshold_index])
    core_mask = density >= threshold - np.finfo(float).eps * max(1.0, peak)
    achieved = float(density[core_mask].sum() / total_mass * 100.0)
    return core_mask, threshold, float(core_mask.mean() * 100.0), achieved


def _stable_heatmap_key(valid: list[tuple[float, float]], heatmap_key: str | None) -> str:
    if heatmap_key:
        return str(heatmap_key)
    # V1 app.py does not own a persisted session key.  This fallback preserves
    # deterministic local rendering without affecting scored/API rows, which
    # always pass the authoritative heatmap key below.
    return hashlib.sha256(repr(valid).encode("utf-8")).hexdigest()


def _standardized_area_pct(
    valid: list[tuple[float, float]], heatmap_key: str | None, *,
    full_density: np.ndarray | None = None,
) -> tuple[float, bool]:
    """Measure CCA with the fixed-N60/R20, per-session deterministic rule."""
    density = full_density
    if density is None:
        density, _, _ = activity_density_grid(valid)
    _, _, legacy_area, _ = _hdr_from_density(density)
    if len(valid) < CONTINUOUS_CORE_SAMPLE_SIZE:
        return legacy_area, True
    stable_key = _stable_heatmap_key(valid, heatmap_key)
    seed = int(
        hashlib.sha256(
            f"{CONTINUOUS_CORE_BASE_SEED}:{stable_key}".encode("utf-8")
        ).hexdigest()[:16],
        16,
    )
    rng = random.Random(seed)
    samples: list[float] = []
    for _ in range(CONTINUOUS_CORE_RESAMPLES):
        sampled_density, _, _ = activity_density_grid(
            rng.sample(valid, CONTINUOUS_CORE_SAMPLE_SIZE)
        )
        _, _, area, _ = _hdr_from_density(sampled_density)
        samples.append(area)
    return float(sum(samples) / len(samples)), False


def _inverse_threshold_for_area(
    density: np.ndarray, standardized_area_pct: float,
) -> tuple[np.ndarray, float, float]:
    """Pick the full-density threshold whose tied-cell area best matches target.

    All positive unique candidates are evaluated.  Equal-density cells are
    always included through the same epsilon mask used by the legacy HDR path.
    On equal error, prefer the larger threshold (the smaller area).
    """
    peak = float(density.max()) if density.size else 0.0
    candidates, counts = np.unique(density[density > 0.0], return_counts=True)
    if peak <= 0.0 or not len(candidates):
        return np.zeros_like(density, dtype=bool), 0.0, 0.0
    # ``area(t)`` only changes at one of these values.  Compute the full
    # candidate set from grouped cell counts, then build the selected mask once
    # using the canonical epsilon rule below.  This is mathematically identical
    # to evaluating every ``density >= t`` mask but avoids millions of 32×22
    # allocations during the 10,412-row offline backfill.
    descending_order = np.argsort(candidates)[::-1]
    descending_candidates = candidates[descending_order]
    descending_counts = counts[descending_order]
    areas = np.cumsum(descending_counts, dtype=float) / density.size * 100.0
    errors = np.abs(areas - standardized_area_pct)
    best_error = float(errors.min())
    epsilon = np.finfo(float).eps * max(1.0, peak)
    tied_indexes = np.flatnonzero(errors == best_error)
    # Candidate order is descending, so the first tied threshold is the larger
    # one required by the product tie-break rule.
    selected_index = int(tied_indexes[0])
    best_threshold = float(descending_candidates[selected_index])
    best_mask = density >= best_threshold - epsilon
    best_area = float(best_mask.mean() * 100.0)
    return best_mask, best_threshold, best_area


def continuous_core_from_points(
    points: Iterable[tuple[float, float]],
    *,
    heatmap_key: str | None = None,
) -> dict[str, object]:
    """Calculate the fixed-N standardized CCA and matching full-density contour."""
    valid = _valid_points(points)
    density, x_edges, y_edges = activity_density_grid(valid)
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
            "formulaVersion": CONTINUOUS_CORE_DEFINITION_VERSION,
            "ccaAreaPct": 0.0,
            "standardizedTarget": 0.0,
            "quantizationDelta": 0.0,
            "containedMassPct": 0.0,
            "validPointCount": 0,
            "lowSample": True,
            "density": density,
            "normalizedDensity": density,
            "coreMask": np.zeros_like(density, dtype=bool),
            "xEdges": x_edges,
            "yEdges": y_edges,
        }

    standardized_area, low_sample = _standardized_area_pct(
        valid, heatmap_key, full_density=density,
    )
    core_mask, threshold, core_area = _inverse_threshold_for_area(
        density, standardized_area
    )
    achieved = float(density[core_mask].sum() / total_mass * 100.0)
    return {
        "definitionVersion": CONTINUOUS_CORE_DEFINITION_VERSION,
        "targetDensityPct": CONTINUOUS_CORE_TARGET_PCT,
        "achievedDensityPct": round(achieved, 4),
        "coreAreaPct": round(core_area, 4),
        "densityThreshold": round(threshold, 8),
        "thresholdOfPeak": round(threshold / peak, 8),
        "gridColumns": CONTINUOUS_CORE_GRID_COLUMNS,
        "gridRows": CONTINUOUS_CORE_GRID_ROWS,
        "formulaVersion": CONTINUOUS_CORE_DEFINITION_VERSION,
        # The published CCA is the area the full-density contour actually
        # draws.  The resampled value is an intermediate target only.
        "ccaAreaPct": round(core_area, 4),
        "standardizedTarget": round(standardized_area, 4),
        "quantizationDelta": round(
            abs(round(core_area, 4) - round(standardized_area, 4)), 4,
        ),
        "containedMassPct": round(achieved, 4),
        "validPointCount": len(valid),
        "lowSample": low_sample,
        "density": density,
        "normalizedDensity": density / peak,
        "coreMask": core_mask,
        "xEdges": x_edges,
        "yEdges": y_edges,
    }


def continuous_core_summary(
    points: Iterable[tuple[float, float]], *, heatmap_key: str | None = None,
) -> dict[str, object]:
    """Return the JSON-safe persisted/API subset of the continuous core."""
    core = continuous_core_from_points(points, heatmap_key=heatmap_key)
    return {
        key: core[key]
        for key in (
            "definitionVersion", "targetDensityPct", "achievedDensityPct",
            "coreAreaPct", "densityThreshold", "thresholdOfPeak",
            "gridColumns", "gridRows",
            "formulaVersion", "ccaAreaPct", "standardizedTarget",
            "quantizationDelta", "containedMassPct", "validPointCount",
            "lowSample",
        )
    }
