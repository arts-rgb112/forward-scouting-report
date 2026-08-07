"""S.P.E.A.R. rating calculation for the five-league attacking cohort."""

from __future__ import annotations

from dataclasses import dataclass
from math import erf, sqrt
from statistics import mean, pstdev
from typing import Mapping, Optional

from metrics import DecisionMetrics


MINIMUM_MINUTES = 1_000


@dataclass(frozen=True)
class SpearRating:
    score: float
    tier: str
    shooting_z: float
    duel_z: float
    volume_z: float


def _per90(value: Optional[float], minutes: Optional[float]) -> Optional[float]:
    if value is None or minutes is None or minutes <= 0:
        return None
    return value * 90 / minutes


def _components(metric: DecisionMetrics) -> Optional[tuple[float, float, float]]:
    """Return raw shooting, duel-margin and xG-volume components."""
    in_box = _per90(metric.in_box_finishing, metric.minutes_played)
    overall = _per90(metric.shot_quality, metric.minutes_played)
    aerial = metric.aerial_margin_per90
    duel = metric.duel_margin_per90
    dribble = metric.dribble_margin_per90
    volume = metric.xg_per90
    if any(value is None for value in (in_box, overall, aerial, duel, dribble, volume)):
        return None
    return (
        in_box * 0.8 + overall * 0.2,
        aerial * 0.4 + duel * 0.3 + dribble * 0.3,
        volume,
    )


def _z_scores(values: list[float]) -> list[float]:
    spread = pstdev(values)
    if spread == 0:
        return [0.0] * len(values)
    centre = mean(values)
    return [(value - centre) / spread for value in values]


def _tier(score: float) -> str:
    if score >= 95:
        return "S-Tier 🌟"
    if score >= 85:
        return "A-Tier 🔴"
    if score >= 65:
        return "B-Tier 🔵"
    if score >= 35:
        return "C-Tier 🟢"
    return "D-Tier ⚪"


def calculate_spear_ratings(metrics_by_player: Mapping[str, DecisionMetrics]) -> dict[str, SpearRating]:
    """Calculate 0–100 S.P.E.A.R. scores for eligible 1,000-minute players.

    The weighted Z-score is transformed through the standard-normal CDF. This
    preserves the requested weights while producing a bounded, interpretable
    0–100 rating whose 95-point threshold is the cohort's top five percent.
    """
    eligible: list[tuple[str, tuple[float, float, float]]] = []
    for player_id, metric in metrics_by_player.items():
        if (metric.minutes_played or 0) < MINIMUM_MINUTES:
            continue
        components = _components(metric)
        if components is not None:
            eligible.append((str(player_id), components))
    if not eligible:
        return {}

    shooting_z = _z_scores([item[1][0] for item in eligible])
    duel_z = _z_scores([item[1][1] for item in eligible])
    volume_z = _z_scores([item[1][2] for item in eligible])
    ratings: dict[str, SpearRating] = {}
    for index, (player_id, _) in enumerate(eligible):
        composite = shooting_z[index] * 0.5 + duel_z[index] * 0.3 + volume_z[index] * 0.2
        score = round(max(0.0, min(100.0, 50.0 * (1.0 + erf(composite / sqrt(2.0))))), 1)
        ratings[player_id] = SpearRating(score, _tier(score), shooting_z[index], duel_z[index], volume_z[index])
    return ratings
