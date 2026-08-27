from __future__ import annotations

import csv
import inspect
from pathlib import Path
import random

import numpy as np
import pytest

from continuous_core import (
    CONTINUOUS_CORE_DEFINITION_VERSION,
    _hdr_from_density,
    _inverse_threshold_for_area,
    activity_density_grid,
    continuous_core_from_points,
)
from scripts.backfill_standardized_cca import _activity_spreads, backfill, recalculate_rows
import scripts.backfill_standardized_cca as backfill_module


def _points(count: int) -> list[tuple[float, float]]:
    return [((index * 17) % 101, (index * 29) % 101) for index in range(count)]


def test_fixed_n_cca_is_bitwise_deterministic_and_order_independent() -> None:
    points_by_key = {"a": _points(90), "b": _points(105), "c": _points(65)}

    first = {
        key: continuous_core_from_points(points, heatmap_key=key)
        for key, points in points_by_key.items()
    }
    second = {
        key: continuous_core_from_points(points, heatmap_key=key)
        for key, points in reversed(list(points_by_key.items()))
    }

    assert {
        key: first[key]["standardizedTarget"] for key in first
    } == {
        key: second[key]["standardizedTarget"] for key in second
    }
    assert {
        key: first[key]["coreAreaPct"] for key in first
    } == {
        key: second[key]["coreAreaPct"] for key in second
    }


def test_low_sample_preserves_exact_legacy_all_point_measurement() -> None:
    points = _points(59)
    density, _, _ = activity_density_grid(points)
    _, _, legacy_area, _ = _hdr_from_density(density)

    core = continuous_core_from_points(points, heatmap_key="low-sample")

    assert core["definitionVersion"] == CONTINUOUS_CORE_DEFINITION_VERSION
    assert core["lowSample"] is True
    assert core["validPointCount"] == 59
    assert core["standardizedTarget"] == round(legacy_area, 4)
    assert core["coreAreaPct"] == round(legacy_area, 4)
    assert core["ccaAreaPct"] == core["coreAreaPct"]
    assert core["quantizationDelta"] == 0.0
    assert core["containedMassPct"] == core["achievedDensityPct"]


def test_inverse_contour_uses_all_tied_cells_and_larger_threshold_on_exact_error_tie() -> None:
    density = np.array([[3.0, 3.0, 1.0, 1.0]])

    mask, threshold, area = _inverse_threshold_for_area(density, 37.5)

    assert threshold == 3.0
    assert area == 50.0
    assert mask.tolist() == [[True, True, False, False]]


def test_inverse_contour_area_matches_every_standardized_target_within_half_point() -> None:
    rng = random.Random(7)
    points_by_key = {
        "wide": [(rng.uniform(0, 100), rng.uniform(0, 100)) for _ in range(84)],
        "low": _points(32),
    }
    for key, points in points_by_key.items():
        core = continuous_core_from_points(points, heatmap_key=key)
        assert core["ccaAreaPct"] == core["coreAreaPct"]
        assert core["quantizationDelta"] == round(
            abs(core["ccaAreaPct"] - core["standardizedTarget"]), 4,
        )


def test_offline_backfill_is_partial_key_safe_and_preserves_csv_row_key_count(tmp_path: Path) -> None:
    fieldnames = ["heatmap_key", "cca_area_pct", "activity_filter"]
    rows = [
        {"heatmap_key": "a", "cca_area_pct": "1", "activity_filter": "legacy"},
        {"heatmap_key": "b", "cca_area_pct": "2", "activity_filter": "legacy"},
    ]
    points = {"a": _points(80), "b": _points(90)}

    full, _ = recalculate_rows(rows, points)
    partial, _ = recalculate_rows(rows, points, keys={"a"})
    assert partial[0]["cca_area_pct"] == full[0]["cca_area_pct"]
    assert partial[1] == rows[1]

    ratios = tmp_path / "ratios.csv"
    output = tmp_path / "output.csv"
    with ratios.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    points_path = tmp_path / "points.json"
    points_path.write_text('{"a": [[1, 1]], "b": [[2, 2]]}', encoding="utf-8")

    count, updated = backfill(ratios, points_path, output)
    with output.open(encoding="utf-8", newline="") as handle:
        written = list(csv.DictReader(handle))
    assert (count, updated) == (2, 2)
    assert [row["heatmap_key"] for row in written] == ["a", "b"]
    assert {"activity_spread_x", "activity_spread_y"} <= set(written[0])


def test_activity_spreads_are_population_standard_deviation_of_valid_coordinates() -> None:
    spread_x, spread_y = _activity_spreads([
        [0, 0], [2, 4], [4, 8], ["invalid", 2], [101, 2],
    ])

    assert spread_x == pytest.approx((8 / 3) ** 0.5)
    assert spread_y == pytest.approx((32 / 3) ** 0.5)


def test_offline_backfill_fails_closed_when_static_points_are_missing() -> None:
    with pytest.raises(ValueError, match="heatmap snapshot missing"):
        recalculate_rows(
            [{"heatmap_key": "missing", "cca_area_pct": "1"}], {},
        )


def test_backfill_module_has_no_network_or_sportsapi_builder_dependency() -> None:
    source = inspect.getsource(backfill_module)
    assert "build_tactical_ratios" not in source
    assert "SportsApi" not in source
    assert "urlopen" not in source
