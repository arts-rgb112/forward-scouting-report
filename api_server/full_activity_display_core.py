"""Pure full-source display CCA builder.

The caller supplies the canonical selected mapping/raw list and the already
published full-activity grid.  This module never reads service data, files or
score snapshots, and it refuses to expose CCA unless the independently
reconstructed raw histogram is exactly equal to that existing display grid.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from continuous_core import continuous_core_summary

from api_server.box_subregion_contract import BoxContext
from api_server.full_activity_display_contract import (
    FullActivityDisplayEnvelope,
    FullActivityDisplayHeatmap,
)


_GRID_COLUMNS = 32
_GRID_ROWS = 22
_INPUT_DEFINITION = "sportsapi-data-points-count-expanded-v1"
_HEATMAP_DEFINITION = "full-tier3-count-weighted-histogram-32x22-v1"
_DEFINITION = "full-source-continuous-core-v1"
_FORMULA = "fixed-n60-r20-v2"


def _source_key(mapping: object) -> str:
    if not isinstance(mapping, dict):
        raise ValueError("selected mapping must be an object")
    fields = ("fotmob_player_id", "sportsapi_player_id", "tournament_id", "season_id", "heatmap_key")
    values = {field: mapping.get(field) for field in fields}
    if any(not isinstance(value, str) or not value.isascii() or not value.isdecimal() or value.startswith("0") for field, value in values.items() if field != "heatmap_key"):
        raise ValueError("selected mapping native identity is invalid")
    source_key = f"{values['sportsapi_player_id']}:{values['tournament_id']}:{values['season_id']}"
    expected_map = f"{values['fotmob_player_id']}:{values['tournament_id']}:{values['season_id']}"
    if values["heatmap_key"] != expected_map:
        raise ValueError("selected mapping heatmap key contradicts identity")
    return source_key


def _canonical_revision(sources: list[tuple[object, object]]) -> str | None:
    try:
        encoded = json.dumps(
            [{"mapping": mapping, "raw": raw} for mapping, raw in sources],
            ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        return None
    return hashlib.sha256(encoded).hexdigest()


def _raw_points(raw: object) -> list[tuple[float, float]]:
    if not isinstance(raw, dict):
        raise ValueError("raw heatmap payload is missing")
    data = raw.get("data")
    points = data.get("points") if isinstance(data, dict) else None
    if not isinstance(points, list):
        raise ValueError("raw heatmap payload has no points list")
    expanded: list[tuple[float, float]] = []
    for point in points:
        if not isinstance(point, dict):
            raise ValueError("raw heatmap point is not an object")
        x, y, count = point.get("x"), point.get("y"), point.get("count")
        if (
            isinstance(x, bool) or isinstance(y, bool) or isinstance(count, bool)
            or not isinstance(x, (int, float)) or not isinstance(y, (int, float))
            or not isinstance(count, int) or count <= 0
        ):
            raise ValueError("raw heatmap point coordinate or count is invalid")
        x, y = float(x), float(y)
        if not math.isfinite(x) or not math.isfinite(y) or not (0.0 <= x <= 100.0 and 0.0 <= y <= 100.0):
            raise ValueError("raw heatmap point is outside the normalized pitch")
        # Preserve the provider list order and repeat each positive integer
        # count. This is the exact population consumed by continuous_core.
        expanded.extend([(x, y)] * count)
    return expanded


def _histogram(points: list[tuple[float, float]]) -> list[int]:
    counts = [0] * (_GRID_COLUMNS * _GRID_ROWS)
    for x, y in points:
        column = min(_GRID_COLUMNS - 1, math.floor(x / 100.0 * _GRID_COLUMNS))
        row = min(_GRID_ROWS - 1, math.floor(y / 100.0 * _GRID_ROWS))
        counts[row * _GRID_COLUMNS + column] += 1
    return counts


def _unavailable(
    *, reason: str, coverage: dict[str, list[str]], revision: str | None,
) -> dict[str, Any]:
    return {
        "available": False, "reason": reason,
        "definitionVersion": _DEFINITION, "formulaVersion": _FORMULA,
        "inputDefinition": _INPUT_DEFINITION, "heatmapDefinition": _HEATMAP_DEFINITION,
        "sourceRevision": revision, "coverage": coverage,
        "gridColumns": _GRID_COLUMNS, "gridRows": _GRID_ROWS, "validPointCount": 0,
        "standardizedTarget": None, "densityThreshold": None,
        "thresholdOfPeak": None,
        "coreAreaPct": None, "ccaAreaPct": None, "containedMassPct": None,
        "lowSample": True,
    }


def build_full_activity_display_envelope(
    context: BoxContext,
    selected_sources: list[tuple[object, object]],
    existing_full_heat: object,
) -> FullActivityDisplayEnvelope:
    """Build a display-only CCA envelope from one canonical source selection.

    ``existing_full_heat`` is the pre-existing full-activity heatmap ``data``
    object (or its model dump). It is returned verbatim after strict validation;
    no score/static CCA field is read or substituted.
    """
    if not isinstance(context, BoxContext) or not isinstance(selected_sources, list):
        raise ValueError("strict context and selected raw source list are required")
    full_heat = FullActivityDisplayHeatmap.model_validate(existing_full_heat)
    source_pairs: list[tuple[object, object]] = []
    expected: list[str] = []
    seen = set()
    for source in selected_sources:
        if not isinstance(source, tuple) or len(source) != 2:
            raise ValueError("full activity source entries require mapping and raw payload")
        mapping, raw = source
        key = _source_key(mapping)
        if key in seen:
            raise ValueError("duplicate selected full activity source identity")
        seen.add(key)
        expected.append(key)
        source_pairs.append((mapping, raw))
    revision = _canonical_revision(source_pairs)
    expected = sorted(expected)
    observed: list[str] = []
    missing: list[str] = []
    points: list[tuple[float, float]] = []
    malformed = False
    for mapping, raw in source_pairs:
        key = _source_key(mapping)
        try:
            source_points = _raw_points(raw)
        except ValueError:
            missing.append(key)
            malformed = True
            continue
        observed.append(key)
        points.extend(source_points)
    coverage = {"expectedKeys": expected, "observedKeys": sorted(observed), "missingKeys": sorted(missing)}
    if not full_heat.available:
        cca = _unavailable(reason="full_activity_heatmap_unavailable", coverage=coverage, revision=revision)
    elif not expected:
        cca = _unavailable(reason="full_source_unavailable", coverage=coverage, revision=revision)
    elif malformed or missing:
        cca = _unavailable(reason="full_source_payload_unavailable", coverage=coverage, revision=revision)
    elif revision is None:
        cca = _unavailable(reason="full_source_identity_unavailable", coverage=coverage, revision=None)
    else:
        reconstructed = _histogram(points)
        if reconstructed != full_heat.cellCounts or len(points) != full_heat.validPointCount:
            cca = _unavailable(reason="full_source_grid_mismatch", coverage=coverage, revision=revision)
        else:
            # The exact mapping/raw revision is the display definition's
            # deterministic sampler seed. The raw list order remains part of
            # both that revision and the count-expanded population.
            core = continuous_core_summary(points, heatmap_key=revision)
            cca = {
                "available": True, "reason": None,
                "definitionVersion": _DEFINITION, "formulaVersion": _FORMULA,
                "inputDefinition": _INPUT_DEFINITION, "heatmapDefinition": _HEATMAP_DEFINITION,
                "sourceRevision": revision, "coverage": coverage,
                "gridColumns": _GRID_COLUMNS, "gridRows": _GRID_ROWS,
                "validPointCount": len(points),
                "standardizedTarget": core["standardizedTarget"],
                "densityThreshold": core["densityThreshold"],
                "thresholdOfPeak": core["thresholdOfPeak"],
                "coreAreaPct": core["coreAreaPct"], "ccaAreaPct": core["ccaAreaPct"],
                "containedMassPct": core["containedMassPct"], "lowSample": core["lowSample"],
            }
    return FullActivityDisplayEnvelope(
        schemaVersion="full-activity-display-v1", context=context,
        fullHeat=full_heat, fullSourceCca=cca,
    )
