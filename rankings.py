"""League-season percentile calculations for striker metrics."""

from __future__ import annotations

import concurrent.futures
import functools
from dataclasses import dataclass
from typing import Optional
import pandas as pd

from fotmob_client import (
    FotMobError,
    fetch_league_stat_table,
    fetch_player_multi_season_data,
)
from metrics import DecisionMetrics, extract_multi_season_metrics
from spear_cohort import get_static_spear_cohort
from tactical_ratio import get_tactical_ratio_for_session, passes_final_third_filter


MINIMUM_SPEAR_XG = 1.0
CUP_COMPETITION_IDS = frozenset({42, 73, 102})
LEAGUE_MINIMUM_MINUTES = 450.0
CUP_MINIMUM_MINUTES = 180.0
COMPARISON_SCOPES = {
    3: frozenset({47, 55, 87}),
    5: frozenset({47, 53, 54, 55, 87}),
    7: frozenset({47, 53, 54, 55, 57, 61, 87}),
}


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
    spear_shot_quality_top_percent: Optional[float] = None
    spear_shot_quality_rank: Optional[int] = None
    spear_score: Optional[float] = None
    spear_score_rank: Optional[int] = None
    spear_score_top_percent: Optional[float] = None
    spear_score_eligible: int = 0
    false_nine_penalty: bool = False
    spear_role: str = "Type A · 정통 타겟/포처"


def _minimum_minutes_for_competition(league_id: int) -> float:
    return CUP_MINIMUM_MINUTES if league_id in CUP_COMPETITION_IDS else LEAGUE_MINIMUM_MINUTES


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
    
    # Seed with every listed player; no contest-stat cutoff.
    successes = {
        str(row.get("id")): 0.0
        for row in rows
        if row.get("id") is not None
    }

    def fetch_one(player_id: str) -> tuple[str, Optional[DecisionMetrics]]:
        try:
            if len(season_name) == 9 and "/" in season_name:
                start_year, end_year = season_name.split("/", 1)
                short_season = f"{start_year[-2:]}/{end_year[-2:]}"
            else:
                short_season = season_name

            parsed = extract_multi_season_metrics(fetch_player_multi_season_data(player_id))
            for season_key, stat_obj in parsed.items():
                if season_key.startswith(f"{short_season}_") and stat_obj.league_id == league_id:
                    return player_id, stat_obj
        except (FotMobError, StopIteration, ValueError):
            pass
        return player_id, None

    metrics_by_player: dict[str, DecisionMetrics] = {}
    # Multi-season requests fetch several records per player. This matches the
    # concurrency already used by the xGOT fallback and keeps large leagues responsive.
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        for player_id, metric in executor.map(fetch_one, successes):
            if metric is not None:
                metrics_by_player[player_id] = metric
    # S.P.E.A.R., pure progression, and finishing all share one transparent
    # population: every player in the selected competition with xG >= 1.
    # Keep ``restrict_to_forwards`` in the signature for cached-call
    # compatibility; it intentionally no longer narrows this population.
    metrics_by_player = {
        player_id: metric for player_id, metric in metrics_by_player.items()
        if (metric.xg or 0.0) >= MINIMUM_SPEAR_XG
        and (metric.minutes_played or 0.0) >= _minimum_minutes_for_competition(league_id)
    }
    metrics_by_player = {
        player_id: metric for player_id, metric in metrics_by_player.items()
        if passes_final_third_filter(player_id, minimum_final_third_ratio)
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
        # selected; only domestic competitions use the 3/5/7 league unions.
        target_leagues = (
            frozenset({league_id}) if league_id in CUP_COMPETITION_IDS
            else COMPARISON_SCOPES.get(comparison_scope, frozenset({league_id}))
        )
        static_metrics = {}
        for target_league_id in target_leagues:
            cohort_metrics, _ = get_static_spear_cohort(target_league_id, season_name)
            static_metrics.update({
                player_id: metric for player_id, metric in cohort_metrics.items()
                if (metric.xg or 0.0) >= MINIMUM_SPEAR_XG
                and (metric.minutes_played or 0.0) >= _minimum_minutes_for_competition(
                    metric.league_id or target_league_id
                )
                and passes_final_third_filter(player_id, minimum_final_third_ratio)
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


def _spear_rating_from_rank(rank: Optional[int], population_size: int) -> Optional[float]:
    """Map a cohort rank to a stable 0–100 S.P.E.A.R. rating.

    Factor percentiles are already relative to the active comparison cohort,
    but a weighted average of those percentiles rarely reaches 95.  Showing
    that raw average as a final rating made the cohort leader appear as a
    B-tier player.  The final rating therefore uses the player's resulting
    cohort rank: rank 1 is 100, the final rank is 0, and the intermediate
    values are linearly interpolated.
    """
    if rank is None or population_size <= 0:
        return None
    if population_size == 1:
        return 50.0
    return round(100.0 * (1.0 - ((rank - 1) / (population_size - 1))), 1)


@functools.lru_cache(maxsize=32)
def get_spear_leaderboard(
    league_id: int, season_name: str, comparison_scope: int = 0,
) -> pd.DataFrame:
    """Build an API-free S.P.E.A.R. list from the static cohort snapshot.

    The list intentionally never falls back to the live player fan-out.  A
    missing historical snapshot should show a clear unavailable state, rather
    than spending requests while a user scrolls the scouting board.
    """
    target_leagues = (
        frozenset({league_id}) if league_id in CUP_COMPETITION_IDS
        else COMPARISON_SCOPES.get(comparison_scope, frozenset({league_id}))
    )
    peers: dict[str, DecisionMetrics] = {}
    names: dict[str, str] = {}
    for target_id in target_leagues:
        metrics, cohort_names = get_static_spear_cohort(target_id, season_name)
        for player_id, metric in metrics.items():
            if ((metric.xg or 0.0) >= MINIMUM_SPEAR_XG
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
    deep_scores = _combined_scores(in_box_scores, scores(micro_raw), 0.70)
    danger_scores = scores(spatial_values("danger_zone_density"))
    cca_scores = scores(spatial_values("cca_area_pct"))
    progression_scores = _combined_scores(dribble_scores, danger_scores, 0.70)

    records: list[dict[str, object]] = []
    for player_id, metric in peers.items():
        row = spatial.get(player_id)
        box_ratio = float(row.get("in_box_ratio") or 0.0) if row else 0.0
        micro_total = sum(float(row.get(field) or 0.0) for field in micro_fields) if row else 0.0
        is_type_b = box_ratio < 15.0 or micro_total <= 0.0
        weights = (
            ((progression_scores, 0.30), (cca_scores, 0.30), (shot_scores, 0.25), (duel_scores, 0.10), (aerial_scores, 0.05))
            if is_type_b else
            ((deep_scores, 0.30), (shot_scores, 0.20), (progression_scores, 0.15), (cca_scores, 0.15), (aerial_scores, 0.10), (duel_scores, 0.10))
        )
        if not all(player_id in source for source, _ in weights):
            continue
        score = round(sum(source[player_id] * weight for source, weight in weights), 2)
        def factor_tier(source: dict[str, float]) -> str:
            return _spear_tier(source[player_id]) if player_id in source else "-"
        records.append({
            "player_id": player_id, "player_name": names.get(player_id, "Unknown"),
            "team_name": metric.team_name or "정보 미제공",
            "league_name": metric.league_name or "대회 정보 미제공",
            # Keep the weighted factor value only for deterministic sorting.
            # The displayed S.P.E.A.R. rating is assigned from final cohort
            # rank below so tiers always describe relative standing correctly.
            "raw_score": score,
            "role": "Type B" if is_type_b else "Type A",
            "position": metric.position or metric.position_group or "미분류",
            "outside_shot_tier": factor_tier(shot_scores),
            "deep_box_tier": factor_tier(deep_scores),
            "danger_zone_tier": factor_tier(progression_scores),
            "aerial_tier": factor_tier(aerial_scores),
            "ground_duel_tier": factor_tier(duel_scores),
            "space_control_tier": factor_tier(cca_scores),
        })
    table = pd.DataFrame(records)
    if table.empty:
        return pd.DataFrame(columns=["rank", "player_id", "player_name", "team_name", "score", "tier", "role"])
    table = table.sort_values(["raw_score", "player_name"], ascending=[False, True], kind="stable").reset_index(drop=True)
    table.insert(0, "rank", table.index + 1)
    population_size = len(table)
    table["score"] = table["rank"].map(lambda rank: _spear_rating_from_rank(int(rank), population_size))
    table["tier"] = table["score"].map(_spear_tier)
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


@functools.lru_cache(maxsize=64)
def get_tactical_matrix(
    league_id: int, season_name: str, restrict_to_forwards: bool = True,
    minimum_final_third_ratio: int = 0,
) -> pd.DataFrame:
    """Return the elite-dribbler cohort used in the tactical quadrant chart.

    Both axes are available only after the player-level fetch: Net Progression
    is composed from five event stats, while finishing is in-box xGOT minus xG.
    """
    peers, _ = _fetch_elite_dribbler_metrics(league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)
    leaderboard_rows = fetch_league_stat_table(league_id, season_name, "minutes_played")
    names = {
        str(row.get("id")): (str(row.get("name") or "").strip() or "선수 정보 미제공")
        for row in leaderboard_rows
    }
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


@functools.lru_cache(maxsize=32)
def _fetch_fallback_xgot(season: str, pids: tuple) -> dict:
    mapping = {}
    if len(season) == 5 and "/" in season:
        s1, s2 = season.split("/")
        possible_seasons = [season, f"20{s1}/20{s2}", f"20{s1}/{s2}"]
    else:
        possible_seasons = [season]

    def fetch_individual(pid: str) -> tuple[str, Optional[float]]:
        try:
            raw_data = fetch_player_multi_season_data(pid)
            stats = extract_multi_season_metrics(raw_data)
            for key, stat_obj in stats.items():
                if any(ps in key for ps in possible_seasons) and stat_obj.xgot is not None:
                    return pid, stat_obj.xgot
        except Exception:
            pass
        return pid, None
        
    with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
        for pid, xgot_val in executor.map(fetch_individual, pids):
            if xgot_val is not None:
                mapping[pid] = xgot_val
    return mapping


def calculate_league_percentiles(
    player_id: str, season: str, metrics: DecisionMetrics, minimum_xg: float = 1.0,
    restrict_to_forwards: bool = True, minimum_final_third_ratio: int = 0,
    comparison_scope: int = 0, role_override: str = "auto",
) -> LeaguePercentiles:
    if metrics.league_id is None:
        return LeaguePercentiles(None, None, None, None, None, None, None, None, None, None, 0)
    
    season_name = f"20{season[:2]}/20{season[3:]}" if len(season) == 5 and "/" in season else season
    player_key = str(player_id)
    
    # 1. 득점 및 xG 관련 지표
    goals_rows = fetch_league_stat_table(metrics.league_id, season_name, "goals")
    xg_rows = fetch_league_stat_table(metrics.league_id, season_name, "expected_goals")
    
    goals_by_player = {str(row.get("id")): _value(row) for row in goals_rows if _value(row) is not None}
    xg_by_player = {str(row.get("id")): _value(row) for row in xg_rows if _value(row) is not None}
    
    xgot_by_player = {}
    try:
        # 수정됨: 올바른 API 키 적용 (언더스코어 제거)
        xgot_rows = fetch_league_stat_table(metrics.league_id, season_name, "expected_goalsontarget")
        xgot_by_player = {str(row.get("id")): _value(row) for row in xgot_rows if _value(row) is not None}
    except Exception:
        pass

    if not xgot_by_player:
        target_pids = tuple(pid for pid, xg in xg_by_player.items() if xg >= minimum_xg)
        fallback_xgot = _fetch_fallback_xgot(season, target_pids)
        xgot_by_player.update(fallback_xgot)

    if player_key not in xgot_by_player and metrics.xgot is not None:
        xgot_by_player[player_key] = metrics.xgot

    player_goals = goals_by_player.get(player_key, 0.0)
    player_xg = xg_by_player.get(player_key)
    player_xgot = xgot_by_player.get(player_key)

    player_sq = player_xgot - player_xg if (player_xg is not None and player_xgot is not None) else None
    player_of = player_goals - player_xg if player_xg is not None else None
    player_gk = player_goals - player_xgot if player_xgot is not None else None

    valid_pids = {
        pid for pid, xg in xg_by_player.items()
        if xg >= minimum_xg and passes_final_third_filter(pid, minimum_final_third_ratio)
    }
    
    goal_population = [goals_by_player.get(pid, 0.0) for pid in valid_pids]
    xg_population = [xg_by_player[pid] for pid in valid_pids]
    shot_quality_population = [xgot_by_player.get(key, 0.0) - xg for key, xg in xg_by_player.items() if key in valid_pids and key in xgot_by_player]
    overall_finishing_population = [goals_by_player.get(key, 0.0) - xg for key, xg in xg_by_player.items() if key in valid_pids]
    gk_impact_population = [goals_by_player.get(key, 0.0) - xgot_by_player.get(key, 0.0) for key, xg in xg_by_player.items() if key in valid_pids and key in xgot_by_player]

    goals_median = float(pd.Series(goal_population).median()) if goal_population else None
    shot_quality_median = float(pd.Series(shot_quality_population).median()) if shot_quality_population else None
    overall_finishing_median = float(pd.Series(overall_finishing_population).median()) if overall_finishing_population else None
    gk_impact_median = float(pd.Series(gk_impact_population).median()) if gk_impact_population else None
        
    goals_pct, goals_rk = _rank_info(player_goals, goal_population)
    xg_pct, xg_rk = _rank_info(player_xg, xg_population)
    sq_pct, sq_rk = _rank_info(player_sq, shot_quality_population)
    of_pct, of_rk = _rank_info(player_of, overall_finishing_population)
    gk_pct, gk_rk = _rank_info(player_gk, gk_impact_population)
    
    eligible_players_count = len(valid_pids)

    # 💡 2. 드리블 성공률 (%) 수정됨: won_contest의 substatValue 사용
    dribbles_pct, dribbles_rk, dribbles_eligible = None, None, 0
    try:
        dribbles_rows = fetch_league_stat_table(metrics.league_id, season_name, "won_contest")
        # _sub_value 헬퍼를 사용하여 퍼센트 추출
        dribbles_pct_dict = {str(r.get("id")): _sub_value(r) for r in dribbles_rows if _sub_value(r) is not None}
        
        if dribbles_pct_dict:
            population = list(dribbles_pct_dict.values())
            dribbles_eligible = len(population)
            if player_key in dribbles_pct_dict:
                dribbles_pct, dribbles_rk = _rank_info(dribbles_pct_dict[player_key], population)
    except Exception:
        pass

    duels_pct, duels_rk = None, None
    aerials_pct, aerials_rk = None, None
    peers, _ = _fetch_elite_dribbler_metrics(
        metrics.league_id, season_name, restrict_to_forwards, minimum_final_third_ratio, comparison_scope,
    )
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

    # Rebind every finishing/goal value to the same filtered cohort as the
    # progression and S.P.E.A.R. factors.
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
    player_box_ratio = float(player_spatial.get("in_box_ratio") or 0.0) if player_spatial else 0.0
    player_micro_total = sum(float(player_spatial.get(field) or 0.0) for field in micro_fields) if player_spatial else 0.0
    false_nine_penalty = player_box_ratio < 15.0 or player_micro_total <= 0.0

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
    deep_box_scores = _combined_scores(in_box_scores, micro_scores, 0.70)
    base_deep_box_scores = dict(deep_box_scores)
    if false_nine_penalty:
        # This is a tactical penalty, not an absent-data neutral score: a
        # player who does not enter the box cannot qualify as a striker on the
        # deep-box axis even if he contributes well as a linking False 9.
        micro_scores[player_key] = 0.0
        if player_key in in_box_scores:
            deep_box_scores[player_key] = 0.0
    danger_progression_scores = _combined_scores(dribble_scores, danger_scores, 0.70)
    micro_pct, micro_rank = _rank_score(player_key, micro_scores)
    deep_box_pct, deep_box_rank = _rank_score(player_key, deep_box_scores)
    if false_nine_penalty:
        deep_box_pct, deep_box_rank = 100.0, max(1, len(peers))
    danger_pct, danger_rank = _rank_score(player_key, danger_progression_scores)
    cca_pct, cca_rank = _rank_score(player_key, cca_scores)
    danger_density_pct, danger_density_rank = _rank_score(player_key, danger_scores)
    # Dynamic S.P.E.A.R. 2.0 role weights. Type B excludes deep-box efficiency
    # from the total while its radar axis remains 0/D as a role description.
    type_a_weights = (
        (base_deep_box_scores, 0.30), (spear_shot_scores, 0.20),
        (danger_progression_scores, 0.15), (cca_scores, 0.15),
        (aerial_scores, 0.10), (duel_scores, 0.10),
    )
    type_b_weights = (
        (danger_progression_scores, 0.30), (cca_scores, 0.30),
        (spear_shot_scores, 0.25), (duel_scores, 0.10),
        (aerial_scores, 0.05),
    )

    def is_type_b(peer_id: str) -> bool:
        row = spatial_rows.get(peer_id)
        if row is None:
            return True
        zone_total = sum(float(row.get(field) or 0.0) for field in micro_fields)
        return float(row.get("in_box_ratio") or 0.0) < 15.0 or zone_total <= 0.0

    def weighted_score(peer_id: str, weights, deep_floor: Optional[float] = None) -> Optional[float]:
        values = []
        for scores, weight in weights:
            if scores is base_deep_box_scores and deep_floor is not None:
                values.append((deep_floor, weight))
            elif peer_id in scores:
                values.append((scores[peer_id], weight))
            else:
                return None
        return round(sum(value * weight for value, weight in values), 2)

    def tier_for_score(score: Optional[float]) -> str:
        if score is None:
            return "C"
        if score >= 95:
            return "S"
        if score >= 85:
            return "A"
        if score >= 65:
            return "B"
        if score >= 35:
            return "C"
        return "D"

    soft_floor_by_tier = {"S": 60.0, "A": 50.0, "B": 40.0, "C": 30.0, "D": 30.0}
    original_spear_scores = {
        peer_id: score
        for peer_id in peers
        if (score := weighted_score(peer_id, type_b_weights if is_type_b(peer_id) else type_a_weights)) is not None
    }
    original_type_b = is_type_b(player_key)
    original_score = original_spear_scores.get(player_key)
    original_rank = (
        1 + sum(score > original_score for score in original_spear_scores.values())
        if original_score is not None else None
    )
    original_rating = _spear_rating_from_rank(original_rank, len(original_spear_scores))
    original_tier = tier_for_score(original_rating)
    active_type_b = original_type_b if role_override not in {"type_a", "type_b"} else role_override == "type_b"
    role_mismatch = active_type_b != original_type_b

    # Keep every peer at their original tactical role, and replace only the
    # simulated player's value when the role switch is toggled.
    spear_scores = dict(original_spear_scores)
    active_weights = type_b_weights if active_type_b else type_a_weights
    # A Soft Floor is only an absent-stat defence.  If a naturally deep-lying
    # player actually has enough box data, preserve that observed value when
    # the user simulates him as a conventional No. 9.
    missing_deep_box_score = player_key not in base_deep_box_scores
    deep_floor = (
        soft_floor_by_tier[original_tier]
        if role_mismatch and original_type_b and not active_type_b and missing_deep_box_score
        else None
    )
    active_score = weighted_score(player_key, active_weights, deep_floor)
    if active_score is not None:
        spear_scores[player_key] = active_score
    if active_type_b:
        deep_box_pct, deep_box_rank = 100.0, max(1, len(peers))
    elif deep_floor is not None:
        deep_box_pct = round(100.0 - deep_floor, 1)
        deep_box_rank = 1 + sum(score > deep_floor for score in base_deep_box_scores.values())
    spear_score_top_percent, spear_score_rank = _rank_score(player_key, spear_scores)
    # ``spear_scores`` remains a weighted percentile average for ranking and
    # role-simulation calculations.  Expose a rank-normalised 0–100 rating to
    # the UI so the score and S/A/B/C/D tiers communicate cohort standing.
    spear_score = _spear_rating_from_rank(spear_score_rank, len(spear_scores))
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
        spear_shot_quality_top_percent=spear_sq_pct,
        spear_shot_quality_rank=spear_sq_rk,
        spear_score=spear_score,
        spear_score_rank=spear_score_rank,
        spear_score_top_percent=spear_score_top_percent,
        spear_score_eligible=len(spear_scores),
        false_nine_penalty=active_type_b,
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
            if league_name != result_league or not passes_final_third_filter(player_id, minimum_final_third_ratio):
                continue
            if metric is None or metric.in_box_finishing is None:
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
