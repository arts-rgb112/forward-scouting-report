"""League-season percentile calculations for striker metrics."""

from __future__ import annotations

import concurrent.futures
import functools
import time
from dataclasses import dataclass
from typing import Optional
import pandas as pd

from fotmob_client import (
    FotMobError,
    fetch_league_stat_table,
    fetch_player_multi_season_data,
)
from metrics import DecisionMetrics, extract_multi_season_metrics
from spear_cohort import get_static_spear_cohort, load_spear_cohort, spear_cohort_data_version
from tactical_ratio import (
    get_tactical_ratio_for_session,
    passes_final_third_filter,
    tactical_data_version,
)


CUP_COMPETITION_IDS = frozenset({42, 73, 108})
EUROPEAN_COMPETITION_IDS = CUP_COMPETITION_IDS
EUROPEAN_LEADERBOARD_ID = -1
LEAGUE_MINIMUM_MINUTES = 450.0
CUP_MINIMUM_MINUTES = 180.0
LEAGUE_MINIMUM_XG = 2.0
CUP_MINIMUM_XG = 1.0
# A component omitted by the provider is never treated as average.  It gets a
# visible, conservative D-tier floor so the six-sector score remains rankable
# without disguising the missing source data.
MISSING_COMPONENT_SCORE = 20.0
COMPARISON_SCOPES = {
    3: frozenset({47, 55, 87}),
    5: frozenset({47, 53, 54, 55, 87}),
    7: frozenset({47, 53, 54, 55, 57, 61, 87}),
    8: frozenset({40, 47, 53, 54, 55, 57, 61, 87}),
}


def scoring_data_version() -> tuple[object, object]:
    """Identify every static snapshot that can change a M.E.S.S.I. score."""
    return spear_cohort_data_version(), tactical_data_version()


_ACTIVE_SCORING_DATA_VERSION = scoring_data_version()


def refresh_scoring_caches_if_needed() -> tuple[object, object]:
    """Clear process caches after a data-only Community Cloud deployment."""
    global _ACTIVE_SCORING_DATA_VERSION
    current = scoring_data_version()
    if current == _ACTIVE_SCORING_DATA_VERSION:
        return current
    load_spear_cohort.cache_clear()
    _fetch_elite_dribbler_metrics.cache_clear()
    get_spear_leaderboard.cache_clear()
    get_league_metric_medians.cache_clear()
    get_tactical_matrix.cache_clear()
    get_top_leagues_shot_quality.cache_clear()
    _ACTIVE_SCORING_DATA_VERSION = current
    return current


@dataclass(frozen=True)
class LeaguePercentiles:
    goals_top_percent: Optional[float]
    goals_rank: Optional[int]
    xg_top_percent: Optional[float]
    xg_rank: Optional[int]
    shot_quality_top_percent: Optional[float]
    shot_quality_rank: Optional[int]
    overall_finishing_top_percent: Optional[float]
    overall_finishing_rank: Optional[int]
    gk_impact_top_percent: Optional[float]
    gk_impact_rank: Optional[int]
    eligible_players: int
    goals_median: Optional[float] = None
    shot_quality_median: Optional[float] = None
    overall_finishing_median: Optional[float] = None
    gk_impact_median: Optional[float] = None
    in_box_finishing_top_percent: Optional[float] = None
    in_box_finishing_rank: Optional[int] = None
    in_box_finishing_median: Optional[float] = None
    out_box_shot_quality_top_percent: Optional[float] = None
    out_box_shot_quality_rank: Optional[int] = None
    out_box_shot_quality_median: Optional[float] = None
    
    duels_pct_top_percent: Optional[float] = None
    duels_pct_rank: Optional[int] = None
    duels_eligible: int = 0
    
    dribbles_pct_top_percent: Optional[float] = None
    dribbles_pct_rank: Optional[int] = None
    dribbles_eligible: int = 0
    
    aerials_pct_top_percent: Optional[float] = None
    aerials_pct_rank: Optional[int] = None
    aerials_eligible: int = 0

    elite_dribbler_eligible: int = 0
    dribbles_succeeded_per90_top_percent: Optional[float] = None
    dribbles_succeeded_per90_rank: Optional[int] = None
    dribbles_failed_per90_top_percent: Optional[float] = None
    dribbles_failed_per90_rank: Optional[int] = None
    dribbles_failed_eligible: int = 0
    dribble_margin_per90_top_percent: Optional[float] = None
    dribble_margin_per90_rank: Optional[int] = None
    duels_won_per90_top_percent: Optional[float] = None
    duels_won_per90_rank: Optional[int] = None
    duels_lost_per90_top_percent: Optional[float] = None
    duels_lost_per90_rank: Optional[int] = None
    duel_margin_per90_top_percent: Optional[float] = None
    duel_margin_per90_rank: Optional[int] = None
    aerials_won_per90_top_percent: Optional[float] = None
    aerials_won_per90_rank: Optional[int] = None
    aerials_lost_per90_top_percent: Optional[float] = None
    aerials_lost_per90_rank: Optional[int] = None
    aerial_margin_per90_top_percent: Optional[float] = None
    aerial_margin_per90_rank: Optional[int] = None
    xg_per90_top_percent: Optional[float] = None
    xg_per90_rank: Optional[int] = None
    progression_eligible: int = 0
    net_progression_top_percent: Optional[float] = None
    net_progression_rank: Optional[int] = None
    net_progression_eligible: int = 0
    total_shots_volume_top_percent: Optional[float] = None
    total_shots_volume_rank: Optional[int] = None
    box_shots_volume_top_percent: Optional[float] = None
    box_shots_volume_rank: Optional[int] = None
    dribble_attempts_volume_top_percent: Optional[float] = None
    dribble_attempts_volume_rank: Optional[int] = None
    aerial_duel_attempts_volume_top_percent: Optional[float] = None
    aerial_duel_attempts_volume_rank: Optional[int] = None
    ground_duel_attempts_volume_top_percent: Optional[float] = None
    ground_duel_attempts_volume_rank: Optional[int] = None
    xg_volume_top_percent: Optional[float] = None
    xg_volume_rank: Optional[int] = None
    spear_volume_eligible: int = 0
    outside_box_shots_attempts_top_percent: Optional[float] = None
    outside_box_shots_attempts_rank: Optional[int] = None
    micro_zoning_finishing_top_percent: Optional[float] = None
    micro_zoning_finishing_rank: Optional[int] = None
    danger_zone_progression_top_percent: Optional[float] = None
    danger_zone_progression_rank: Optional[int] = None
    cca_area_top_percent: Optional[float] = None
    cca_area_rank: Optional[int] = None
    danger_zone_density_top_percent: Optional[float] = None
    danger_zone_density_rank: Optional[int] = None
    combined_duel_volume_top_percent: Optional[float] = None
    combined_duel_volume_rank: Optional[int] = None
    combined_duel_efficiency_top_percent: Optional[float] = None
    combined_duel_efficiency_rank: Optional[int] = None
    recoveries_per90_top_percent: Optional[float] = None
    recoveries_per90_rank: Optional[int] = None
    final_third_possessions_won_per90_top_percent: Optional[float] = None
    final_third_possessions_won_per90_rank: Optional[int] = None
    combined_duel_top_percent: Optional[float] = None
    combined_duel_rank: Optional[int] = None
    forward_press_top_percent: Optional[float] = None
    forward_press_rank: Optional[int] = None
    spear_shot_quality_top_percent: Optional[float] = None
    spear_shot_quality_rank: Optional[int] = None
    spear_score: Optional[float] = None
    spear_score_rank: Optional[int] = None
    spear_score_top_percent: Optional[float] = None
    spear_score_eligible: int = 0
    spear_imputed_volume_attrs: tuple[str, ...] = ()
    spear_imputed_ratio_attrs: tuple[str, ...] = ()
    pressing_imputed_volume_attrs: tuple[str, ...] = ()
    pressing_imputed_ratio_attrs: tuple[str, ...] = ()
    spear_pressing_score: Optional[float] = None
    spear_pressing_score_rank: Optional[int] = None
    spear_pressing_score_top_percent: Optional[float] = None
    spear_pressing_score_eligible: int = 0
    is_type_b: bool = False
    spear_role: str = "Type A · 정통 타겟/포처"


def _minimum_minutes_for_competition(league_id: int) -> float:
    return CUP_MINIMUM_MINUTES if league_id in CUP_COMPETITION_IDS else LEAGUE_MINIMUM_MINUTES


def _minimum_xg_for_competition(league_id: int | None) -> float:
    """Use a stricter domestic-league xG floor without collapsing cup samples."""
    return CUP_MINIMUM_XG if league_id in CUP_COMPETITION_IDS else LEAGUE_MINIMUM_XG


def _value(row: dict) -> Optional[float]:
    value = row.get("statValue", {}).get("value") if isinstance(row.get("statValue"), dict) else None
    return float(value) if isinstance(value, (int, float)) else None

def _sub_value(row: dict) -> Optional[float]:
    """드리블 성공률 등 substatValue(%)를 추출하기 위한 헬퍼 함수"""
    value = row.get("substatValue", {}).get("value") if isinstance(row.get("substatValue"), dict) else None
    return float(value) if isinstance(value, (int, float)) else None


def _rank_info(value: Optional[float], population: list[float]) -> tuple[Optional[float], Optional[int]]:
    if not population or value is None:
        return None, None
    rank = 1 + sum(candidate > value for candidate in population)
    effective_total = max(rank, len(population))
    percentile = round((rank / effective_total) * 100, 1)
    return percentile, rank


def _progression_value(metric: DecisionMetrics) -> Optional[float]:
    """Return the report's net-progression value, including its UI fallback."""
    value = metric.net_progression_per90
    if value is not None:
        return value

    successful = metric.dribbles_succeeded_per90
    fouls = metric.fouls_won_per90
    penalties = metric.penalties_awarded_per90
    duels_won = metric.duels_won_per90
    aerial_won = metric.aerial_duels_won_per90
    duels_lost = metric.duels_lost_per90
    aerial_lost = metric.aerial_duels_lost_per90
    dribble_failed = metric.dribbles_failed_per90
    dispossessed = metric.dispossessed_per90
    values = (successful, fouls, penalties, duels_won, aerial_won,
              duels_lost, aerial_lost, dribble_failed, dispossessed)
    if all(component is None for component in values):
        return None
    return ((successful or 0.0) + (fouls or 0.0) + (penalties or 0.0)
            + (duels_won or 0.0) + (aerial_won or 0.0)
            - (duels_lost or 0.0) - (aerial_lost or 0.0)
            - (dribble_failed or 0.0) - (dispossessed or 0.0))


def _scores_from_population(values: dict[str, float]) -> dict[str, float]:
    """Convert raw values to 0-100 percentile scores without fitting a model."""
    population = list(values.values())
    scores: dict[str, float] = {}
    for player_id, value in values.items():
        top_percent, _ = _rank_info(value, population)
        if top_percent is not None:
            scores[player_id] = 100.0 - top_percent
    return scores


def _rank_score(player_id: str, scores: dict[str, float]) -> tuple[Optional[float], Optional[int]]:
    if player_id not in scores or not scores:
        return None, None
    score = scores[player_id]
    rank = 1 + sum(candidate > score for candidate in scores.values())
    return round(100.0 - score, 1), rank


def _combined_scores(
    primary: dict[str, float], secondary: dict[str, float], primary_weight: float,
) -> dict[str, float]:
    """Combine two already-normalised dimensions only where both are present."""
    return {
        player_id: round(primary_weight * primary[player_id] + (1.0 - primary_weight) * secondary[player_id], 2)
        for player_id in primary.keys() & secondary.keys()
    }


def _blend_volume_ratio_scores(
    volume_scores: dict[str, float], ratio_scores: dict[str, float], player_ids,
) -> dict[str, float]:
    """Score every eligible player with the same volume/ratio pair.

    A source omission receives a conservative 20-point component score, not a
    neutral average. This lets a report retain its total/rank while keeping the
    UI free to explicitly label the affected axis as insufficient data.
    """
    return {
        player_id: round(
            0.50 * volume_scores.get(player_id, MISSING_COMPONENT_SCORE)
            + 0.50 * ratio_scores.get(player_id, MISSING_COMPONENT_SCORE),
            2,
        )
        for player_id in player_ids
    }


@functools.lru_cache(maxsize=64)
def _fetch_live_spear_cohort(
    league_id: int, season_name: str, restrict_to_forwards: bool = True,
    minimum_final_third_ratio: int = 0,
) -> tuple[dict[str, DecisionMetrics], dict[str, float]]:
    """Build the same-competition xG>=1 comparison cohort.

    FotMob's minutes leaderboard currently returns an empty list, while its
    won-contest endpoint returns the complete player directory.  The latter is
    therefore used only to discover player IDs: contest values do not filter
    the cohort. Exact player metrics then enforce the shared xG floor only.
    """
    rows = fetch_league_stat_table(league_id, season_name, "won_contest")
    # Some smaller leagues and continental competitions expose no contest
    # leaderboard even though their player stats are available.  xG is the
    # cohort's actual eligibility floor, so it is the correct lossless seed
    # for those sessions rather than treating the whole competition as empty.
    if not rows:
        rows = fetch_league_stat_table(league_id, season_name, "expected_goals")

    def per90_table(stat: str) -> dict[str, float]:
        """Load one complete provider table without making it an eligibility gate."""
        try:
            stat_rows = fetch_league_stat_table(league_id, season_name, stat)
        except FotMobError:
            return {}
        return {
            str(row.get("id")): value
            for row in stat_rows
            if row.get("id") is not None and (value := _value(row)) is not None
        }

    recoveries_per90 = per90_table("ball_recovery")
    final_third_wins_per90 = per90_table("poss_won_att_3rd")
    
    # Seed with every listed player; no contest-stat cutoff.
    successes = {
        str(row.get("id")): 0.0
        for row in rows
        if row.get("id") is not None
    }

    def fetch_one(player_id: str) -> tuple[str, Optional[DecisionMetrics], str]:
        last_reason = "competition_record_missing"
        for attempt in range(3):
            try:
                if attempt:
                    # A large league refresh can briefly trigger upstream
                    # throttling.  Retry the complete profile because the
                    # lower-level season fetch intentionally skips an
                    # unavailable tournament record.
                    time.sleep(1.0 * attempt)
                if len(season_name) == 9 and "/" in season_name:
                    start_year, end_year = season_name.split("/", 1)
                    short_season = f"{start_year[-2:]}/{end_year[-2:]}"
                else:
                    short_season = season_name

                parsed = extract_multi_season_metrics(
                    fetch_player_multi_season_data(player_id, target_season=season_name)
                )
                for season_key, stat_obj in parsed.items():
                    if season_key.startswith(f"{short_season}_") and stat_obj.league_id == league_id:
                        return player_id, stat_obj, "resolved"
            except (FotMobError, StopIteration, ValueError) as exc:
                last_reason = type(exc).__name__
        return player_id, None, last_reason

    metrics_by_player: dict[str, DecisionMetrics] = {}
    # Multi-season requests fetch several records per player. This matches the
    # concurrency already used by the xGOT fallback and keeps large leagues responsive.
    unresolved_reasons: dict[str, int] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for player_id, metric, reason in executor.map(fetch_one, successes):
            if metric is not None:
                metrics_by_player[player_id] = metric
            else:
                unresolved_reasons[reason] = unresolved_reasons.get(reason, 0) + 1

    # Player-season totals are the primary source.  Deep-stat tables are a
    # lossless fallback and explicitly contain observed zeroes.  Reconstruct a
    # compatible total from the provider's /90 value so every downstream
    # calculation continues to use one formula and never divides a /90 twice.
    for player_id, metric in metrics_by_player.items():
        minutes = metric.minutes_played
        if minutes is None or minutes <= 0:
            continue
        if metric.recoveries is None and player_id in recoveries_per90:
            metric.recoveries = recoveries_per90[player_id] * minutes / 90.0
            metric.recoveries_source = "league_per90_fallback"
        if (
            metric.final_third_possessions_won is None
            and player_id in final_third_wins_per90
        ):
            metric.final_third_possessions_won = (
                final_third_wins_per90[player_id] * minutes / 90.0
            )
            metric.final_third_possessions_won_source = "league_per90_fallback"
    print(
        "S.P.E.A.R. profile fetch: "
        f"league={league_id} season={season_name} seeds={len(successes)} "
        f"resolved={len(metrics_by_player)} unresolved={len(successes) - len(metrics_by_player)} "
        f"reasons={unresolved_reasons}"
    )
    # S.P.E.A.R., pure progression, and finishing all share one transparent
    # Population: individual cumulative xG >= 2.0 in domestic leagues and
    # >= 1.0 in continental cups, with the matching appearance cutoff.
    # Keep ``restrict_to_forwards`` in the signature for cached-call
    # compatibility; it intentionally no longer narrows this population.
    metrics_by_player = {
        player_id: metric for player_id, metric in metrics_by_player.items()
        if (metric.xg or 0.0) >= _minimum_xg_for_competition(league_id)
        and (metric.minutes_played or 0.0) >= _minimum_minutes_for_competition(league_id)
    }
    metrics_by_player = {
        player_id: metric for player_id, metric in metrics_by_player.items()
        if passes_final_third_filter(
            player_id,
            minimum_final_third_ratio,
            metric.league_name or "",
            season_name,
        )
    }
    successes = {player_id: value for player_id, value in successes.items() if player_id in metrics_by_player}
    return metrics_by_player, successes


@functools.lru_cache(maxsize=64)
def _fetch_elite_dribbler_metrics(
    league_id: int, season_name: str, restrict_to_forwards: bool = True,
    minimum_final_third_ratio: int = 0, comparison_scope: int = 0,
) -> tuple[dict[str, DecisionMetrics], dict[str, float]]:
    """Prefer the static cohort; retain live FotMob as a safe bootstrap fallback."""
    if restrict_to_forwards:
        # Continental cups remain isolated even when a cross-league scope is
        # selected; only domestic competitions use the named league unions.
        target_leagues = (
            frozenset({league_id}) if league_id in CUP_COMPETITION_IDS
            else COMPARISON_SCOPES.get(comparison_scope, frozenset({league_id}))
        )
        static_metrics = {}
        for target_league_id in target_leagues:
            cohort_metrics, _ = get_static_spear_cohort(target_league_id, season_name)
            static_metrics.update({
                player_id: metric for player_id, metric in cohort_metrics.items()
                if (metric.xg or 0.0) >= _minimum_xg_for_competition(metric.league_id or target_league_id)
                and (metric.minutes_played or 0.0) >= _minimum_minutes_for_competition(
                    metric.league_id or target_league_id
                )
                and passes_final_third_filter(
                    player_id,
                    minimum_final_third_ratio,
                    metric.league_name or "",
                    season_name,
                )
            })
        if static_metrics:
            return static_metrics, {player_id: 0.0 for player_id in static_metrics}
        # A historical snapshot may not be available yet.  Do not turn a
        # dashboard view into hundreds of player-profile requests: the UI can
        # honestly show an unavailable comparison cohort until the scheduled
        # static refresh is explicitly resumed.
        return {}, {}
    return _fetch_live_spear_cohort(
        league_id, season_name, restrict_to_forwards, minimum_final_third_ratio,
    )


def _spear_tier(score: float) -> str:
    if score >= 95.0:
        return "S"
    if score >= 85.0:
        return "A"
    if score >= 65.0:
        return "B"
    if score >= 35.0:
        return "C"
    return "D"


MESSI_RANK_TIER_BANDS = (
    ("💎", "다이아몬드", 0.0, 4.0),
    ("❇️", "플래티넘", 4.0, 11.0),
    ("🥇", "골드", 11.0, 40.0),
    ("🥈", "실버", 40.0, 77.0),
    ("🥉", "브론즈", 77.0, 96.0),
    ("⚙️", "아이언", 96.0, 100.0),
)


def messi_rank_tier(rank: Optional[int], population: int) -> str:
    """Return the 6×5 relative M.E.S.S.I. tier for a score rank.

    The score remains the framework's deliberately strict 0–100 score.  Its
    tier is a separate, within-cohort signal: we map score rank to the
    specified Stanine-style percentile bands, then split each band into five
    equal sub-tiers.  ``rank - 1`` makes the first-ranked player 0.0% and
    therefore guarantees a Diamond 1 for every non-empty cohort.
    """
    if rank is None or rank < 1 or population < 1:
        return "—"
    top_percent = min(100.0, max(0.0, ((rank - 1) / population) * 100.0))
    for index, (icon, title, start, end) in enumerate(MESSI_RANK_TIER_BANDS):
        if top_percent <= end or index == len(MESSI_RANK_TIER_BANDS) - 1:
            width = (end - start) / 5.0
            level = min(5, max(1, int((top_percent - start) / width) + 1))
            return f"{icon} {title} {level}"
    return "⚙️ 아이언 5"


@functools.lru_cache(maxsize=8)
def get_spear_leaderboard(
    league_id: int, season_name: str, comparison_scope: int = 0,
) -> pd.DataFrame:
    """Build an API-free S.P.E.A.R. list from the static cohort snapshot.

    The list intentionally never falls back to the live player fan-out.  A
    missing historical snapshot should show a clear unavailable state, rather
    than spending requests while a user scrolls the scouting board.
    """
    target_leagues = (
        EUROPEAN_COMPETITION_IDS if league_id == EUROPEAN_LEADERBOARD_ID
        else frozenset({league_id}) if league_id in CUP_COMPETITION_IDS
        else COMPARISON_SCOPES.get(comparison_scope, frozenset({league_id}))
    )
    peers: dict[str, DecisionMetrics] = {}
    names: dict[str, str] = {}
    for target_id in target_leagues:
        metrics, cohort_names = get_static_spear_cohort(target_id, season_name)
        for player_id, metric in metrics.items():
            if ((metric.xg or 0.0) >= _minimum_xg_for_competition(metric.league_id or target_id)
                    and (metric.minutes_played or 0.0) >= _minimum_minutes_for_competition(metric.league_id or target_id)):
                peers[player_id] = metric
                names[player_id] = cohort_names.get(player_id, "Unknown")
    if not peers:
        return pd.DataFrame(columns=["rank", "player_id", "player_name", "team_name", "score", "tier"])

    spatial = {
        player_id: get_tactical_ratio_for_session(
            player_id, metric.league_name or "", season_name,
        )
        for player_id, metric in peers.items()
    }
    micro_fields = ("box_six_yard_ratio", "box_penalty_spot_ratio", "box_wide_ratio")
    def spatial_values(field: str) -> dict[str, float]:
        return {
            player_id: float(row[field]) for player_id, row in spatial.items()
            if row is not None and row.get(field) is not None
        }
    def scores(values: dict[str, float]) -> dict[str, float]:
        return _scores_from_population(values)
    shot_scores = scores({pid: metric.shot_quality_per90 for pid, metric in peers.items() if metric.shot_quality_per90 is not None})
    in_box_scores = scores({pid: metric.in_box_finishing_per90 for pid, metric in peers.items() if metric.in_box_finishing_per90 is not None})
    dribble_scores = scores({pid: metric.dribble_margin_per90 for pid, metric in peers.items() if metric.dribble_margin_per90 is not None})
    aerial_scores = scores({pid: metric.aerial_margin_per90 for pid, metric in peers.items() if metric.aerial_margin_per90 is not None})
    duel_scores = scores({pid: metric.duel_margin_per90 for pid, metric in peers.items() if metric.duel_margin_per90 is not None})
    micro_raw = {
        pid: float(row["deep_box_zone_score"]) for pid, row in spatial.items()
        if row is not None and row.get("deep_box_zone_score") is not None
        and sum(float(row.get(field) or 0.0) for field in micro_fields) > 0.0
    }
    micro_scores = scores(micro_raw)
    # A stored heatmap row with no box activity is an observed zero, not a
    # missing value. Keep it in the shared score scale for Type A and Type B.
    deep_scores = {
        player_id: round(0.70 * in_box_scores[player_id] + 0.30 * micro_scores.get(player_id, 0.0), 2)
        for player_id, row in spatial.items()
        if player_id in in_box_scores and row is not None
    }
    danger_scores = scores(spatial_values("danger_zone_density"))
    cca_scores = scores(spatial_values("cca_area_pct"))
    progression_scores = _combined_scores(dribble_scores, danger_scores, 0.70)
    volume_scores = {
        "outside_box": scores({pid: metric.out_box_shots for pid, metric in peers.items() if metric.out_box_shots is not None}),
        "box": scores({pid: metric.in_box_shots for pid, metric in peers.items() if metric.in_box_shots is not None}),
        "dribble": scores({pid: metric.dribble_attempts for pid, metric in peers.items() if metric.dribble_attempts is not None}),
        "aerial": scores({pid: metric.aerial_duel_attempts for pid, metric in peers.items() if metric.aerial_duel_attempts is not None}),
        "ground": scores({pid: metric.ground_duel_attempts for pid, metric in peers.items() if metric.ground_duel_attempts is not None}),
        "space": cca_scores,
    }
    recovery_scores = scores({
        pid: metric.recoveries_per90
        for pid, metric in peers.items() if metric.recoveries_per90 is not None
    })
    final_third_press_scores = scores({
        pid: metric.final_third_possessions_won_per90
        for pid, metric in peers.items()
        if metric.final_third_possessions_won_per90 is not None
    })
    combined_duel_volume_scores = _blend_volume_ratio_scores(
        volume_scores["ground"], volume_scores["aerial"], peers,
    )
    combined_duel_efficiency_scores = _blend_volume_ratio_scores(
        duel_scores, aerial_scores, peers,
    )
    sector_scores = {
        "outside_box": _blend_volume_ratio_scores(volume_scores["outside_box"], scores({pid: metric.out_box_shot_quality for pid, metric in peers.items() if metric.out_box_shot_quality is not None}), peers),
        "box": _blend_volume_ratio_scores(volume_scores["box"], deep_scores, peers),
        "danger": _blend_volume_ratio_scores(volume_scores["dribble"], progression_scores, peers),
        "aerial": _blend_volume_ratio_scores(volume_scores["aerial"], aerial_scores, peers),
        "ground": _blend_volume_ratio_scores(volume_scores["ground"], duel_scores, peers),
        "space": _blend_volume_ratio_scores(volume_scores["space"], danger_scores, peers),
        "duel": _blend_volume_ratio_scores(
            combined_duel_volume_scores, combined_duel_efficiency_scores, peers,
        ),
        "press": _blend_volume_ratio_scores(
            recovery_scores, final_third_press_scores, peers,
        ),
    }

    records: list[dict[str, object]] = []
    for player_id, metric in peers.items():
        row = spatial.get(player_id)
        box_ratio = float(row.get("in_box_ratio") or 0.0) if row else 0.0
        # Role is a spatial-depth label only. Missing micro-zone values must
        # never turn a conventional box player into a false nine.
        is_type_b = row is not None and box_ratio < 15.0
        weights = (
            (sector_scores["box"], 0.30), (sector_scores["outside_box"], 0.20),
            (sector_scores["danger"], 0.15), (sector_scores["space"], 0.15),
            (sector_scores["aerial"], 0.10), (sector_scores["ground"], 0.10),
        )
        if not all(player_id in source for source, _ in weights):
            continue
        score = round(sum(source[player_id] * weight for source, weight in weights), 2)
        pressing_weights = (
            (sector_scores["box"], 0.30), (sector_scores["outside_box"], 0.20),
            (sector_scores["danger"], 0.15), (sector_scores["space"], 0.15),
            (sector_scores["duel"], 0.10), (sector_scores["press"], 0.10),
        )
        pressing_score = round(
            sum(source[player_id] * weight for source, weight in pressing_weights), 2
        )
        def factor_tier(source: dict[str, float]) -> str:
            return _spear_tier(source[player_id]) if player_id in source else "-"
        records.append({
            "player_id": player_id, "player_name": names.get(player_id, "Unknown"),
            "team_name": metric.team_name or "정보 미제공",
            "league_name": metric.league_name or "대회 정보 미제공",
            "league_id": metric.league_id,
            "team_id": metric.team_id,
            "minutes_played": metric.minutes_played,
            # Keep the six unscaled volume inputs on the cached leaderboard.
            # Companion benchmarks reuse these exact eligible rows rather than
            # approximating an average from the rendered 0-100 sector score.
            "out_box_shots_raw": metric.out_box_shots,
            "in_box_shots_raw": metric.in_box_shots,
            "dribble_attempts_raw": metric.dribble_attempts,
            "aerial_duel_attempts_raw": metric.aerial_duel_attempts,
            "ground_duel_attempts_raw": metric.ground_duel_attempts,
            "cca_area_pct": row.get("cca_area_pct") if row is not None else None,
            # Ratio-companion raw values use the exact same fully eligible
            # domestic eight-league rows as the cached M.E.S.S.I. table.
            # They are additive internal columns; public leaderboard DTOs do
            # not expose or reinterpret them.
            "shot_quality_per90_raw": metric.shot_quality_per90,
            "in_box_finishing_per90_raw": metric.in_box_finishing_per90,
            "deep_box_zone_score": row.get("deep_box_zone_score") if row is not None else None,
            "dribble_margin_per90_raw": metric.dribble_margin_per90,
            "danger_zone_density": row.get("danger_zone_density") if row is not None else None,
            "aerial_margin_per90_raw": metric.aerial_margin_per90,
            "duel_margin_per90_raw": metric.duel_margin_per90,
            "recoveries": metric.recoveries,
            "recoveries_per90": metric.recoveries_per90,
            "recoveries_source": metric.recoveries_source,
            "final_third_possessions_won": metric.final_third_possessions_won,
            "final_third_possessions_won_per90": metric.final_third_possessions_won_per90,
            "final_third_possessions_won_source": metric.final_third_possessions_won_source,
            # The strict score is intentionally independent from its relative
            # tier.  The latter is assigned only after every cohort score is
            # ranked below.
            "score": score,
            "pressing_score": pressing_score,
            "tier": "—",
            "role": "Type B" if is_type_b else "Type A",
            "position": metric.position or metric.position_group or "미분류",
            "outside_shot_tier": factor_tier(sector_scores["outside_box"]),
            "deep_box_tier": factor_tier(sector_scores["box"]),
            "danger_zone_tier": factor_tier(sector_scores["danger"]),
            "aerial_tier": factor_tier(sector_scores["aerial"]),
            "ground_duel_tier": factor_tier(sector_scores["ground"]),
            "space_control_tier": factor_tier(sector_scores["space"]),
            "combined_duel_tier": factor_tier(sector_scores["duel"]),
            "forward_press_tier": factor_tier(sector_scores["press"]),
            # Public API consumers need the real numeric sector values, not
            # only their display tiers.  Keep these fields on the same 0–100
            # percentile scale used to calculate the weighted M.E.S.S.I. score.
            "outside_shot_score": round(sector_scores["outside_box"][player_id], 2),
            "deep_box_score": round(sector_scores["box"][player_id], 2),
            "danger_zone_score": round(sector_scores["danger"][player_id], 2),
            "aerial_score": round(sector_scores["aerial"][player_id], 2),
            "ground_duel_score": round(sector_scores["ground"][player_id], 2),
            "space_control_score": round(sector_scores["space"][player_id], 2),
            "combined_duel_score": round(sector_scores["duel"][player_id], 2),
            "forward_press_score": round(sector_scores["press"][player_id], 2),
            "combined_duel_volume_score": round(combined_duel_volume_scores[player_id], 2),
            "combined_duel_efficiency_score": round(combined_duel_efficiency_scores[player_id], 2),
            "recoveries_score": round(recovery_scores.get(player_id, MISSING_COMPONENT_SCORE), 2),
            "final_third_press_score": round(final_third_press_scores.get(player_id, MISSING_COMPONENT_SCORE), 2),
        })
    table = pd.DataFrame(records)
    if table.empty:
        return pd.DataFrame(columns=["rank", "player_id", "player_name", "team_name", "score", "tier", "role"])
    table = table.sort_values(["score", "player_name"], ascending=[False, True], kind="stable").reset_index(drop=True)
    table.insert(0, "rank", table.index + 1)
    population = len(table)
    table["tier"] = table["rank"].map(lambda rank: messi_rank_tier(int(rank), population))
    pressing_order = table.sort_values(
        ["pressing_score", "player_name"], ascending=[False, True], kind="stable",
    ).index
    pressing_ranks = {index: rank for rank, index in enumerate(pressing_order, start=1)}
    table["pressing_rank"] = table.index.map(pressing_ranks)
    table["pressing_tier"] = table["pressing_rank"].map(
        lambda rank: messi_rank_tier(int(rank), population)
    )
    return table


def _calculate_progression_percentiles(
    player_id: str, league_id: int, season_name: str, player: DecisionMetrics,
    restrict_to_forwards: bool = True, minimum_final_third_ratio: int = 0,
    comparison_scope: int = 0,
) -> dict[str, Optional[float] | Optional[int] | int]:
    try:
        peers, successes = _fetch_elite_dribbler_metrics(
            league_id, season_name, restrict_to_forwards, minimum_final_third_ratio, comparison_scope,
        )
    except FotMobError:
        peers, successes = {}, {}

    def rank_attr(attr_name: str, reverse: bool = False) -> tuple[Optional[float], Optional[int], int]:
        player_value = _progression_value(player) if attr_name == "net_progression_per90" else getattr(player, attr_name)
        population = [
            _progression_value(peer) if attr_name == "net_progression_per90" else getattr(peer, attr_name)
            for peer in peers.values()
        ]
        population = [value for value in population if value is not None]
        if player_value is None or not population:
            return None, None, len(population)
        if reverse:
            percentile, rank = _rank_info(-player_value, [-value for value in population])
        else:
            percentile, rank = _rank_info(player_value, population)
        return percentile, rank, len(population)

    success_pct, success_rank, _ = rank_attr("dribbles_succeeded_per90")
    failure_pct, failure_rank, _ = rank_attr("dribbles_failed_per90", reverse=True)
    duels_won_pct, duels_won_rank, _ = rank_attr("duels_won_per90")
    duels_lost_pct, duels_lost_rank, _ = rank_attr("duels_lost_per90", reverse=True)
    aerials_won_pct, aerials_won_rank, _ = rank_attr("aerial_duels_won_per90")
    aerials_lost_pct, aerials_lost_rank, _ = rank_attr("aerial_duels_lost_per90", reverse=True)
    dribble_margin_pct, dribble_margin_rank, _ = rank_attr("dribble_margin_per90")
    duel_margin_pct, duel_margin_rank, _ = rank_attr("duel_margin_per90")
    aerial_margin_pct, aerial_margin_rank, _ = rank_attr("aerial_margin_per90")
    xg_per90_pct, xg_per90_rank, _ = rank_attr("xg_per90")
    net_pct, net_rank, net_count = rank_attr("net_progression_per90")
    return {
        "cohort_count": len(successes),
        "success_pct": success_pct, "success_rank": success_rank,
        "failure_pct": failure_pct, "failure_rank": failure_rank,
        "duels_won_pct": duels_won_pct, "duels_won_rank": duels_won_rank,
        "duels_lost_pct": duels_lost_pct, "duels_lost_rank": duels_lost_rank,
        "aerials_won_pct": aerials_won_pct, "aerials_won_rank": aerials_won_rank,
        "aerials_lost_pct": aerials_lost_pct, "aerials_lost_rank": aerials_lost_rank,
        "dribble_margin_pct": dribble_margin_pct, "dribble_margin_rank": dribble_margin_rank,
        "duel_margin_pct": duel_margin_pct, "duel_margin_rank": duel_margin_rank,
        "aerial_margin_pct": aerial_margin_pct, "aerial_margin_rank": aerial_margin_rank,
        "xg_per90_pct": xg_per90_pct, "xg_per90_rank": xg_per90_rank,
        "net_pct": net_pct, "net_rank": net_rank, "net_count": net_count,
    }


@functools.lru_cache(maxsize=64)
def get_league_metric_medians(
    league_id: int, season_name: str, restrict_to_forwards: bool = True,
    minimum_final_third_ratio: int = 0,
) -> dict[str, float | None]:
    """Return comparison-cohort medians for the metrics shown in the report.

    The cohort is the same competition xG>=1 group used by
    the tactical matrix and percentile bars, so adjacent visuals use the same
    population.
    """
    peers, _ = _fetch_elite_dribbler_metrics(league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)
    attributes = {
        "dribbles_succeeded_per90": "dribbles_succeeded_per90",
        "dribbles_failed_per90": "dribbles_failed_per90",
        "duels_won_per90": "duels_won_per90",
        "duels_lost_per90": "duels_lost_per90",
        "aerial_duels_won_per90": "aerial_duels_won_per90",
        "aerial_duels_lost_per90": "aerial_duels_lost_per90",
        "dribble_margin_per90": "dribble_margin_per90",
        "duel_margin_per90": "duel_margin_per90",
        "aerial_margin_per90": "aerial_margin_per90",
        "xg_per90": "xg_per90",
        "net_progression_per90": "net_progression_per90",
    }
    medians: dict[str, float | None] = {}
    for output_name, attribute in attributes.items():
        values = [
            _progression_value(metric) if attribute == "net_progression_per90" else getattr(metric, attribute)
            for metric in peers.values()
        ]
        values = [value for value in values if value is not None]
        medians[output_name] = float(pd.Series(values).median()) if values else None
    return medians


@functools.lru_cache(maxsize=16)
def get_tactical_matrix(
    league_id: int, season_name: str, restrict_to_forwards: bool = True,
    minimum_final_third_ratio: int = 0, comparison_scope: int = 0,
) -> pd.DataFrame:
    """Return the exact percentile cohort used in the tactical quadrant chart.

    Both axes are available only after the player-level fetch: Net Progression
    is composed from five event stats, while finishing is in-box xGOT minus xG.
    """
    peers, _ = _fetch_elite_dribbler_metrics(
        league_id, season_name, restrict_to_forwards,
        minimum_final_third_ratio, comparison_scope,
    )
    # The old name lookup queried only ``league_id``.  When the report used a
    # Named cross-league comparison scope: every peer from the added leagues
    # became "선수 정보 미제공".  Read names from the same static cohort used
    # to form the percentile population instead.
    target_leagues = (
        frozenset({league_id}) if league_id in CUP_COMPETITION_IDS
        else COMPARISON_SCOPES.get(comparison_scope, frozenset({league_id}))
    )
    names: dict[str, str] = {}
    for target_league_id in target_leagues:
        _, cohort_names = get_static_spear_cohort(target_league_id, season_name)
        names.update(cohort_names)
    rows = []
    for player_id, metric in peers.items():
        net_progression = metric.net_progression_per90
        finishing = metric.in_box_finishing
        if net_progression is None or finishing is None:
            continue
        rows.append({
            "player_id": player_id,
            "player_name": names.get(player_id) or "선수 정보 미제공",
            "team_name": metric.team_name or "정보 없음",
            "net_progression_per90": net_progression,
            "in_box_xgot_minus_xg": finishing,
            "dribbles_succeeded_per90": metric.dribbles_succeeded_per90,
        })
    return pd.DataFrame(rows)


def calculate_league_percentiles(
    player_id: str, season: str, metrics: DecisionMetrics, minimum_xg: float = 1.0,
    restrict_to_forwards: bool = True, minimum_final_third_ratio: int = 0,
    comparison_scope: int = 0, role_override: str = "auto",
) -> LeaguePercentiles:
    if metrics.league_id is None:
        return LeaguePercentiles(None, None, None, None, None, None, None, None, None, None, 0)
    # Call sites retained ``minimum_xg=1.0`` for backward compatibility.
    # Apply the competition-specific floor centrally so every bar, median,
    # S.P.E.A.R. axis, rank and leaderboard shares the same population rule.
    minimum_xg = max(float(minimum_xg), _minimum_xg_for_competition(metrics.league_id))
    
    season_name = f"20{season[:2]}/20{season[3:]}" if len(season) == 5 and "/" in season else season
    player_key = str(player_id)
    
    duels_pct, duels_rk = None, None
    aerials_pct, aerials_rk = None, None
    peers, _ = _fetch_elite_dribbler_metrics(
        metrics.league_id, season_name, restrict_to_forwards, minimum_final_third_ratio, comparison_scope,
    )
    # A selected player can be absent from an older static cohort snapshot
    # even though the currently loaded session passes the report's eligibility
    # rule. Include that exact session once so its score can be ranked against
    # the same peer population instead of falling back to a partial average.
    if (
        player_key not in peers
        and (metrics.xg or 0.0) >= minimum_xg
        and (metrics.minutes_played or 0.0) >= _minimum_minutes_for_competition(metrics.league_id)
    ):
        peers = {**peers, player_key: metrics}
    # One report must use one cohort.  The former implementation mixed the
    # leaderboard's broad xG population with this filtered player cohort,
    # which made a header such as "99 players" coexist with bars ranked /7.
    cohort_count = len(peers)

    def cohort_rank(value: Optional[float], attr: str, *, reverse: bool = False) -> tuple[Optional[float], Optional[int]]:
        population = [
            _progression_value(peer) if attr == "net_progression_per90" else getattr(peer, attr, None)
            for peer in peers.values()
        ]
        population = [item for item in population if item is not None]
        if reverse:
            return _rank_info(-value if value is not None else None, [-item for item in population])
        return _rank_info(value, population)

    # Every report value is derived directly from this one filtered cohort.
    # Do not add a broad leaderboard population here: it caused the historic
    # mismatch where a 99-player header coexisted with bars ranked out of 7.
    goal_population = [peer.goals for peer in peers.values() if peer.goals is not None]
    xg_population = [peer.xg for peer in peers.values() if peer.xg is not None]
    shot_quality_population = [peer.shot_quality for peer in peers.values() if peer.shot_quality is not None]
    overall_finishing_population = [peer.overall_finishing for peer in peers.values() if peer.overall_finishing is not None]
    gk_impact_population = [peer.luck_or_gk_impact for peer in peers.values() if peer.luck_or_gk_impact is not None]
    goals_median = float(pd.Series(goal_population).median()) if goal_population else None
    shot_quality_median = float(pd.Series(shot_quality_population).median()) if shot_quality_population else None
    overall_finishing_median = float(pd.Series(overall_finishing_population).median()) if overall_finishing_population else None
    gk_impact_median = float(pd.Series(gk_impact_population).median()) if gk_impact_population else None
    goals_pct, goals_rk = _rank_info(metrics.goals, goal_population)
    xg_pct, xg_rk = _rank_info(metrics.xg, xg_population)
    sq_pct, sq_rk = _rank_info(metrics.shot_quality, shot_quality_population)
    of_pct, of_rk = _rank_info(metrics.overall_finishing, overall_finishing_population)
    gk_pct, gk_rk = _rank_info(metrics.luck_or_gk_impact, gk_impact_population)
    eligible_players_count = cohort_count

    def dribble_success_rate(metric: DecisionMetrics) -> Optional[float]:
        successful = metric.dribbles_succeeded_per90
        failed = metric.dribbles_failed_per90
        if successful is None or failed is None or successful + failed <= 0:
            return None
        return 100.0 * successful / (successful + failed)

    dribble_rate_population = [
        rate for peer in peers.values()
        if (rate := dribble_success_rate(peer)) is not None
    ]
    dribbles_pct, dribbles_rk = _rank_info(
        dribble_success_rate(metrics), dribble_rate_population,
    )
    dribbles_eligible = len(dribble_rate_population)

    progression_percentiles = {
        "cohort_count": cohort_count,
        "success_pct": cohort_rank(metrics.dribbles_succeeded_per90, "dribbles_succeeded_per90")[0],
        "success_rank": cohort_rank(metrics.dribbles_succeeded_per90, "dribbles_succeeded_per90")[1],
        "failure_pct": cohort_rank(metrics.dribbles_failed_per90, "dribbles_failed_per90", reverse=True)[0],
        "failure_rank": cohort_rank(metrics.dribbles_failed_per90, "dribbles_failed_per90", reverse=True)[1],
        "duels_won_pct": cohort_rank(metrics.duels_won_per90, "duels_won_per90")[0],
        "duels_won_rank": cohort_rank(metrics.duels_won_per90, "duels_won_per90")[1],
        "duels_lost_pct": cohort_rank(metrics.duels_lost_per90, "duels_lost_per90", reverse=True)[0],
        "duels_lost_rank": cohort_rank(metrics.duels_lost_per90, "duels_lost_per90", reverse=True)[1],
        "aerials_won_pct": cohort_rank(metrics.aerial_duels_won_per90, "aerial_duels_won_per90")[0],
        "aerials_won_rank": cohort_rank(metrics.aerial_duels_won_per90, "aerial_duels_won_per90")[1],
        "aerials_lost_pct": cohort_rank(metrics.aerial_duels_lost_per90, "aerial_duels_lost_per90", reverse=True)[0],
        "aerials_lost_rank": cohort_rank(metrics.aerial_duels_lost_per90, "aerial_duels_lost_per90", reverse=True)[1],
        "dribble_margin_pct": cohort_rank(metrics.dribble_margin_per90, "dribble_margin_per90")[0],
        "dribble_margin_rank": cohort_rank(metrics.dribble_margin_per90, "dribble_margin_per90")[1],
        "duel_margin_pct": cohort_rank(metrics.duel_margin_per90, "duel_margin_per90")[0],
        "duel_margin_rank": cohort_rank(metrics.duel_margin_per90, "duel_margin_per90")[1],
        "aerial_margin_pct": cohort_rank(metrics.aerial_margin_per90, "aerial_margin_per90")[0],
        "aerial_margin_rank": cohort_rank(metrics.aerial_margin_per90, "aerial_margin_per90")[1],
        "xg_per90_pct": cohort_rank(metrics.xg_per90, "xg_per90")[0],
        "xg_per90_rank": cohort_rank(metrics.xg_per90, "xg_per90")[1],
        "net_pct": cohort_rank(_progression_value(metrics), "net_progression_per90")[0],
        "net_rank": cohort_rank(_progression_value(metrics), "net_progression_per90")[1],
        "net_count": cohort_count,
    }
    # Keep the S.P.E.A.R. shooting factor on the exact same xG>=1 cohort
    # competition cohort as the other five radar axes.
    spear_shot_quality_population = [
        peer.shot_quality_per90 for peer in peers.values()
        if peer.shot_quality_per90 is not None
    ]
    spear_shot_scores = _scores_from_population({
        peer_id: peer.shot_quality_per90
        for peer_id, peer in peers.items() if peer.shot_quality_per90 is not None
    })
    spear_shot_quality = metrics.shot_quality_per90
    if spear_shot_quality_population:
        spear_sq_pct, spear_sq_rk = _rank_info(spear_shot_quality, spear_shot_quality_population)
    else:
        spear_sq_pct, spear_sq_rk = None, None
    in_box_population = [peer.in_box_finishing for peer in peers.values() if peer.in_box_finishing is not None]
    out_box_population = [peer.out_box_shot_quality for peer in peers.values() if peer.out_box_shot_quality is not None]
    in_box_pct, in_box_rank = _rank_info(metrics.in_box_finishing, in_box_population)
    out_box_pct, out_box_rank = _rank_info(metrics.out_box_shot_quality, out_box_population)
    # The volume radar deliberately uses season totals, rather than /90 rates.
    # Every population below is the exact competition xG>=1 cohort used
    # by the ratio radar, so the two views remain directly comparable.
    def volume_rank(attr: str) -> tuple[Optional[float], Optional[int]]:
        population = [getattr(peer, attr) for peer in peers.values() if getattr(peer, attr, None) is not None]
        return _rank_info(getattr(metrics, attr, None), population)

    total_shots_pct, total_shots_rank = volume_rank("total_shots")
    outside_box_shots_pct, outside_box_shots_rank = volume_rank("out_box_shots")
    box_shots_pct, box_shots_rank = volume_rank("in_box_shots")
    dribble_attempts_pct, dribble_attempts_rank = volume_rank("dribble_attempts")
    aerial_attempts_pct, aerial_attempts_rank = volume_rank("aerial_duel_attempts")
    ground_attempts_pct, ground_attempts_rank = volume_rank("ground_duel_attempts")
    xg_volume_pct, xg_volume_rank = volume_rank("xg")
    volume_scores = {
        "outside_box": _scores_from_population({peer_id: peer.out_box_shots for peer_id, peer in peers.items() if peer.out_box_shots is not None}),
        "box": _scores_from_population({peer_id: peer.in_box_shots for peer_id, peer in peers.items() if peer.in_box_shots is not None}),
        "dribble": _scores_from_population({peer_id: peer.dribble_attempts for peer_id, peer in peers.items() if peer.dribble_attempts is not None}),
        "aerial": _scores_from_population({peer_id: peer.aerial_duel_attempts for peer_id, peer in peers.items() if peer.aerial_duel_attempts is not None}),
        "ground": _scores_from_population({peer_id: peer.ground_duel_attempts for peer_id, peer in peers.items() if peer.ground_duel_attempts is not None}),
    }
    recovery_scores = _scores_from_population({
        peer_id: peer.recoveries_per90
        for peer_id, peer in peers.items() if peer.recoveries_per90 is not None
    })
    final_third_press_scores = _scores_from_population({
        peer_id: peer.final_third_possessions_won_per90
        for peer_id, peer in peers.items()
        if peer.final_third_possessions_won_per90 is not None
    })

    # S.P.E.A.R. 2.0 spatial factors are sourced only from the exact
    # player/competition/season heatmap session.  A missing heatmap row stays
    # missing: silently substituting another competition would contaminate the
    # comparison cohort.
    spatial_rows = {
        peer_id: get_tactical_ratio_for_session(
            peer_id, peer.league_name or metrics.league_name or "", season_name,
        )
        for peer_id, peer in peers.items()
    }
    player_spatial = get_tactical_ratio_for_session(
        player_key, metrics.league_name or "", season_name,
    )
    micro_fields = ("box_six_yard_ratio", "box_penalty_spot_ratio", "box_wide_ratio")
    def spatial_values(field: str) -> dict[str, float]:
        return {
            peer_id: float(row[field])
            for peer_id, row in spatial_rows.items()
            if row is not None and row.get(field) is not None
        }

    in_box_scores = _scores_from_population({
        peer_id: peer.in_box_finishing_per90
        for peer_id, peer in peers.items() if peer.in_box_finishing_per90 is not None
    })
    dribble_scores = _scores_from_population({
        peer_id: peer.dribble_margin_per90
        for peer_id, peer in peers.items() if peer.dribble_margin_per90 is not None
    })
    micro_values = {
        peer_id: float(values["deep_box_zone_score"])
        for peer_id, values in spatial_rows.items()
        if values is not None
        and values.get("deep_box_zone_score") is not None
        and sum(float(values.get(field) or 0.0) for field in (
            "box_six_yard_ratio", "box_penalty_spot_ratio", "box_wide_ratio",
        )) > 0.0
    }
    danger_values = spatial_values("danger_zone_density")
    cca_values = spatial_values("cca_area_pct")
    out_box_scores = _scores_from_population({
        peer_id: peer.out_box_shot_quality
        for peer_id, peer in peers.items() if peer.out_box_shot_quality is not None
    })
    micro_scores = _scores_from_population(micro_values)
    danger_scores = _scores_from_population(danger_values)
    cca_scores = _scores_from_population(cca_values)
    aerial_scores = _scores_from_population({
        peer_id: peer.aerial_margin_per90
        for peer_id, peer in peers.items() if peer.aerial_margin_per90 is not None
    })
    duel_scores = _scores_from_population({
        peer_id: peer.duel_margin_per90
        for peer_id, peer in peers.items() if peer.duel_margin_per90 is not None
    })
    combined_duel_volume_scores = _blend_volume_ratio_scores(
        volume_scores["ground"], volume_scores["aerial"], peers,
    )
    combined_duel_efficiency_scores = _blend_volume_ratio_scores(
        duel_scores, aerial_scores, peers,
    )
    deep_box_scores = {
        peer_id: round(0.70 * in_box_scores[peer_id] + 0.30 * micro_scores.get(peer_id, 0.0), 2)
        for peer_id, row in spatial_rows.items()
        if peer_id in in_box_scores and row is not None
    }
    base_deep_box_scores = dict(deep_box_scores)
    danger_progression_scores = _combined_scores(dribble_scores, danger_scores, 0.70)
    sector_scores = {
        # Each M.E.S.S.I. sector is the exact pair visualised by the volume ×
        # ratio grid: equal credit for repeated involvement and effectiveness.
        "outside_box": _blend_volume_ratio_scores(volume_scores["outside_box"], out_box_scores, peers),
        "box": _blend_volume_ratio_scores(volume_scores["box"], base_deep_box_scores, peers),
        "danger": _blend_volume_ratio_scores(volume_scores["dribble"], danger_progression_scores, peers),
        "aerial": _blend_volume_ratio_scores(volume_scores["aerial"], aerial_scores, peers),
        "ground": _blend_volume_ratio_scores(volume_scores["ground"], duel_scores, peers),
        "space": _blend_volume_ratio_scores(cca_scores, danger_scores, peers),
        "duel": _blend_volume_ratio_scores(
            combined_duel_volume_scores, combined_duel_efficiency_scores, peers,
        ),
        "press": _blend_volume_ratio_scores(
            recovery_scores, final_third_press_scores, peers,
        ),
    }
    imputed_volume_attrs = tuple(
        attr for attr, source in (
            ("outside_box_shots_attempts_top_percent", volume_scores["outside_box"]),
            ("box_shots_volume_top_percent", volume_scores["box"]),
            ("dribble_attempts_volume_top_percent", volume_scores["dribble"]),
            ("aerial_duel_attempts_volume_top_percent", volume_scores["aerial"]),
            ("ground_duel_attempts_volume_top_percent", volume_scores["ground"]),
            ("cca_area_top_percent", cca_scores),
        ) if player_key not in source
    )
    imputed_ratio_attrs = tuple(
        attr for attr, source in (
            ("out_box_shot_quality_top_percent", out_box_scores),
            ("micro_zoning_finishing_top_percent", base_deep_box_scores),
            ("danger_zone_progression_top_percent", danger_progression_scores),
            ("aerial_margin_per90_top_percent", aerial_scores),
            ("duel_margin_per90_top_percent", duel_scores),
            ("danger_zone_density_top_percent", danger_scores),
        ) if player_key not in source
    )
    micro_pct, micro_rank = _rank_score(player_key, micro_scores)
    deep_box_pct, deep_box_rank = _rank_score(player_key, deep_box_scores)
    danger_pct, danger_rank = _rank_score(player_key, danger_progression_scores)
    cca_pct, cca_rank = _rank_score(player_key, cca_scores)
    danger_density_pct, danger_density_rank = _rank_score(player_key, danger_scores)
    combined_duel_volume_pct, combined_duel_volume_rank = _rank_score(
        player_key, combined_duel_volume_scores,
    )
    combined_duel_efficiency_pct, combined_duel_efficiency_rank = _rank_score(
        player_key, combined_duel_efficiency_scores,
    )
    recoveries_pct, recoveries_rank = _rank_score(player_key, recovery_scores)
    final_third_press_pct, final_third_press_rank = _rank_score(
        player_key, final_third_press_scores,
    )
    combined_duel_pct, combined_duel_rank = _rank_score(player_key, sector_scores["duel"])
    forward_press_pct, forward_press_rank = _rank_score(player_key, sector_scores["press"])
    # Role is descriptive only. Every player uses the same six-factor formula;
    # Type B no longer receives a masked box score or a score shield.
    common_weights = (
        (sector_scores["box"], 0.30), (sector_scores["outside_box"], 0.20),
        (sector_scores["danger"], 0.15), (sector_scores["space"], 0.15),
        (sector_scores["aerial"], 0.10), (sector_scores["ground"], 0.10),
    )
    pressing_weights = (
        (sector_scores["box"], 0.30), (sector_scores["outside_box"], 0.20),
        (sector_scores["danger"], 0.15), (sector_scores["space"], 0.15),
        (sector_scores["duel"], 0.10), (sector_scores["press"], 0.10),
    )

    def is_type_b(peer_id: str) -> bool:
        row = spatial_rows.get(peer_id)
        if row is None:
            return False
        return float(row.get("in_box_ratio") or 0.0) < 15.0

    def weighted_score(peer_id: str, weights) -> Optional[float]:
        values = []
        for scores, weight in weights:
            if peer_id in scores:
                values.append((scores[peer_id], weight))
            else:
                return None
        return round(sum(value * weight for value, weight in values), 2)

    original_spear_scores = {
        peer_id: score
        for peer_id in peers
        if (score := weighted_score(peer_id, common_weights)) is not None
    }
    original_type_b = is_type_b(player_key)
    active_type_b = original_type_b if role_override not in {"type_a", "type_b"} else role_override == "type_b"
    spear_scores = dict(original_spear_scores)
    active_score = weighted_score(player_key, common_weights)
    if active_score is not None:
        spear_scores[player_key] = active_score
    # ``_rank_score`` returns ``100 - score`` for percentile-normalised single
    # metrics.  A weighted M.E.S.S.I. total is not itself a percentile, so its
    # visible top percentage must instead come from its actual rank and the
    # full score cohort (e.g. 1st / 673 = top 0.1%, never 100 - 82.5 = 17.5%).
    _, spear_score_rank = _rank_score(player_key, spear_scores)
    spear_score_top_percent = (
        round((spear_score_rank / len(spear_scores)) * 100.0, 1)
        if spear_score_rank is not None and spear_scores else None
    )
    # Tier and rank use the same volume-and-ratio blended M.E.S.S.I. score.
    spear_score = spear_scores.get(player_key)
    pressing_spear_scores = {
        peer_id: score
        for peer_id in peers
        if (score := weighted_score(peer_id, pressing_weights)) is not None
    }
    _, spear_pressing_score_rank = _rank_score(player_key, pressing_spear_scores)
    spear_pressing_score_top_percent = (
        round((spear_pressing_score_rank / len(pressing_spear_scores)) * 100.0, 1)
        if spear_pressing_score_rank is not None and pressing_spear_scores else None
    )
    spear_pressing_score = pressing_spear_scores.get(player_key)
    pressing_imputed_volume_attrs = tuple(
        attr for attr, source in (
            ("combined_duel_volume_top_percent", combined_duel_volume_scores),
            ("recoveries_per90_top_percent", recovery_scores),
        ) if player_key not in source
    )
    pressing_imputed_ratio_attrs = tuple(
        attr for attr, source in (
            ("combined_duel_efficiency_top_percent", combined_duel_efficiency_scores),
            ("final_third_possessions_won_per90_top_percent", final_third_press_scores),
        ) if player_key not in source
    )
    progression_eligible = int(progression_percentiles["cohort_count"])
    duels_eligible = progression_eligible
    aerials_eligible = progression_eligible
    
    return LeaguePercentiles(
        goals_top_percent=goals_pct,
        goals_rank=goals_rk,
        xg_top_percent=xg_pct,
        xg_rank=xg_rk,
        shot_quality_top_percent=sq_pct,
        shot_quality_rank=sq_rk,
        overall_finishing_top_percent=of_pct,
        overall_finishing_rank=of_rk,
        gk_impact_top_percent=gk_pct,
        gk_impact_rank=gk_rk,
        eligible_players=eligible_players_count,
        goals_median=goals_median,
        shot_quality_median=shot_quality_median,
        overall_finishing_median=overall_finishing_median,
        gk_impact_median=gk_impact_median,
        in_box_finishing_top_percent=in_box_pct,
        in_box_finishing_rank=in_box_rank,
        in_box_finishing_median=float(pd.Series(in_box_population).median()) if in_box_population else None,
        out_box_shot_quality_top_percent=out_box_pct,
        out_box_shot_quality_rank=out_box_rank,
        out_box_shot_quality_median=float(pd.Series(out_box_population).median()) if out_box_population else None,
        duels_pct_top_percent=duels_pct,
        duels_pct_rank=duels_rk,
        duels_eligible=duels_eligible,
        dribbles_pct_top_percent=dribbles_pct,
        dribbles_pct_rank=dribbles_rk,
        dribbles_eligible=dribbles_eligible,
        aerials_pct_top_percent=aerials_pct,
        aerials_pct_rank=aerials_rk,
        aerials_eligible=aerials_eligible,
        elite_dribbler_eligible=int(progression_percentiles["cohort_count"]),
        dribbles_succeeded_per90_top_percent=progression_percentiles["success_pct"],
        dribbles_succeeded_per90_rank=progression_percentiles["success_rank"],
        dribbles_failed_per90_top_percent=progression_percentiles["failure_pct"],
        dribbles_failed_per90_rank=progression_percentiles["failure_rank"],
        dribbles_failed_eligible=int(progression_percentiles["cohort_count"]),
        dribble_margin_per90_top_percent=progression_percentiles["dribble_margin_pct"],
        dribble_margin_per90_rank=progression_percentiles["dribble_margin_rank"],
        duels_won_per90_top_percent=progression_percentiles["duels_won_pct"],
        duels_won_per90_rank=progression_percentiles["duels_won_rank"],
        duels_lost_per90_top_percent=progression_percentiles["duels_lost_pct"],
        duels_lost_per90_rank=progression_percentiles["duels_lost_rank"],
        duel_margin_per90_top_percent=progression_percentiles["duel_margin_pct"],
        duel_margin_per90_rank=progression_percentiles["duel_margin_rank"],
        aerials_won_per90_top_percent=progression_percentiles["aerials_won_pct"],
        aerials_won_per90_rank=progression_percentiles["aerials_won_rank"],
        aerials_lost_per90_top_percent=progression_percentiles["aerials_lost_pct"],
        aerials_lost_per90_rank=progression_percentiles["aerials_lost_rank"],
        aerial_margin_per90_top_percent=progression_percentiles["aerial_margin_pct"],
        aerial_margin_per90_rank=progression_percentiles["aerial_margin_rank"],
        xg_per90_top_percent=progression_percentiles["xg_per90_pct"],
        xg_per90_rank=progression_percentiles["xg_per90_rank"],
        progression_eligible=progression_eligible,
        net_progression_top_percent=progression_percentiles["net_pct"],
        net_progression_rank=progression_percentiles["net_rank"],
        net_progression_eligible=int(progression_percentiles["net_count"]),
        total_shots_volume_top_percent=total_shots_pct,
        total_shots_volume_rank=total_shots_rank,
        outside_box_shots_attempts_top_percent=outside_box_shots_pct,
        outside_box_shots_attempts_rank=outside_box_shots_rank,
        box_shots_volume_top_percent=box_shots_pct,
        box_shots_volume_rank=box_shots_rank,
        dribble_attempts_volume_top_percent=dribble_attempts_pct,
        dribble_attempts_volume_rank=dribble_attempts_rank,
        aerial_duel_attempts_volume_top_percent=aerial_attempts_pct,
        aerial_duel_attempts_volume_rank=aerial_attempts_rank,
        ground_duel_attempts_volume_top_percent=ground_attempts_pct,
        ground_duel_attempts_volume_rank=ground_attempts_rank,
        xg_volume_top_percent=xg_volume_pct,
        xg_volume_rank=xg_volume_rank,
        spear_volume_eligible=len(peers),
        micro_zoning_finishing_top_percent=deep_box_pct,
        micro_zoning_finishing_rank=deep_box_rank,
        danger_zone_progression_top_percent=danger_pct,
        danger_zone_progression_rank=danger_rank,
        cca_area_top_percent=cca_pct,
        cca_area_rank=cca_rank,
        danger_zone_density_top_percent=danger_density_pct,
        danger_zone_density_rank=danger_density_rank,
        combined_duel_volume_top_percent=combined_duel_volume_pct,
        combined_duel_volume_rank=combined_duel_volume_rank,
        combined_duel_efficiency_top_percent=combined_duel_efficiency_pct,
        combined_duel_efficiency_rank=combined_duel_efficiency_rank,
        recoveries_per90_top_percent=recoveries_pct,
        recoveries_per90_rank=recoveries_rank,
        final_third_possessions_won_per90_top_percent=final_third_press_pct,
        final_third_possessions_won_per90_rank=final_third_press_rank,
        combined_duel_top_percent=combined_duel_pct,
        combined_duel_rank=combined_duel_rank,
        forward_press_top_percent=forward_press_pct,
        forward_press_rank=forward_press_rank,
        spear_shot_quality_top_percent=spear_sq_pct,
        spear_shot_quality_rank=spear_sq_rk,
        spear_score=spear_score,
        spear_score_rank=spear_score_rank,
        spear_score_top_percent=spear_score_top_percent,
        spear_score_eligible=len(spear_scores),
        spear_imputed_volume_attrs=imputed_volume_attrs,
        spear_imputed_ratio_attrs=imputed_ratio_attrs,
        pressing_imputed_volume_attrs=pressing_imputed_volume_attrs,
        pressing_imputed_ratio_attrs=pressing_imputed_ratio_attrs,
        spear_pressing_score=spear_pressing_score,
        spear_pressing_score_rank=spear_pressing_score_rank,
        spear_pressing_score_top_percent=spear_pressing_score_top_percent,
        spear_pressing_score_eligible=len(pressing_spear_scores),
        is_type_b=active_type_b,
        spear_role="Type B · 2선 지향/펄스 나인" if active_type_b else "Type A · 정통 타겟/포처",
    )


def _season_league_metric(player_id: str, season_name: str, league_id: int) -> Optional[DecisionMetrics]:
    """Fetch one league-season's full Shotmap-derived metrics for a player."""
    try:
        short_season = f"{season_name[:4][-2:]}/{season_name[-4:][-2:]}" if len(season_name) == 9 else season_name
        parsed = extract_multi_season_metrics(fetch_player_multi_season_data(player_id))
        for season_key, metric in parsed.items():
            if season_key.startswith(f"{short_season}_") and metric.league_id == league_id:
                return metric
    except Exception:
        return None
    return None


@functools.lru_cache(maxsize=16)
def get_top_leagues_shot_quality(
    season: str = "25/26", minimum_final_third_ratio: int = 0,
) -> dict[str, pd.DataFrame]:
    """Return TOP 20 tables sorted by Shotmap-derived in-box finishing."""
    leagues = {"Premier League": 47, "LaLiga": 87, "Bundesliga": 54, "Serie A": 55, "Champions League": 42}
    season_name = f"20{season[:2]}/20{season[3:]}"
    all_results: list[dict] = []
    league_results: dict[str, list[dict]] = {league: [] for league in leagues}

    jobs: list[tuple[str, int, str, str]] = []
    for league_name, league_id in leagues.items():
        try:
            xg_rows = fetch_league_stat_table(league_id, season_name, "expected_goals")
            # Preserve the old volume floor: it protects the board from a single
            # low-volume shot while the new sorting metric remains strictly in-box.
            leaderboard_min_xg = 1.5 if league_id == 42 else 5.0
            jobs.extend(
                (league_name, league_id, str(row.get("id")), row.get("name", "Unknown"))
                for row in xg_rows if (_value(row) or 0.0) >= leaderboard_min_xg
            )
        except Exception:
            continue

    def fetch_candidate(job: tuple[str, int, str, str]) -> tuple[str, str, Optional[DecisionMetrics]]:
        league_name, league_id, player_id, name = job
        return league_name, name, _season_league_metric(player_id, season_name, league_id)

    # All five leagues are fetched together: serial per-league pools would make
    # the initial board load several times slower even though each request is I/O-bound.
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
        for (league_name, league_id, player_id, _), (result_league, name, metric) in zip(jobs, executor.map(fetch_candidate, jobs)):
            if league_name != result_league or metric is None:
                continue
            if not passes_final_third_filter(
                player_id, minimum_final_third_ratio, metric.league_name or league_name, season_name,
            ):
                continue
            if metric.in_box_finishing is None:
                continue
            row_data = {
                "선수": name,
                "리그": league_name,
                "박스 안 순수 결정력 (xGOT-xG)": round(metric.in_box_finishing, 2),
                "박스 안 득점": int(metric.in_box_goals or 0),
                "박스 안 xG": round(metric.in_box_xg or 0.0, 2),
                "박스 안 xGOT": round(metric.in_box_xgot or 0.0, 2),
            }
            league_results[league_name].append(row_data)
            if league_name != "Champions League":
                all_results.append(row_data)

    sort_column = "박스 안 순수 결정력 (xGOT-xG)"
    final_dfs: dict[str, pd.DataFrame] = {}
    for league_name, rows in {"통합": all_results, **league_results}.items():
        dataframe = pd.DataFrame(rows)
        if not dataframe.empty:
            if league_name != "통합":
                dataframe = dataframe.drop(columns=["리그"], errors="ignore")
            dataframe = dataframe.sort_values(sort_column, ascending=False).head(20).reset_index(drop=True)
            dataframe.index = dataframe.index + 1
        final_dfs[league_name] = dataframe
    return final_dfs
