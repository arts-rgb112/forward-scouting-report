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
from tactical_ratio import passes_final_third_filter


MINIMUM_SPEAR_MINUTES = 900.0
MINIMUM_SPEAR_XG = 1.0


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


def _is_forward_or_midfielder(metric: DecisionMetrics) -> bool:
    """Use provider major position groups, not fragile detailed text tokens."""
    return metric.position_group in {"F", "M"}


@functools.lru_cache(maxsize=64)
def _fetch_elite_dribbler_metrics(
    league_id: int, season_name: str, restrict_to_forwards: bool = True,
    minimum_final_third_ratio: int = 0,
) -> tuple[dict[str, DecisionMetrics], dict[str, float]]:
    """Build the competition-season cohort from every 900+ minute, xG>=1 player.

    FotMob's minutes leaderboard currently returns an empty list, while its
    won-contest endpoint returns the complete player directory.  The latter is
    therefore used only to discover player IDs: contest values do not filter
    the cohort. Exact player metrics then enforce minutes, xG, and F/M.
    """
    rows = fetch_league_stat_table(league_id, season_name, "won_contest")
    
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
    if restrict_to_forwards:
        metrics_by_player = {
            player_id: metric for player_id, metric in metrics_by_player.items()
            if _is_forward_or_midfielder(metric)
            and (metric.minutes_played or 0.0) >= MINIMUM_SPEAR_MINUTES
            and (metric.xg or 0.0) >= MINIMUM_SPEAR_XG
        }
    else:
        metrics_by_player = {
            player_id: metric for player_id, metric in metrics_by_player.items()
            if (metric.minutes_played or 0.0) >= MINIMUM_SPEAR_MINUTES
            and (metric.xg or 0.0) >= MINIMUM_SPEAR_XG
        }
    metrics_by_player = {
        player_id: metric for player_id, metric in metrics_by_player.items()
        if passes_final_third_filter(player_id, minimum_final_third_ratio)
    }
    successes = {player_id: value for player_id, value in successes.items() if player_id in metrics_by_player}
    return metrics_by_player, successes


def _calculate_progression_percentiles(
    player_id: str, league_id: int, season_name: str, player: DecisionMetrics,
    restrict_to_forwards: bool = True, minimum_final_third_ratio: int = 0,
) -> dict[str, Optional[float] | Optional[int] | int]:
    try:
        peers, successes = _fetch_elite_dribbler_metrics(league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)
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

    The cohort is the same F/M, 900-minute competition-season group used by
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
    names = {str(row.get("id")): row.get("name", "Unknown") for row in leaderboard_rows}
    rows = []
    for player_id, metric in peers.items():
        net_progression = metric.net_progression_per90
        finishing = metric.in_box_finishing
        if net_progression is None or finishing is None:
            continue
        rows.append({
            "player_id": player_id,
            "player_name": names.get(player_id, "Unknown"),
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
    progression_percentiles = _calculate_progression_percentiles(
        player_key, metrics.league_id, season_name, metrics, restrict_to_forwards, minimum_final_third_ratio
    )
    peers, _ = _fetch_elite_dribbler_metrics(metrics.league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)
    # Keep the S.P.E.A.R. shooting factor on the exact same F/M + 900-minute
    # competition cohort as the other five radar axes.
    spear_shot_quality_population = [
        peer.xgot - peer.xg for peer in peers.values()
        if peer.xgot is not None and peer.xg is not None
    ]
    spear_shot_quality = metrics.xgot - metrics.xg if metrics.xgot is not None and metrics.xg is not None else None
    if spear_shot_quality_population:
        sq_pct, sq_rk = _rank_info(spear_shot_quality, spear_shot_quality_population)
        shot_quality_population = spear_shot_quality_population
        shot_quality_median = float(pd.Series(spear_shot_quality_population).median())
    in_box_population = [peer.in_box_finishing for peer in peers.values() if peer.in_box_finishing is not None]
    out_box_population = [peer.out_box_shot_quality for peer in peers.values() if peer.out_box_shot_quality is not None]
    in_box_pct, in_box_rank = _rank_info(metrics.in_box_finishing, in_box_population)
    out_box_pct, out_box_rank = _rank_info(metrics.out_box_shot_quality, out_box_population)
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
