"""Shared positional-grid contract for ETL, API, and Streamlit rendering.

The boundaries reproduce the supplied 6-depth × 5-lane pitch image.  The
coordinate system remains the provider's normalised pitch: x increases toward
the attacking goal and y=0 is the player's right touchline.
"""

from __future__ import annotations

from collections.abc import Iterable


POSITIONAL_DEPTH_BOUNDARIES = (0.0, 16.67, 33.33, 50.0, 66.67, 83.33, 100.0)
POSITIONAL_LANE_BOUNDARIES = (0.0, 21.82, 37.0, 63.0, 78.18, 100.0)
POSITIONAL_DEPTH_FIELDS = tuple(f"depth_{index}_ratio" for index in range(1, 7))
POSITIONAL_CELL_FIELDS = tuple(
    f"grid_d{depth}_l{lane}_ratio"
    for depth in range(1, 7)
    for lane in range(1, 6)
)


def positional_grid_metrics(points: Iterable[tuple[float, float]]) -> dict[str, float]:
    """Return exact depth, lane, and 30-cell occupancy percentages."""
    values: list[tuple[float, float]] = []
    for point in points:
        try:
            x, y = float(point[0]), float(point[1])  # type: ignore[index]
        except (IndexError, KeyError, TypeError, ValueError):
            continue
        if 0.0 <= x <= 100.0 and 0.0 <= y <= 100.0:
            values.append((x, y))
    output = {field: 0.0 for field in (*POSITIONAL_DEPTH_FIELDS, *POSITIONAL_CELL_FIELDS)}
    if not values:
        return output

    def segment(value: float, boundaries: tuple[float, ...]) -> int:
        for index, edge in enumerate(boundaries[1:], start=1):
            if value < edge or index == len(boundaries) - 1:
                return index
        raise AssertionError("positional grid must cover the whole pitch")

    total = float(len(values))
    for x, y in values:
        depth, lane = segment(x, POSITIONAL_DEPTH_BOUNDARIES), segment(y, POSITIONAL_LANE_BOUNDARIES)
        output[f"depth_{depth}_ratio"] += 1.0
        output[f"grid_d{depth}_l{lane}_ratio"] += 1.0
    rounded = {field: round(value / total * 100.0, 2) for field, value in output.items()}
    # A 30-cell distribution can otherwise display as 99.94% or 100.06% just
    # from independent two-decimal rounding.  Place the tiny residual in the
    # most occupied cell so each published distribution is exactly 100%.
    for fields in (POSITIONAL_DEPTH_FIELDS, POSITIONAL_CELL_FIELDS):
        largest = max(fields, key=lambda field: (output[field], field))
        rounded[largest] = round(rounded[largest] + 100.0 - sum(rounded[field] for field in fields), 2)
    return rounded
