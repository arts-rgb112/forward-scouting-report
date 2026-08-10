"""Metrics calculation and parsing for striker analysis."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class DecisionMetrics:
    league_id: Optional[int] = None
    league_name: Optional[str] = None
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    position: Optional[str] = None
    position_group: Optional[str] = None
    goals: Optional[float] = None
    xg: Optional[float] = None
    xgot: Optional[float] = None
    minutes_played: Optional[float] = None
    dribbles_succeeded: Optional[float] = None
    dribbles_success_rate: Optional[float] = None
    dispossessed: Optional[float] = None
    fouls_won: Optional[float] = None
    penalties_awarded: Optional[float] = None
    duels_won: Optional[float] = None
    duels_won_percentage: Optional[float] = None
    aerial_duels_won: Optional[float] = None
    aerial_duels_won_percentage: Optional[float] = None
    in_box_goals: Optional[float] = None
    in_box_xg: Optional[float] = None
    in_box_xgot: Optional[float] = None
    in_box_shots: Optional[float] = None
    out_box_goals: Optional[float] = None
    out_box_xg: Optional[float] = None
    out_box_xgot: Optional[float] = None
    out_box_shots: Optional[float] = None

    @property
    def shot_quality(self) -> Optional[float]:
        if self.xgot is not None and self.xg is not None:
            return self.xgot - self.xg
        return None

    @property
    def overall_finishing(self) -> Optional[float]:
        if self.goals is not None and self.xg is not None:
            return self.goals - self.xg
        return None

    @property
    def luck_or_gk_impact(self) -> Optional[float]:
        if self.goals is not None and self.xgot is not None:
            return self.goals - self.xgot
        return None

    @property
    def shot_quality_per90(self) -> Optional[float]:
        return _per90(self.shot_quality, self.minutes_played)

    @property
    def in_box_finishing(self) -> Optional[float]:
        if self.in_box_xgot is not None and self.in_box_xg is not None:
            return self.in_box_xgot - self.in_box_xg
        return None

    @property
    def in_box_finishing_per90(self) -> Optional[float]:
        return _per90(self.in_box_finishing, self.minutes_played)

    @property
    def out_box_shot_quality(self) -> Optional[float]:
        if self.out_box_xgot is not None and self.out_box_xg is not None:
            return self.out_box_xgot - self.out_box_xg
        return None

    def is_complete(self) -> bool:
        return all(v is not None for v in (self.goals, self.xg, self.xgot))

    @property
    def dribbles_succeeded_per90(self) -> Optional[float]:
        return _per90(self.dribbles_succeeded, self.minutes_played)

    @property
    def xg_per90(self) -> Optional[float]:
        return _per90(self.xg, self.minutes_played)

    @property
    def total_shots(self) -> Optional[float]:
        if self.in_box_shots is None or self.out_box_shots is None:
            return None
        return self.in_box_shots + self.out_box_shots

    @property
    def dribble_attempts(self) -> Optional[float]:
        if self.dribbles_succeeded is None or self.dribbles_success_rate is None:
            return None
        rate = self.dribbles_success_rate / 100
        if not 0 < rate <= 1:
            return None
        return self.dribbles_succeeded / rate

    @property
    def ground_duel_attempts(self) -> Optional[float]:
        if self.duels_won is None or self.duels_won_percentage is None:
            return None
        rate = self.duels_won_percentage / 100
        if not 0 < rate <= 1:
            return None
        return self.duels_won / rate

    @property
    def aerial_duel_attempts(self) -> Optional[float]:
        if self.aerial_duels_won is None or self.aerial_duels_won_percentage is None:
            return None
        rate = self.aerial_duels_won_percentage / 100
        if not 0 < rate <= 1:
            return None
        return self.aerial_duels_won / rate

    @property
    def dribbles_failed_per90(self) -> Optional[float]:
        """Infer unsuccessful dribbles from successful dribbles and success rate."""
        if self.dribbles_succeeded_per90 is None or self.dribbles_success_rate is None:
            return None
        success_rate = self.dribbles_success_rate / 100
        if not 0 < success_rate <= 1:
            return None
        return self.dribbles_succeeded_per90 * (1 - success_rate) / success_rate

    @property
    def dispossessed_per90(self) -> Optional[float]:
        return _per90(self.dispossessed, self.minutes_played)

    @property
    def fouls_won_per90(self) -> Optional[float]:
        return _per90(self.fouls_won, self.minutes_played)

    @property
    def penalties_awarded_per90(self) -> Optional[float]:
        return _per90(self.penalties_awarded, self.minutes_played)

    @property
    def duels_won_per90(self) -> Optional[float]:
        return _per90(self.duels_won, self.minutes_played)

    @property
    def duels_lost_per90(self) -> Optional[float]:
        return _failed_attempts_per90(
            self.duels_won_per90, self.duels_won_percentage
        )

    @property
    def aerial_duels_won_per90(self) -> Optional[float]:
        return _per90(self.aerial_duels_won, self.minutes_played)

    @property
    def aerial_duels_lost_per90(self) -> Optional[float]:
        return _failed_attempts_per90(
            self.aerial_duels_won_per90, self.aerial_duels_won_percentage
        )

    @property
    def dribble_margin_per90(self) -> Optional[float]:
        return _margin(self.dribbles_succeeded_per90, self.dribbles_failed_per90)

    @property
    def duel_margin_per90(self) -> Optional[float]:
        return _margin(self.duels_won_per90, self.duels_lost_per90)

    @property
    def aerial_margin_per90(self) -> Optional[float]:
        return _margin(self.aerial_duels_won_per90, self.aerial_duels_lost_per90)

    @property
    def net_progression_per90(self) -> Optional[float]:
        values = (
            self.dribbles_succeeded_per90,
            self.fouls_won_per90,
            self.penalties_awarded_per90,
            self.duels_won_per90,
            self.aerial_duels_won_per90,
            self.duels_lost_per90,
            self.aerial_duels_lost_per90,
            self.dribbles_failed_per90,
            self.dispossessed_per90,
        )
        if any(value is None for value in values):
            return None
        (successful, fouls, penalties, duels_won, aerial_won,
         duels_lost, aerial_lost, dribble_failed, dispossessed) = values
        return (successful + fouls + penalties + duels_won + aerial_won
                - duels_lost - aerial_lost - dribble_failed - dispossessed)


def _per90(value: Optional[float], minutes: Optional[float]) -> Optional[float]:
    if value is None or minutes is None or minutes <= 0:
        return None
    return value * 90 / minutes


def _failed_attempts_per90(
    succeeded_per90: Optional[float], success_rate: Optional[float]
) -> Optional[float]:
    """Reverse-calculate failed attempts from wins and a percentage."""
    if succeeded_per90 is None or success_rate is None:
        return None
    rate = success_rate / 100
    if not 0 < rate <= 1:
        return None
    return succeeded_per90 * (1 - rate) / rate


def _margin(successes: Optional[float], failures: Optional[float]) -> Optional[float]:
    if successes is None or failures is None:
        return None
    return successes - failures


def _shotmap_zone_totals(shotmap: Any) -> dict[str, float]:
    """Aggregate FotMob shots using its explicit inside-box flag.

    Coordinates are retained only as a compatibility fallback for historical
    responses that predate ``isFromInsideBox``.
    """
    totals = {
        f"{zone}_{metric}": 0.0
        for zone in ("in_box", "out_box")
        for metric in ("goals", "xg", "xgot", "shots")
    }
    if not isinstance(shotmap, list):
        return totals
    for shot in shotmap:
        if not isinstance(shot, dict) or shot.get("isOwnGoal"):
            continue
        inside = shot.get("isFromInsideBox")
        if not isinstance(inside, bool):
            x, y = _parse_value(shot.get("x")), _parse_value(shot.get("y"))
            inside = bool(x is not None and y is not None and x >= 83.0 and 21.0 <= y <= 79.0)
        prefix = "in_box" if inside else "out_box"
        totals[f"{prefix}_shots"] += 1.0
        totals[f"{prefix}_xg"] += _parse_value(shot.get("expectedGoals")) or 0.0
        totals[f"{prefix}_xgot"] += _parse_value(shot.get("expectedGoalsOnTarget")) or 0.0
        if str(shot.get("eventType", "")).lower() == "goal" or shot.get("isGoal") is True:
            totals[f"{prefix}_goals"] += 1.0
    return totals


def _parse_value(val: Any) -> Optional[float]:
    if isinstance(val, dict):
        val = val.get("value", val.get("statValue", val.get("num")))
    try:
        if val is None:
            return None
        return float(val)
    except (ValueError, TypeError):
        return None


def _normalize_season(season: str) -> str:
    season_str = str(season).strip()
    if "_" in season_str:
        season_str = season_str.split("_")[0]
    if "/" in season_str:
        parts = season_str.split("/")
        if len(parts) == 2:
            p1 = parts[0][-2:] if len(parts[0]) >= 2 else parts[0]
            p2 = parts[1][-2:] if len(parts[1]) >= 2 else parts[1]
            return f"{p1}/{p2}"
    return season_str


# FotMob playerStats API가 각 통계 항목을 {"title": "...", "value": ...} 형태의
# 블록으로 트리 어딘가에 담아 보낸다는 전제로, 라벨 문자열을 기준으로 재귀 탐색한다.
# 필드 순서나 중첩 구조가 바뀌어도 title 라벨만 유지되면 계속 동작하도록 하기 위함.
_GOALS_TITLES = {"goals"}
_XG_TITLES = {"expected goals (xg)", "expected goals", "xg"}
_XGOT_TITLES = {"expected goals on target (xgot)", "expected goals on target", "xgot"}
_MINUTES_TITLES = {"minutes", "minutes played"}
_DRIBBLES_SUCCEEDED_TITLES = {"dribbles"}
_DRIBBLES_SUCCESS_RATE_TITLES = {"dribbles success rate"}
_DISPOSSESSED_TITLES = {"dispossessed"}
_FOULS_WON_TITLES = {"fouls won"}
_PENALTIES_AWARDED_TITLES = {"penalties awarded"}
_DUELS_WON_TITLES = {"duels won", "duel won", "ground duels won"}
_DUELS_WON_PERCENTAGE_TITLES = {
    "duels won percentage", "duel won percentage", "duels won %",
    "ground duels won percentage",
}
_AERIAL_DUELS_WON_TITLES = {
    "aerial duels won", "aerial duel won", "aerials won",
}
_AERIAL_DUELS_WON_PERCENTAGE_TITLES = {
    "aerial duels won percentage", "aerial duel won percentage",
    "aerial duels won %", "aerials won %", "aerials won percentage",
}


def _find_stat_by_title(node: Any, titles: set[str]) -> Optional[float]:
    """Recursively search node for a stat block whose title matches `titles`."""
    if isinstance(node, dict):
        title = node.get("title")
        if isinstance(title, str) and title.strip().lower() in titles:
            parsed = _parse_value(node.get("value", node.get("statValue", node.get("num"))))
            if parsed is not None:
                return parsed
        for value in node.values():
            found = _find_stat_by_title(value, titles)
            if found is not None:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _find_stat_by_title(item, titles)
            if found is not None:
                return found
    return None


def _find_by_key(node: Any, keys: set[str]) -> Any:
    """Recursively search node for the first value under one of `keys`."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k in keys and v not in (None, ""):
                return v
        for v in node.values():
            found = _find_by_key(v, keys)
            if found is not None:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _find_by_key(item, keys)
            if found is not None:
                return found
    return None


def find_stat_value(raw_data: Any, season: str, titles: set[str]) -> Optional[float]:
    """Search a fetch_player_multi_season_data() payload for a stat whose title
    matches `titles`, restricted to the season_record(s) matching `season`.

    Used as a fallback when a league leaderboard (fetch_league_stat_table) doesn't
    include a player's value for a given stat -- e.g. FotMob's percent-sorted
    leaderboards are independently truncated top-N lists that don't necessarily
    overlap with the count-sorted top-N list we use for eligibility filtering.
    Reuses the same title-based recursive search as goals/xG/xGOT so it stays
    resilient to nesting/order changes, as long as the "title" label survives.
    """
    records = raw_data.get("season_records", []) if isinstance(raw_data, dict) else []
    if not isinstance(records, list):
        return None

    if len(season) == 5 and "/" in season:
        s1, s2 = season.split("/")
        possible_seasons = {season, f"20{s1}/20{s2}", f"20{s1}/{s2}"}
    else:
        possible_seasons = {season}

    for record in records:
        if not isinstance(record, dict):
            continue
        rec_season_raw = str(record.get("season", ""))
        if rec_season_raw not in possible_seasons and _normalize_season(rec_season_raw) not in possible_seasons:
            continue
        value = _find_stat_by_title(record.get("stats"), titles)
        if value is not None:
            return value
    return None


# These are the competitions that feed reports and S.P.E.A.R. cohorts.  Keep
# all three UEFA competitions here: before Europa/Conference were added, their
# raw FotMob records were fetched correctly but silently discarded below.
TARGET_LEAGUES = [
    "premier league", "laliga", "bundesliga", "serie a", "ligue 1",
    "eredivisie", "primeira liga", "liga portugal",
    "champions league", "ucl", "europa league", "conference league",
]
_FORWARD_POSITION_KEYS = {"f", "forward", "striker", "attacker", "centre-forward", "center-forward", "winger"}
_MIDFIELDER_POSITION_KEYS = {"m", "midfielder", "central midfielder", "attacking midfielder", "wide midfielder"}


def _position_group(position_key: object, position_label: object) -> Optional[str]:
    """Normalize provider position metadata into the F/M/D/G major groups."""
    values = {
        str(value or "").strip().lower().replace("_", "-")
        for value in (position_key, position_label)
    }
    if values & _FORWARD_POSITION_KEYS:
        return "F"
    if values & _MIDFIELDER_POSITION_KEYS:
        return "M"
    return None


def extract_multi_season_metrics(raw_data: Any) -> Dict[str, DecisionMetrics]:
    """Read the {"base": ..., "season_records": [...]} shape produced by
    fotmob_client.fetch_player_multi_season_data() and turn it into per-league
    DecisionMetrics.
    """
    seasons_data: Dict[str, DecisionMetrics] = {}

    records = raw_data.get("season_records", []) if isinstance(raw_data, dict) else []
    if not isinstance(records, list):
        return seasons_data

    base = raw_data.get("base", {}) if isinstance(raw_data, dict) else {}
    primary_position = _find_by_key(base, {"primaryPosition"})
    primary_position_key = None
    if isinstance(primary_position, dict):
        primary_position_key = primary_position.get("key")
        primary_position = primary_position.get("label") or primary_position_key
    primary_position_group = _position_group(primary_position_key, primary_position)

    for record in records:
        if not isinstance(record, dict):
            continue

        season_raw = record.get("season", "Unknown")
        season = _normalize_season(season_raw)
        if season == "Unknown":
            continue

        l_id = record.get("league_id")
        l_name = record.get("league_name")
        if not l_name:
            continue

        lname_lower = str(l_name).lower()

        # 컵 대회 등 원치 않는 대회 차단
        if not any(t in lname_lower for t in TARGET_LEAGUES):
            continue
        if "cup" in lname_lower and not any(
            continental in lname_lower
            for continental in ("champions", "europa", "conference")
        ):
            continue
        if "copa" in lname_lower or "super" in lname_lower or "friendlies" in lname_lower:
            continue

        # API 임의 ID를 정규 ID로 강제 변환 (비교 집단 조회용)
        league_id = int(l_id) if l_id else 0
        if "laliga" in lname_lower: league_id = 87
        elif "premier" in lname_lower: league_id = 47
        elif "bundesliga" in lname_lower: league_id = 54
        elif "serie a" in lname_lower: league_id = 55
        elif "eredivisie" in lname_lower: league_id = 57
        elif "primeira liga" in lname_lower or "liga portugal" in lname_lower: league_id = 61
        elif "champions" in lname_lower: league_id = 42
        elif "europa league" in lname_lower and "conference" not in lname_lower: league_id = 73
        elif "conference league" in lname_lower: league_id = 108

        stats_payload = record.get("stats")
        zone_totals = _shotmap_zone_totals(stats_payload.get("shotmap") if isinstance(stats_payload, dict) else None)

        goals = _find_stat_by_title(stats_payload, _GOALS_TITLES)
        xg = _find_stat_by_title(stats_payload, _XG_TITLES)
        xgot = _find_stat_by_title(stats_payload, _XGOT_TITLES)
        minutes_played = _find_stat_by_title(stats_payload, _MINUTES_TITLES)
        dribbles_succeeded = _find_stat_by_title(stats_payload, _DRIBBLES_SUCCEEDED_TITLES)
        dribbles_success_rate = _find_stat_by_title(stats_payload, _DRIBBLES_SUCCESS_RATE_TITLES)
        dispossessed = _find_stat_by_title(stats_payload, _DISPOSSESSED_TITLES)
        fouls_won = _find_stat_by_title(stats_payload, _FOULS_WON_TITLES)
        duels_won = _find_stat_by_title(stats_payload, _DUELS_WON_TITLES)
        duels_won_percentage = _find_stat_by_title(
            stats_payload, _DUELS_WON_PERCENTAGE_TITLES
        )
        aerial_duels_won = _find_stat_by_title(stats_payload, _AERIAL_DUELS_WON_TITLES)
        aerial_duels_won_percentage = _find_stat_by_title(
            stats_payload, _AERIAL_DUELS_WON_PERCENTAGE_TITLES
        )
        # FotMob omits this row when a player has won no penalties; this is a
        # real zero, not missing data, for the net-progression formula.
        penalties_awarded = _find_stat_by_title(stats_payload, _PENALTIES_AWARDED_TITLES)
        if penalties_awarded is None:
            penalties_awarded = 0.0

        if goals is None and xg is None and xgot is None:
            continue

        team_id = record.get("team_id") or _find_by_key(stats_payload, {"teamId"})
        team_name = record.get("team_name") or _find_by_key(stats_payload, {"teamName", "team"})

        unique_key = f"{season}_{league_id}"
        new_metric = DecisionMetrics(
            league_id=league_id,
            league_name=str(l_name),
            team_id=int(team_id) if isinstance(team_id, (int, float, str)) and str(team_id).isdigit() else None,
            team_name=str(team_name) if team_name else None,
            position=str(primary_position) if primary_position else None,
            position_group=primary_position_group,
            goals=goals,
            xg=xg,
            xgot=xgot,
            minutes_played=minutes_played,
            dribbles_succeeded=dribbles_succeeded,
            dribbles_success_rate=dribbles_success_rate,
            dispossessed=dispossessed,
            fouls_won=fouls_won,
            penalties_awarded=penalties_awarded,
            duels_won=duels_won,
            duels_won_percentage=duels_won_percentage,
            aerial_duels_won=aerial_duels_won,
            aerial_duels_won_percentage=aerial_duels_won_percentage,
            **zone_totals,
        )

        if unique_key in seasons_data:
            ext = seasons_data[unique_key]
            if ext.goals is None and new_metric.goals is not None: ext.goals = new_metric.goals
            if ext.xg is None and new_metric.xg is not None: ext.xg = new_metric.xg
            if ext.xgot is None and new_metric.xgot is not None: ext.xgot = new_metric.xgot
            if ext.minutes_played is None and new_metric.minutes_played is not None: ext.minutes_played = new_metric.minutes_played
            if ext.dribbles_succeeded is None and new_metric.dribbles_succeeded is not None: ext.dribbles_succeeded = new_metric.dribbles_succeeded
            if ext.dribbles_success_rate is None and new_metric.dribbles_success_rate is not None: ext.dribbles_success_rate = new_metric.dribbles_success_rate
            if ext.dispossessed is None and new_metric.dispossessed is not None: ext.dispossessed = new_metric.dispossessed
            if ext.fouls_won is None and new_metric.fouls_won is not None: ext.fouls_won = new_metric.fouls_won
            if ext.penalties_awarded is None and new_metric.penalties_awarded is not None: ext.penalties_awarded = new_metric.penalties_awarded
            if ext.duels_won is None and new_metric.duels_won is not None: ext.duels_won = new_metric.duels_won
            if ext.duels_won_percentage is None and new_metric.duels_won_percentage is not None: ext.duels_won_percentage = new_metric.duels_won_percentage
            if ext.aerial_duels_won is None and new_metric.aerial_duels_won is not None: ext.aerial_duels_won = new_metric.aerial_duels_won
            if ext.aerial_duels_won_percentage is None and new_metric.aerial_duels_won_percentage is not None: ext.aerial_duels_won_percentage = new_metric.aerial_duels_won_percentage
            if ext.position is None and new_metric.position is not None: ext.position = new_metric.position
            for attr in (
                "in_box_goals", "in_box_xg", "in_box_xgot", "in_box_shots",
                "out_box_goals", "out_box_xg", "out_box_xgot", "out_box_shots",
            ):
                if getattr(ext, attr) is None and getattr(new_metric, attr) is not None:
                    setattr(ext, attr, getattr(new_metric, attr))
        else:
            seasons_data[unique_key] = new_metric

    return seasons_data
