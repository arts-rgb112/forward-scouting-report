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
    fetch_player_competition_stats,
    fetch_player_multi_season_data,
)
from metrics import DecisionMetrics, extract_multi_season_metrics


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


@functools.lru_cache(maxsize=32)
def _fetch_elite_dribbler_metrics(league_id: int, season_name: str) -> tuple[dict[str, DecisionMetrics], dict[str, float]]:
    """Build the >=1 successful-dribbles-per-90 cohort for one league-season.
    """
    rows = fetch_league_stat_table(league_id, season_name, "won_contest")
    
    # 💡 여기서 2.0을 1.0으로 수정합니다.
    successes = {
        str(row.get("id")): value
        for row in rows
        if (value := _value(row)) is not None and value >= 1.0
    }

    def fetch_one(player_id: str) -> tuple[str, Optional[DecisionMetrics]]:
        try:
            record = fetch_player_competition_stats(player_id, league_id, season_name)
            parsed = extract_multi_season_metrics({"season_records": [record]})
            return player_id, next(iter(parsed.values()), None)
        except (FotMobError, StopIteration, ValueError):
            return player_id, None

    metrics_by_player: dict[str, DecisionMetrics] = {}
    # A small pool keeps the first uncached request tolerable without sending a
    # burst of requests to FotMob. Results remain cached for an hour in the UI.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        for player_id, metric in executor.map(fetch_one, successes):
            if metric is not None:
                metrics_by_player[player_id] = metric
    return metrics_by_player, successes


def _calculate_dribble_percentiles(
    player_id: str, league_id: int, season_name: str, player: DecisionMetrics
) -> dict[str, Optional[float] | Optional[int] | int]:
    try:
        peers, successes = _fetch_elite_dribbler_metrics(league_id, season_name)
    except FotMobError:
        return {"elite_count": 0, "success_pct": None, "success_rank": None,
                "failure_pct": None, "failure_rank": None, "failure_count": 0,
                "net_pct": None, "net_rank": None, "net_count": 0}

    player_key = str(player_id)
    if player_key not in successes:
        return {
            "elite_count": len(successes), "success_pct": None, "success_rank": None,
            "failure_pct": None, "failure_rank": None, "failure_count": 0,
            "net_pct": None, "net_rank": None, "net_count": 0,
        }
    player_success = player.dribbles_succeeded_per90
    # The table is the canonical value for eligibility and success ranking.
    if player_key in successes:
        player_success = successes[player_key]

    success_population = list(successes.values())
    success_pct, success_rank = _rank_info(player_success, success_population)

    # Lower failed-dribble values are better; rank the negated values.
    failures = [metric.dribbles_failed_per90 for metric in peers.values()]
    failures = [value for value in failures if value is not None]
    player_failure = player.dribbles_failed_per90
    failure_pct, failure_rank = _rank_info(
        -player_failure if player_failure is not None else None, [-value for value in failures]
    )

    net_values = [metric.net_progression_per90 for metric in peers.values()]
    net_values = [value for value in net_values if value is not None]
    net_pct, net_rank = _rank_info(player.net_progression_per90, net_values)
    return {
        "elite_count": len(success_population),
        "success_pct": success_pct,
        "success_rank": success_rank,
        "failure_pct": failure_pct,
        "failure_rank": failure_rank,
        "failure_count": len(failures),
        "net_pct": net_pct,
        "net_rank": net_rank,
        "net_count": len(net_values),
    }


@functools.lru_cache(maxsize=32)
def get_tactical_matrix(league_id: int, season_name: str) -> pd.DataFrame:
    """Return the elite-dribbler cohort used in the tactical quadrant chart.

    Both axes are available only after the player-level fetch: Net Progression
    is composed from five event stats, while finishing is xGOT minus xG.
    """
    peers, successes = _fetch_elite_dribbler_metrics(league_id, season_name)
    leaderboard_rows = fetch_league_stat_table(league_id, season_name, "won_contest")
    names = {str(row.get("id")): row.get("name", "Unknown") for row in leaderboard_rows}
    rows = []
    for player_id, metric in peers.items():
        net_progression = metric.net_progression_per90
        finishing = metric.shot_quality
        if net_progression is None or finishing is None:
            continue
        rows.append({
            "player_id": player_id,
            "player_name": names.get(player_id, "Unknown"),
            "team_name": metric.team_name or "정보 없음",
            "net_progression_per90": net_progression,
            "xgot_minus_xg": finishing,
            "dribbles_succeeded_per90": successes[player_id],
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


def calculate_league_percentiles(player_id: str, season: str, metrics: DecisionMetrics, minimum_xg: float = 5.0) -> LeaguePercentiles:
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

    valid_pids = {pid for pid, xg in xg_by_player.items() if xg >= minimum_xg}
    
    goal_population = [goals_by_player.get(pid, 0.0) for pid in valid_pids]
    xg_population = [xg_by_player[pid] for pid in valid_pids]
    shot_quality_population = [xgot_by_player.get(key, 0.0) - xg for key, xg in xg_by_player.items() if key in valid_pids and key in xgot_by_player]
    overall_finishing_population = [goals_by_player.get(key, 0.0) - xg for key, xg in xg_by_player.items() if key in valid_pids]
    gk_impact_population = [goals_by_player.get(key, 0.0) - xgot_by_player.get(key, 0.0) for key, xg in xg_by_player.items() if key in valid_pids and key in xgot_by_player]
        
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

    # 💡 3. 경합 및 공중볼 승리율 - 임시 비활성화 (API 미지원)
    duels_pct, duels_rk, duels_eligible = None, None, 0
    aerials_pct, aerials_rk, aerials_eligible = None, None, 0
    dribble_percentiles = _calculate_dribble_percentiles(
        player_key, metrics.league_id, season_name, metrics
    )
    
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
        duels_pct_top_percent=duels_pct,
        duels_pct_rank=duels_rk,
        duels_eligible=duels_eligible,
        dribbles_pct_top_percent=dribbles_pct,
        dribbles_pct_rank=dribbles_rk,
        dribbles_eligible=dribbles_eligible,
        aerials_pct_top_percent=aerials_pct,
        aerials_pct_rank=aerials_rk,
        aerials_eligible=aerials_eligible,
        elite_dribbler_eligible=int(dribble_percentiles["elite_count"]),
        dribbles_succeeded_per90_top_percent=dribble_percentiles["success_pct"],
        dribbles_succeeded_per90_rank=dribble_percentiles["success_rank"],
        dribbles_failed_per90_top_percent=dribble_percentiles["failure_pct"],
        dribbles_failed_per90_rank=dribble_percentiles["failure_rank"],
        dribbles_failed_eligible=int(dribble_percentiles["failure_count"]),
        net_progression_top_percent=dribble_percentiles["net_pct"],
        net_progression_rank=dribble_percentiles["net_rank"],
        net_progression_eligible=int(dribble_percentiles["net_count"]),
    )


@functools.lru_cache(maxsize=1)
def get_top_leagues_shot_quality(season: str = "25/26") -> dict[str, pd.DataFrame]:
    leagues = {"Premier League": 47, "LaLiga": 87, "Bundesliga": 54, "Serie A": 55, "Champions League": 42}
    all_results = []
    league_results = {league: [] for league in leagues}
    season_name = f"20{season[:2]}/20{season[3:]}"
    
    for league_name, l_id in leagues.items():
        try:
            current_min_xg = 1.5 if l_id == 42 else 5.0
            xg_rows = fetch_league_stat_table(l_id, season_name, "expected_goals")
            goals_rows = fetch_league_stat_table(l_id, season_name, "goals")
            
            xg_by_player = {str(row.get("id")): _value(row) for row in xg_rows if _value(row) is not None}
            goals_by_player = {str(row.get("id")): _value(row) for row in goals_rows if _value(row) is not None}
            id_to_name = {str(row.get("id")): row.get("name", "Unknown") for row in xg_rows}
            
            xgot_by_player = {}
            try:
                # 수정됨: 올바른 API 키 적용
                xgot_rows = fetch_league_stat_table(l_id, season_name, "expected_goalsontarget")
                xgot_by_player = {str(row.get("id")): _value(row) for row in xgot_rows if _value(row) is not None}
            except Exception:
                pass
            
            if not xgot_by_player:
                target_pids = tuple(pid for pid, xg in xg_by_player.items() if xg >= current_min_xg)
                fallback_xgot = _fetch_fallback_xgot(season, target_pids)
                xgot_by_player.update(fallback_xgot)
            
            for pid, xg in xg_by_player.items():
                if xg >= current_min_xg and pid in xgot_by_player:
                    xgot = xgot_by_player[pid]
                    sq = xgot - xg
                    row_data = {
                        "선수": id_to_name.get(pid, "Unknown"),
                        "리그": league_name,
                        "슈팅 퀄리티 (xGOT-xG)": round(sq, 2),
                        "Goals": int(goals_by_player.get(pid, 0.0)),
                        "xG": round(xg, 2),
                        "xGOT": round(xgot, 2)
                    }
                    if league_name != "Champions League":
                        all_results.append(row_data)
                    league_results[league_name].append(row_data)
        except Exception:
            continue
            
    final_dfs = {}
    df_all = pd.DataFrame(all_results)
    if not df_all.empty:
        df_all = df_all.sort_values("슈팅 퀄리티 (xGOT-xG)", ascending=False).head(20).reset_index(drop=True)
        df_all.index = df_all.index + 1
    final_dfs["통합"] = df_all
    
    for league_name, rows in league_results.items():
        df_league = pd.DataFrame(rows)
        if not df_league.empty:
            df_league = df_league.drop(columns=["리그"], errors='ignore')
            df_league = df_league.sort_values("슈팅 퀄리티 (xGOT-xG)", ascending=False).head(20).reset_index(drop=True)
            df_league.index = df_league.index + 1
        final_dfs[league_name] = df_league
        
    return final_dfs
