"""Spatially weighted duel metrics built only from verified event coordinates.

The existing tactical heatmap is an activity-density sample.  It does not
identify duel type or outcome and must never be used as a duel-event proxy.
This module therefore has no fallback to ``tactical_heatmap_points.json``.

Upstream collectors must normalize every event to a 0..100 pitch attacking
from left to right before calling :func:`calculate_spatial_duels`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Literal

from positional_grid import POSITIONAL_DEPTH_BOUNDARIES, POSITIONAL_LANE_BOUNDARIES


DuelType = Literal["ground", "aerial"]
GRID_VERSION = "positional-6x5-v1"
COORDINATE_SYSTEM = "0-100-attacking-left-to-right"


@dataclass(frozen=True)
class DuelEvent:
    duel_type: DuelType
    won: bool
    x: float
    y: float


@dataclass(frozen=True)
class DuelSpatialMetrics:
    minutes_played: float
    ground_events: int
    aerial_events: int
    ground_wins: int
    aerial_wins: int
    ground_box_wins: int
    aerial_box_wins: int
    ground_weighted_wins: float
    aerial_weighted_wins: float
    ground_weighted_wins_per90: float
    aerial_weighted_wins_per90: float
    ground_wins_by_cell: dict[str, int]
    aerial_wins_by_cell: dict[str, int]

    @property
    def box_duels_won(self) -> int:
        return self.ground_box_wins + self.aerial_box_wins


def _segment(value: float, boundaries: tuple[float, ...]) -> int:
    for index, edge in enumerate(boundaries[1:], start=1):
        if value < edge or index == len(boundaries) - 1:
            return index
    raise AssertionError("positional grid must cover the whole pitch")


def positional_cell(x: float, y: float) -> tuple[int, int]:
    """Map a normalized coordinate to the shared 6-depth x 5-lane grid."""
    if not (0.0 <= x <= 100.0 and 0.0 <= y <= 100.0):
        raise ValueError("duel coordinates must be inside the normalized pitch")
    return _segment(x, POSITIONAL_DEPTH_BOUNDARIES), _segment(y, POSITIONAL_LANE_BOUNDARIES)


def duel_zone_weight(x: float, y: float) -> tuple[int, float]:
    """Return danger tier and weight for an attacking-right coordinate.

    Tier 1 is depth 6 across both half-spaces and the central lane. Tier 2 is
    the same three lanes in depth 5 (including Zone 14). Everything else is
    Tier 3. This keeps the product's current 30-zone contract rather than
    silently reverting to the superseded 20-zone proposal.
    """
    depth, lane = positional_cell(x, y)
    if depth == 6 and lane in {2, 3, 4}:
        return 1, 3.0
    if depth == 5 and lane in {2, 3, 4}:
        return 2, 1.5
    return 3, 1.0


def calculate_spatial_duels(events: Iterable[DuelEvent], minutes_played: float) -> DuelSpatialMetrics:
    """Calculate weighted wins/90; reject malformed input instead of dropping it.

    Partial event samples would systematically bias the score, so a single
    invalid event makes the session invalid.  The ETL must reconcile win
    counts against the provider's season totals before publishing a snapshot.
    """
    if minutes_played <= 0:
        raise ValueError("minutes_played must be positive")

    event_counts = {"ground": 0, "aerial": 0}
    wins = {"ground": 0, "aerial": 0}
    box_wins = {"ground": 0, "aerial": 0}
    weighted_wins = {"ground": 0.0, "aerial": 0.0}
    wins_by_cell = {
        "ground": {f"d{depth}l{lane}": 0 for depth in range(1, 7) for lane in range(1, 6)},
        "aerial": {f"d{depth}l{lane}": 0 for depth in range(1, 7) for lane in range(1, 6)},
    }

    for event in events:
        if event.duel_type not in event_counts:
            raise ValueError(f"unsupported duel type: {event.duel_type}")
        if not isinstance(event.won, bool):
            raise ValueError("duel outcome must be a boolean")
        depth, lane = positional_cell(float(event.x), float(event.y))
        event_counts[event.duel_type] += 1
        if not event.won:
            continue
        wins[event.duel_type] += 1
        wins_by_cell[event.duel_type][f"d{depth}l{lane}"] += 1
        tier, weight = duel_zone_weight(float(event.x), float(event.y))
        weighted_wins[event.duel_type] += weight
        if tier == 1:
            box_wins[event.duel_type] += 1

    return DuelSpatialMetrics(
        minutes_played=float(minutes_played),
        ground_events=event_counts["ground"], aerial_events=event_counts["aerial"],
        ground_wins=wins["ground"], aerial_wins=wins["aerial"],
        ground_box_wins=box_wins["ground"], aerial_box_wins=box_wins["aerial"],
        ground_weighted_wins=round(weighted_wins["ground"], 4),
        aerial_weighted_wins=round(weighted_wins["aerial"], 4),
        ground_weighted_wins_per90=round(weighted_wins["ground"] * 90.0 / minutes_played, 4),
        aerial_weighted_wins_per90=round(weighted_wins["aerial"] * 90.0 / minutes_played, 4),
        ground_wins_by_cell=wins_by_cell["ground"],
        aerial_wins_by_cell=wins_by_cell["aerial"],
    )


def percentile_scores(values: dict[str, float]) -> dict[str, float]:
    """Return the same 0..100 cohort scale used by the current leaderboard."""
    population = list(values.values())
    if not population:
        return {}
    return {
        player_id: round(100.0 - (1 + sum(candidate > value for candidate in population)) / len(population) * 100.0, 2)
        for player_id, value in values.items()
    }


def gated_cohort_scores(
    metrics_by_player: dict[str, DuelSpatialMetrics], expected_player_ids: Iterable[str],
) -> dict[str, dict[str, float]] | None:
    """Score a cohort only when every expected player has verified events.

    This all-or-nothing gate prevents a partial coordinate feed from changing
    the relative M.E.S.S.I. baseline. An empty but complete event session is a
    valid observed zero; a missing player/session is not.
    """
    expected = {str(player_id) for player_id in expected_player_ids}
    if not expected or set(metrics_by_player) != expected:
        return None
    ground = percentile_scores({
        player_id: metrics_by_player[player_id].ground_weighted_wins_per90
        for player_id in expected
    })
    aerial = percentile_scores({
        player_id: metrics_by_player[player_id].aerial_weighted_wins_per90
        for player_id in expected
    })
    return {player_id: {"ground": ground[player_id], "aerial": aerial[player_id]} for player_id in expected}
