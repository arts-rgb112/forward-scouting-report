from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from pydantic import ValidationError

from rankings import (
    COMPARISON_SCOPES, EUROPEAN_LEADERBOARD_ID, calculate_league_percentiles,
    get_spear_leaderboard, get_tactical_matrix,
)
from spear_cohort import load_spear_cohort
from tactical_ratio import get_heatmap_points, get_tactical_ratio_for_session
from shotmap_store_v2 import ShotmapSnapshotError, get_shotmap_snapshot

from .schemas import (
    AgeBand, AssetRef, CompareMeta, ContinuousCoreAnalysis, DatasetMeta, DuelSpatialAnalysis, HeatmapPoint, ShotmapPoint, LeaderboardAppliedFilters, LeaderboardEnvelope,
    DuelPressAppliedFilters, DuelPressComponents, DuelPressLeaderboardEnvelope,
    DuelPressLeaderboardSort, DuelPressPlayerEnvelope, DuelPressPlayerResponse,
    DuelPressPlayerStats, DuelPressRawMetrics,
    LeaderboardPageEnvelope, MessiDataQuality, MessiScoreAnalysis, PlayerAnalysis,
    LeaderboardSort, MinutesBand, SortOrder,
    PlayerComparisonEnvelope, PlayerDataQuality, PlayerDetailResponse, PlayerResponse,
    PlayersEnvelope, PlayerStats, PlayerTier, RadarAxis, RadarChart,
    PositionalGridCell, RawMetrics, SpatialAnalysis,
    TacticalQuadrantAnalysis, TacticalQuadrantPoint,
    TrueCoreAnalysis, TrueCoreZone,
    WatchlistDataQualityResult, WatchlistResolveResult, WatchlistResolvedContext,
    WatchlistResolvedPlayer,
)
from .profiles import league_logo_url, player_age, player_face_url, team_logo_url


TIER_BANDS = (
    ("diamond", "Diamond", 0.0, 4.0),
    ("emerald", "Emerald", 4.0, 11.0),
    ("platinum", "Platinum", 11.0, 40.0),
    ("gold", "Gold", 40.0, 77.0),
    ("silver", "Silver", 77.0, 96.0),
    ("bronze", "Bronze", 96.0, 100.0),
)


class ShotmapContractViolation(RuntimeError):
    """Stored shotmap data cannot be represented by the public API contract."""


def tier_from_rank(rank: int, population: int) -> PlayerTier:
    """Map the unchanged M.E.S.S.I. percentile bands to Crystal v2 tiers."""
    percentile = min(100.0, max(0.0, ((rank - 1) / max(population, 1)) * 100.0))
    for index, (code, label, start, end) in enumerate(TIER_BANDS):
        if percentile <= end or index == len(TIER_BANDS) - 1:
            width = (end - start) / 5.0
            level = min(5, max(1, int((percentile - start) / width) + 1))
            return PlayerTier(code=code, level=level, label=label)
    raise AssertionError("tier bands must cover 0–100")


def _asset_id(value: object) -> int:
    try:
        parsed = float(str(value))
    except (TypeError, ValueError):
        return 0
    return int(parsed) if parsed == parsed else 0


def _source_player_id(value: object) -> int:
    """Reject malformed source IDs instead of exposing a frontend-invalid zero ID."""
    parsed = float(str(value))
    if parsed != parsed or not parsed.is_integer() or parsed <= 0:
        raise ValueError("player_id must be a positive integer")
    return int(parsed)


def _players_from_frame(frame, *, require_complete_profiles: bool = True) -> tuple[PlayerResponse, ...]:
    population = len(frame)
    players: list[PlayerResponse] = []
    for record in frame.to_dict(orient="records"):
        try:
            player_id = _source_player_id(record["player_id"])
        except (TypeError, ValueError):
            # A source row without a usable ID cannot be selected, compared,
            # or keyed safely by the strict frontend contract.
            continue
        league_id = _asset_id(record.get("league_id") or 0)
        team_id = _asset_id(record.get("team_id") or 0)
        age = player_age(player_id)
        if not league_id or not team_id or (require_complete_profiles and age is None):
            # Public rows promise usable image assets and a concrete age. The
            # profile snapshot is built from the same static cohort, so this
            # only excludes a source row while a provider profile is pending.
            continue
        rank = int(record["rank"])
        players.append(PlayerResponse(
            id=player_id,
            rank=rank,
            name=str(record["player_name"]),
            position=str(record.get("position") or "FW"),
            archetype=str(record.get("role") or "Type A"),
            age=age,
            minutes=max(0, round(float(record.get("minutes_played") or 0))),
            tier=tier_from_rank(rank, population),
            score=round(float(record["score"]), 2),
            face=player_face_url(player_id),
            nation=None,
            league=AssetRef(id=league_id, name=str(record.get("league_name") or "Unknown league"), icon=league_logo_url(league_id)),
            club=AssetRef(id=team_id, name=str(record.get("team_name") or "Unknown club"), icon=team_logo_url(team_id)),
            stats=PlayerStats(
                outsideShot=round(float(record["outside_shot_score"]), 2),
                boxThreat=round(float(record["deep_box_score"]), 2),
                dangerZone=round(float(record["danger_zone_score"]), 2),
                aerial=round(float(record["aerial_score"]), 2),
                groundDuel=round(float(record["ground_duel_score"]), 2),
                spaceControl=round(float(record["space_control_score"]), 2),
            ),
        ))
    return tuple(players)


def _optional_number(value: object) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def _optional_source(value: object) -> str | None:
    text = str(value or "").strip()
    return text if text in {"player_season_total", "league_per90_fallback"} else None


def _duel_press_players_from_frame(frame) -> tuple[DuelPressPlayerResponse, ...]:
    """Build the opt-in taxonomy without changing the deployed v2 DTO."""
    population = len(frame)
    players: list[DuelPressPlayerResponse] = []
    for record in frame.to_dict(orient="records"):
        try:
            player_id = _source_player_id(record["player_id"])
        except (TypeError, ValueError):
            continue
        league_id = _asset_id(record.get("league_id") or 0)
        team_id = _asset_id(record.get("team_id") or 0)
        if not league_id or not team_id:
            continue
        rank = int(record["pressing_rank"])
        players.append(DuelPressPlayerResponse(
            id=player_id,
            rank=rank,
            name=str(record["player_name"]),
            position=str(record.get("position") or "FW"),
            archetype=str(record.get("role") or "Type A"),
            age=player_age(player_id),
            minutes=max(0, round(float(record.get("minutes_played") or 0))),
            tier=tier_from_rank(rank, population),
            score=round(float(record["pressing_score"]), 2),
            face=player_face_url(player_id),
            nation=None,
            league=AssetRef(
                id=league_id, name=str(record.get("league_name") or "Unknown league"),
                icon=league_logo_url(league_id),
            ),
            club=AssetRef(
                id=team_id, name=str(record.get("team_name") or "Unknown club"),
                icon=team_logo_url(team_id),
            ),
            stats=DuelPressPlayerStats(
                outsideShot=round(float(record["outside_shot_score"]), 2),
                boxThreat=round(float(record["deep_box_score"]), 2),
                dangerZone=round(float(record["danger_zone_score"]), 2),
                combinedDuel=round(float(record["combined_duel_score"]), 2),
                spaceControl=round(float(record["space_control_score"]), 2),
                forwardPress=round(float(record["forward_press_score"]), 2),
            ),
            components=DuelPressComponents(
                combinedDuelVolume=round(float(record["combined_duel_volume_score"]), 2),
                combinedDuelEfficiency=round(float(record["combined_duel_efficiency_score"]), 2),
                recoveries=round(float(record["recoveries_score"]), 2),
                finalThirdPossessionsWon=round(float(record["final_third_press_score"]), 2),
            ),
            pressingRawMetrics=DuelPressRawMetrics(
                recoveries=_optional_number(record.get("recoveries")),
                recoveriesPer90=_optional_number(record.get("recoveries_per90")),
                recoveriesSource=_optional_source(record.get("recoveries_source")),
                finalThirdPossessionsWon=_optional_number(
                    record.get("final_third_possessions_won")
                ),
                finalThirdPossessionsWonPer90=_optional_number(
                    record.get("final_third_possessions_won_per90")
                ),
                finalThirdPossessionsWonSource=_optional_source(
                    record.get("final_third_possessions_won_source")
                ),
            ),
        ))
    return tuple(players)


@lru_cache(maxsize=16)
def build_players(season: str, scope: int) -> tuple[PlayerResponse, ...]:
    """Legacy v1 domestic data. Kept strict for already deployed clients."""
    return _players_from_frame(get_spear_leaderboard(47, season, scope))


def leaderboard_target(mode: str, scope: int, competition: str) -> int:
    if mode == "league":
        return 47
    return {
        "all": EUROPEAN_LEADERBOARD_ID,
        "ucl": 42,
        "uel": 73,
        "uecl": 108,
    }[competition]


@lru_cache(maxsize=64)
def build_v2_players(season: str, mode: str, scope: int, competition: str) -> tuple[PlayerResponse, ...]:
    """Return only rows backed by the static snapshot; no synthetic competition data."""
    target = leaderboard_target(mode, scope, competition)
    # v2 explicitly represents a missing verified birth date as ``age: null``.
    # Legacy v1 remains strict and continues to omit incomplete profiles.
    return _players_from_frame(
        get_spear_leaderboard(target, season, scope), require_complete_profiles=False,
    )


@lru_cache(maxsize=64)
def build_duel_press_players(
    season: str, mode: str, scope: int, competition: str,
) -> tuple[DuelPressPlayerResponse, ...]:
    target = leaderboard_target(mode, scope, competition)
    return _duel_press_players_from_frame(get_spear_leaderboard(target, season, scope))


def available_competitions(season: str) -> dict[str, dict[str, object]]:
    labels = {"all": "All European competitions", "ucl": "Champions League", "uel": "Europa League", "uecl": "Europa Conference League"}
    result: dict[str, dict[str, object]] = {}
    for code in labels:
        rows = build_v2_players(season, "europe", 7, code)
        result[code] = {
            "code": code,
            "label": labels[code],
            "available": bool(rows),
            "reason": None if rows else "No verified static cohort is available for this competition and season.",
        }
    return result


def leaderboard_v2_envelope(season: str, mode: str, scope: int, competition: str, limit: int) -> dict[str, object]:
    rows = build_v2_players(season, mode, scope, competition)
    selected = list(rows[:limit])
    return {
        "data": [player.model_dump(mode="json") for player in selected],
        "meta": {
            "schemaVersion": "2.0.0", "season": season, "mode": mode, "scope": scope if mode == "league" else None,
            "competition": competition if mode == "europe" else None, "population": len(rows), "returned": len(selected),
            "generatedAt": dataset_generated_at().isoformat().replace("+00:00", "Z"), "source": "messi-static-cohort",
        },
    }


SORTABLE_FIELDS = {
    "rank": lambda player: player.rank,
    "score": lambda player: player.score,
    "name": lambda player: player.name.casefold(),
    "minutes": lambda player: player.minutes,
    "age": lambda player: player.age,
    "outsideShot": lambda player: player.stats.outsideShot,
    "boxThreat": lambda player: player.stats.boxThreat,
    "dangerZone": lambda player: player.stats.dangerZone,
    "aerial": lambda player: player.stats.aerial,
    "groundDuel": lambda player: player.stats.groundDuel,
    "spaceControl": lambda player: player.stats.spaceControl,
}
DUEL_PRESS_SORTABLE_FIELDS = {
    "rank": lambda player: player.rank,
    "score": lambda player: player.score,
    "name": lambda player: player.name.casefold(),
    "minutes": lambda player: player.minutes,
    "age": lambda player: player.age,
    "outsideShot": lambda player: player.stats.outsideShot,
    "boxThreat": lambda player: player.stats.boxThreat,
    "dangerZone": lambda player: player.stats.dangerZone,
    "combinedDuel": lambda player: player.stats.combinedDuel,
    "spaceControl": lambda player: player.stats.spaceControl,
    "forwardPress": lambda player: player.stats.forwardPress,
}


AGE_BAND_BOUNDS: dict[AgeBand, tuple[int | None, int | None] | None] = {
    "all": None,
    "u23": (None, 22),
    "u25": (23, 25),
    "26-30": (26, 30),
    "31-plus": (31, None),
}
MINUTES_BAND_BOUNDS: dict[MinutesBand, tuple[int | None, int | None] | None] = {
    "all": None,
    "200-499": (200, 499),
    "500-999": (500, 999),
    "1000-1499": (1000, 1499),
    "1500-1999": (1500, 1999),
    "2000-2999": (2000, 2999),
    "3000-plus": (3000, None),
}


def _in_band(value: int | None, bounds: tuple[int | None, int | None] | None) -> bool:
    if bounds is None:
        return True
    if value is None:
        return False
    lower, upper = bounds
    return (lower is None or value >= lower) and (upper is None or value <= upper)


def matches_age_band(age: int | None, band: AgeBand) -> bool:
    return _in_band(age, AGE_BAND_BOUNDS[band])


def matches_minutes_band(minutes: int, band: MinutesBand) -> bool:
    return _in_band(minutes, MINUTES_BAND_BOUNDS[band])


def canonical_leaderboard_filters(
    *, role: str | None, position: str | None, age_band: AgeBand,
    minutes_band: MinutesBand, query: str | None, sort: LeaderboardSort,
    order: SortOrder,
) -> LeaderboardAppliedFilters:
    return LeaderboardAppliedFilters(
        role=role,
        position=(position.strip() or None) if position is not None else None,
        q=(query.strip() or None) if query is not None else None,
        ageBand=age_band,
        minutesBand=minutes_band,
        sort=sort,
        order=order,
    )


def _apply_leaderboard_filters(
    rows: tuple[PlayerResponse, ...], applied: LeaderboardAppliedFilters,
) -> tuple[PlayerResponse, ...]:
    if applied.role:
        rows = tuple(player for player in rows if player.archetype == applied.role)
    if applied.position:
        rows = tuple(player for player in rows if player.position == applied.position)
    rows = tuple(player for player in rows if matches_age_band(player.age, applied.ageBand))
    rows = tuple(player for player in rows if matches_minutes_band(player.minutes, applied.minutesBand))
    if applied.q:
        needle = applied.q.casefold()
        rows = tuple(
            player for player in rows
            if needle in player.name.casefold()
            or needle in player.club.name.casefold()
            or needle in player.league.name.casefold()
        )

    # Establish the invariant tie order first. Python's stable sort preserves
    # rank ASC, id ASC for equal primary values even when the primary is DESC.
    rows = tuple(sorted(rows, key=lambda player: (player.rank, player.id)))
    key = SORTABLE_FIELDS[applied.sort]
    reverse = applied.order == "desc"
    if applied.sort == "age":
        known = tuple(player for player in rows if player.age is not None)
        missing = tuple(player for player in rows if player.age is None)
        return tuple(sorted(known, key=key, reverse=reverse)) + missing
    return tuple(sorted(rows, key=key, reverse=reverse))


def filtered_v2_players(
    season: str, mode: str, scope: int, competition: str, *, role: str | None,
    position: str | None, age_band: AgeBand = "all",
    minutes_band: MinutesBand = "all", query: str | None,
    sort: LeaderboardSort, order: SortOrder,
) -> tuple[PlayerResponse, ...]:
    """Apply only server-owned filter/sort rules to the verified cohort."""
    applied = canonical_leaderboard_filters(
        role=role, position=position, age_band=age_band,
        minutes_band=minutes_band, query=query, sort=sort, order=order,
    )
    return _apply_leaderboard_filters(
        build_v2_players(season, mode, scope, competition), applied,
    )


def leaderboard_v21_envelope(
    season: str, mode: str, scope: int, competition: str, *, page: int,
    page_size: int, role: str | None, position: str | None,
    age_band: AgeBand = "all", minutes_band: MinutesBand = "all",
    query: str | None, sort: LeaderboardSort, order: SortOrder,
) -> LeaderboardPageEnvelope:
    applied = canonical_leaderboard_filters(
        role=role, position=position, age_band=age_band,
        minutes_band=minutes_band, query=query, sort=sort, order=order,
    )
    rows = _apply_leaderboard_filters(
        build_v2_players(season, mode, scope, competition), applied,
    )
    population = len(rows)
    total_pages = (population + page_size - 1) // page_size
    start = (page - 1) * page_size
    selected = list(rows[start:start + page_size]) if page <= max(total_pages, 1) else []
    return LeaderboardPageEnvelope.model_validate({
        "data": selected,
        "meta": {
            "schemaVersion": "2.1.0", "season": season, "mode": mode,
            "scope": scope if mode == "league" else None,
            "competition": competition if mode == "europe" else None,
            "population": population, "returned": len(selected),
            "page": page, "pageSize": page_size, "totalItems": population,
            "totalPages": total_pages,
            "hasNextPage": page < total_pages,
            "applied": applied,
            "generatedAt": dataset_generated_at(), "source": "messi-static-cohort",
        },
    })


def duel_press_leaderboard_envelope(
    season: str, mode: str, scope: int, competition: str, *, page: int,
    page_size: int, role: str | None, position: str | None,
    age_band: AgeBand = "all", minutes_band: MinutesBand = "all",
    query: str | None, sort: DuelPressLeaderboardSort, order: SortOrder,
) -> DuelPressLeaderboardEnvelope:
    applied = DuelPressAppliedFilters(
        role=role,
        position=(position.strip() or None) if position is not None else None,
        q=(query.strip() or None) if query is not None else None,
        ageBand=age_band, minutesBand=minutes_band, sort=sort, order=order,
    )
    rows = build_duel_press_players(season, mode, scope, competition)
    if applied.role:
        rows = tuple(player for player in rows if player.archetype == applied.role)
    if applied.position:
        rows = tuple(player for player in rows if player.position == applied.position)
    rows = tuple(player for player in rows if matches_age_band(player.age, applied.ageBand))
    rows = tuple(player for player in rows if matches_minutes_band(player.minutes, applied.minutesBand))
    if applied.q:
        needle = applied.q.casefold()
        rows = tuple(
            player for player in rows
            if needle in player.name.casefold()
            or needle in player.club.name.casefold()
            or needle in player.league.name.casefold()
        )
    rows = tuple(sorted(rows, key=lambda player: (player.rank, player.id)))
    key = DUEL_PRESS_SORTABLE_FIELDS[applied.sort]
    reverse = applied.order == "desc"
    if applied.sort == "age":
        known = tuple(player for player in rows if player.age is not None)
        missing = tuple(player for player in rows if player.age is None)
        rows = tuple(sorted(known, key=key, reverse=reverse)) + missing
    else:
        rows = tuple(sorted(rows, key=key, reverse=reverse))
    population = len(rows)
    total_pages = (population + page_size - 1) // page_size
    start = (page - 1) * page_size
    selected = list(rows[start:start + page_size]) if page <= max(total_pages, 1) else []
    return DuelPressLeaderboardEnvelope.model_validate({
        "data": selected,
        "meta": {
            "season": season, "mode": mode,
            "scope": scope if mode == "league" else None,
            "competition": competition if mode == "europe" else None,
            "population": population, "returned": len(selected),
            "page": page, "pageSize": page_size, "totalItems": population,
            "totalPages": total_pages, "hasNextPage": page < total_pages,
            "applied": applied, "generatedAt": dataset_generated_at(),
        },
    })


def find_duel_press_player(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> DuelPressPlayerEnvelope | None:
    player = next((
        row for row in build_duel_press_players(season, mode, scope, competition)
        if row.id == player_id
    ), None)
    return DuelPressPlayerEnvelope(data=player) if player is not None else None


VOLUME_RADAR_AXES = (
    ("outsideShot", "Outside-box shot volume", "outside_box_shots_attempts_top_percent", "out_box_shots", "outside_box_shots_attempts_rank"),
    ("boxThreat", "Box shot volume", "box_shots_volume_top_percent", "in_box_shots", "box_shots_volume_rank"),
    ("dangerZone", "Dribble attempt volume", "dribble_attempts_volume_top_percent", "dribble_attempts", "dribble_attempts_volume_rank"),
    ("aerial", "Aerial duel volume", "aerial_duel_attempts_volume_top_percent", "aerial_duel_attempts", "aerial_duel_attempts_volume_rank"),
    ("groundDuel", "Ground duel volume", "ground_duel_attempts_volume_top_percent", "ground_duel_attempts", "ground_duel_attempts_volume_rank"),
    ("spaceControl", "Central activity area", "cca_area_top_percent", "tactical:cca_area_pct", "cca_area_rank"),
)
RATIO_RADAR_AXES = (
    ("outsideShot", "Outside-box shot quality", "spear_shot_quality_top_percent", "shot_quality_per90", "spear_shot_quality_rank"),
    ("boxThreat", "Deep-box finishing", "micro_zoning_finishing_top_percent", "tactical:deep_box_zone_score", "micro_zoning_finishing_rank"),
    ("dangerZone", "Danger-zone progression", "danger_zone_progression_top_percent", "tactical:danger_zone_density", "danger_zone_progression_rank"),
    ("aerial", "Aerial duel margin", "aerial_margin_per90_top_percent", "aerial_margin_per90", "aerial_margin_per90_rank"),
    ("groundDuel", "Ground duel margin", "duel_margin_per90_top_percent", "duel_margin_per90", "duel_margin_per90_rank"),
    ("spaceControl", "Space-control efficiency", "danger_zone_density_top_percent", "tactical:danger_zone_density", "danger_zone_density_rank"),
)


def _radar_score(percentile: float | None, imputed: bool) -> float:
    if imputed:
        return 20.0
    if percentile is None:
        return 50.0
    return round(max(0.0, min(100.0, 100.0 - float(percentile))), 2)


def _radar_tier(score: float) -> str:
    if score >= 95:
        return "S"
    if score >= 85:
        return "A"
    if score >= 65:
        return "B"
    if score >= 35:
        return "C"
    return "D"


def _raw_value(metrics: object, tactical: dict[str, object] | None, attr: str) -> float | None:
    value = tactical.get(attr.removeprefix("tactical:")) if attr.startswith("tactical:") and tactical else getattr(metrics, attr, None)
    return round(float(value), 4) if value is not None else None


def _radar(kind: str, axes: tuple[tuple[str, str, str, str, str], ...], rank: object, metrics: object, tactical: dict[str, object] | None) -> RadarChart:
    imputed_attrs = set(getattr(rank, f"spear_imputed_{kind}_attrs", ()))
    population = int(getattr(rank, "spear_volume_eligible" if kind == "volume" else "progression_eligible", 0) or 0)
    return RadarChart(kind=kind, axes=[
        RadarAxis(
            id=axis_id, label=label,
            score=_radar_score(getattr(rank, percentile_attr, None), percentile_attr in imputed_attrs),
            percentile=getattr(rank, percentile_attr, None),
            rank=getattr(rank, rank_attr, None), population=population,
            rawValue=_raw_value(metrics, tactical, raw_attr),
            tier=_radar_tier(_radar_score(getattr(rank, percentile_attr, None), percentile_attr in imputed_attrs)),
            imputed=percentile_attr in imputed_attrs,
        )
        for axis_id, label, percentile_attr, raw_attr, rank_attr in axes
    ])


def _raw_metrics(metrics: object) -> RawMetrics:
    field_map = {
        "goals": "goals", "xg": "xg", "xgot": "xgot", "minutesPlayed": "minutes_played",
        "dribblesSucceeded": "dribbles_succeeded", "dribblesSuccessRate": "dribbles_success_rate",
        "dispossessed": "dispossessed", "foulsWon": "fouls_won", "penaltiesAwarded": "penalties_awarded",
        "duelsWon": "duels_won", "duelsWonPercentage": "duels_won_percentage",
        "aerialDuelsWon": "aerial_duels_won", "aerialDuelsWonPercentage": "aerial_duels_won_percentage",
        "inBoxGoals": "in_box_goals", "inBoxXg": "in_box_xg", "inBoxXgot": "in_box_xgot", "inBoxShots": "in_box_shots",
        "outBoxGoals": "out_box_goals", "outBoxXg": "out_box_xg", "outBoxXgot": "out_box_xgot", "outBoxShots": "out_box_shots",
    }
    return RawMetrics(**{key: round(float(value), 4) if (value := getattr(metrics, attr, None)) is not None else None for key, attr in field_map.items()})


def _spatial_analysis(player_id: int, tactical: dict[str, object] | None) -> SpatialAnalysis:
    points = get_heatmap_points(player_id, str(tactical.get("heatmap_key")) if tactical and tactical.get("heatmap_key") else None)
    valid_points: list[HeatmapPoint] = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        try:
            x, y = float(point[0]), float(point[1])
        except (TypeError, ValueError):
            continue
        if 0 <= x <= 100 and 0 <= y <= 100:
            valid_points.append(HeatmapPoint(x=x, y=y))
    heatmap_key = str(tactical.get("heatmap_key")) if tactical and tactical.get("heatmap_key") else None
    try:
        snapshot_available, shot_rows = get_shotmap_snapshot(heatmap_key)
    except ShotmapSnapshotError as exc:
        raise ShotmapContractViolation("Stored shotmap snapshot could not be loaded or validated.") from exc
    valid_shots: list[ShotmapPoint] = []
    for index, shot in enumerate(shot_rows):
        try:
            valid_shots.append(ShotmapPoint.model_validate(shot))
        except (TypeError, ValueError, ValidationError) as exc:
            raise ShotmapContractViolation(
                f"Stored shotmap snapshot contains an invalid record at index {index}."
            ) from exc
    def value(name: str) -> float | None:
        raw = tactical.get(name) if tactical else None
        return round(float(raw), 4) if raw is not None else None
    core_zones = list(tactical.get("true_core_zones") or []) if tactical else []
    core_ids = list(tactical.get("true_core_zone_ids") or []) if tactical else []
    true_core = TrueCoreAnalysis(
        available=bool(tactical and core_zones),
        achievedDensityPct=round(float(tactical.get("true_core_density_pct") or 0.0), 4) if tactical else 0.0,
        zoneIds=[str(zone_id) for zone_id in core_ids],
        zoneCount=int(tactical.get("true_core_zone_count") or 0) if tactical else 0,
        coreAreaPct=round(sum(float(zone.get("areaPct") or 0.0) for zone in core_zones), 4),
        zones=[TrueCoreZone.model_validate(zone) for zone in core_zones],
    )
    continuous_payload = dict(tactical.get("continuous_core") or {}) if tactical else {}
    continuous_core = ContinuousCoreAnalysis(
        available=bool(valid_points and continuous_payload),
        achievedDensityPct=round(float(continuous_payload.get("achievedDensityPct") or 0.0), 4),
        coreAreaPct=round(float(continuous_payload.get("coreAreaPct") or 0.0), 4),
        densityThreshold=round(float(continuous_payload.get("densityThreshold") or 0.0), 8),
        thresholdOfPeak=round(float(continuous_payload.get("thresholdOfPeak") or 0.0), 8),
    )
    return SpatialAnalysis(
        available=bool(tactical), heatmapPointCount=len(valid_points), heatmapPoints=valid_points,
        shotmapPointCount=len(valid_shots), shotmapPoints=valid_shots,
        shotmapSnapshotAvailable=snapshot_available,
        inBoxRatio=value("in_box_ratio"), outBoxFinalRatio=value("out_box_final_ratio"),
        midThirdRatio=value("mid_third_ratio"), finalThirdRatio=value("final_third_ratio"),
        ccaAreaPct=value("cca_area_pct"), laneRatios=[value(f"lane_{index}_ratio") or 0.0 for index in range(1, 6)] if tactical else [],
        depthRatios=[value(f"depth_{index}_ratio") or 0.0 for index in range(1, 7)] if tactical else [],
        positionalGrid=[
            PositionalGridCell(depth=depth, lane=lane, occupancyPct=value(f"grid_d{depth}_l{lane}_ratio") or 0.0)
            for depth in range(1, 7) for lane in range(1, 6)
        ] if tactical else [],
        trueCore=true_core, continuousCore=continuous_core,
        dangerZoneDensity=value("danger_zone_density"), deepBoxZoneScore=value("deep_box_zone_score"),
    )


MESSI_SECTOR_WEIGHTS = {
    "boxThreat": 0.30,
    "outsideShot": 0.20,
    "dangerZone": 0.15,
    "spaceControl": 0.15,
    "aerial": 0.10,
    "groundDuel": 0.10,
}


def _messi_data_quality(metrics: object, tactical: dict[str, object] | None) -> MessiDataQuality:
    """Mirror the score engine's volume/ratio availability without rescoring."""
    available = {
        "outsideShot.volume": getattr(metrics, "out_box_shots", None) is not None,
        "outsideShot.ratio": getattr(metrics, "out_box_shot_quality", None) is not None,
        "boxThreat.volume": getattr(metrics, "in_box_shots", None) is not None,
        "boxThreat.ratio": tactical is not None and getattr(metrics, "in_box_finishing_per90", None) is not None,
        "dangerZone.volume": getattr(metrics, "dribble_attempts", None) is not None,
        "dangerZone.ratio": (
            tactical is not None
            and tactical.get("danger_zone_density") is not None
            and getattr(metrics, "dribble_margin_per90", None) is not None
        ),
        "aerial.volume": getattr(metrics, "aerial_duel_attempts", None) is not None,
        "aerial.ratio": getattr(metrics, "aerial_margin_per90", None) is not None,
        "groundDuel.volume": getattr(metrics, "ground_duel_attempts", None) is not None,
        "groundDuel.ratio": getattr(metrics, "duel_margin_per90", None) is not None,
        "spaceControl.volume": tactical is not None and tactical.get("cca_area_pct") is not None,
        "spaceControl.ratio": tactical is not None and tactical.get("danger_zone_density") is not None,
    }
    imputed_components = [component for component, present in available.items() if not present]
    imputed_metrics = [
        metric for metric in MESSI_SECTOR_WEIGHTS
        if any(component.startswith(f"{metric}.") for component in imputed_components)
    ]
    missing_weight = sum(
        MESSI_SECTOR_WEIGHTS[component.split(".", 1)[0]] * 0.5
        for component in imputed_components
    )
    spatial_available = tactical is not None
    raw_missing = any(
        not present for component, present in available.items()
        if not component.startswith("spaceControl.")
        and component not in {"boxThreat.ratio", "dangerZone.ratio"}
    )
    if not imputed_components:
        reason = "complete"
    elif not spatial_available and raw_missing:
        reason = "mixed_source_missing"
    elif not spatial_available:
        reason = "spatial_session_missing"
    else:
        reason = "source_metric_missing"
    return MessiDataQuality(
        spatialAvailable=spatial_available,
        messiScoreComplete=not imputed_components,
        reason=reason,
        imputedMetrics=imputed_metrics,
        imputedComponents=imputed_components,
        observedWeightPct=round(max(0.0, 1.0 - missing_weight) * 100.0, 1),
    )


@lru_cache(maxsize=512)
def build_player_data_quality(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> PlayerDataQuality | None:
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    cohort = load_spear_cohort().get((player.league.id, season), {})
    source = cohort.get(str(player_id))
    if source is None:
        return None
    _, metrics = source
    tactical = get_tactical_ratio_for_session(
        player_id, metrics.league_name or player.league.name, season,
    )
    return PlayerDataQuality(
        playerId=player_id,
        season=season,
        mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
        dataQuality=_messi_data_quality(metrics, tactical),
    )


@lru_cache(maxsize=512)
def build_player_detail(player_id: int, season: str, mode: str, scope: int, competition: str) -> PlayerDetailResponse | None:
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    cohort = load_spear_cohort().get((player.league.id, season), {})
    source = cohort.get(str(player_id))
    if source is None:
        return None
    _, metrics = source
    tactical = get_tactical_ratio_for_session(player_id, metrics.league_name or player.league.name, season)
    rank = calculate_league_percentiles(
        str(player_id), season, metrics, minimum_xg=1.0, restrict_to_forwards=True,
        minimum_final_third_ratio=0, comparison_scope=scope,
    )
    analysis = PlayerAnalysis(
        score=MessiScoreAnalysis(
            value=round(float(rank.spear_score if rank.spear_score is not None else player.score), 2),
            rank=rank.spear_score_rank or player.rank, topPercent=rank.spear_score_top_percent,
            population=rank.spear_score_eligible, archetype=player.archetype,
        ),
        volumeRadar=_radar("volume", VOLUME_RADAR_AXES, rank, metrics, tactical),
        ratioRadar=_radar("ratio", RATIO_RADAR_AXES, rank, metrics, tactical),
        rawMetrics=_raw_metrics(metrics), spatial=_spatial_analysis(player_id, tactical),
    )
    return PlayerDetailResponse(**player.model_dump(), analysis=analysis)


def build_duel_spatial_analysis(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> DuelSpatialAnalysis | None:
    """Expose an honest opt-in contract until verified duel events are loaded.

    No repository dataset currently contains duel type + outcome + coordinate
    tuples.  In particular, activity heatmap points are not substituted here.
    Existing M.E.S.S.I. duel sectors therefore remain unchanged.
    """
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    return DuelSpatialAnalysis(
        playerId=player_id, season=season, mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
        available=False, appliedToMessiRating=False,
        reason="event_coordinates_unavailable", cohortPopulation=0,
    )


@lru_cache(maxsize=512)
def build_tactical_quadrant_analysis(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> TacticalQuadrantAnalysis | None:
    """Return the legacy quadrant as a stable, server-computed API contract.

    The cohort and both axes deliberately reuse ``get_tactical_matrix`` so the
    chart cannot drift away from the percentile population used in the detail
    report.  This is a companion endpoint to avoid breaking older strict
    clients that already consume ``PlayerAnalysis``.
    """
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    cohort = load_spear_cohort().get((player.league.id, season), {})
    source = cohort.get(str(player_id))
    if source is None:
        return None
    _, metrics = source
    matrix = get_tactical_matrix(
        player.league.id, season, True, 0, scope,
    )
    rows = matrix.to_dict(orient="records") if not matrix.empty else []
    selected_key = str(player_id)
    if not any(str(row.get("player_id")) == selected_key for row in rows):
        net_progression = getattr(metrics, "net_progression_per90", None)
        finishing = getattr(metrics, "in_box_finishing", None)
        if net_progression is not None and finishing is not None:
            rows.append({
                "player_id": selected_key,
                "player_name": player.name,
                "team_name": metrics.team_name or player.club.name,
                "net_progression_per90": net_progression,
                "in_box_xgot_minus_xg": finishing,
            })

    points = [
        TacticalQuadrantPoint(
            playerId=int(row["player_id"]),
            playerName=str(row.get("player_name") or "Unknown player"),
            teamName=str(row.get("team_name") or ""),
            netProgressionPer90=float(row["net_progression_per90"]),
            inBoxXgotMinusXg=float(row["in_box_xgot_minus_xg"]),
            selected=str(row["player_id"]) == selected_key,
        )
        for row in rows
        if row.get("net_progression_per90") is not None
        and row.get("in_box_xgot_minus_xg") is not None
    ]
    selected = next((point for point in points if point.selected), None)
    if not points:
        reason = "cohort_unavailable"
    elif selected is None:
        reason = "axis_metric_missing"
    else:
        reason = "complete"
    x_values = [point.netProgressionPer90 for point in points]
    y_values = [point.inBoxXgotMinusXg for point in points]
    x_values.sort()
    y_values.sort()

    def median(values: list[float]) -> float | None:
        if not values:
            return None
        middle = len(values) // 2
        if len(values) % 2:
            return round(values[middle], 4)
        return round((values[middle - 1] + values[middle]) / 2.0, 4)

    return TacticalQuadrantAnalysis(
        playerId=player_id,
        season=season,
        mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
        available=reason == "complete",
        reason=reason,
        cohortPopulation=len(points),
        xMedian=median(x_values),
        yMedian=median(y_values),
        selectedPoint=selected,
        points=points,
    )


def compare_players(player_ids: tuple[int, ...], season: str, mode: str, scope: int, competition: str) -> PlayerComparisonEnvelope | None:
    details = [build_player_detail(player_id, season, mode, scope, competition) for player_id in player_ids]
    if any(detail is None for detail in details):
        return None
    rows = build_v2_players(season, mode, scope, competition)
    return PlayerComparisonEnvelope(
        data=[detail for detail in details if detail is not None],
        meta=CompareMeta(
            season=season, mode=mode, scope=scope if mode == "league" else None,
            competition=competition if mode == "europe" else None, population=len(rows),
            generatedAt=dataset_generated_at(),
        ),
    )


def leaderboard_options() -> dict[str, object]:
    seasons = sorted(supported_seasons(), reverse=True)
    return {
        "seasons": seasons,
        "scopes": [{"value": scope, "label": f"{scope} major leagues", "leagueIds": sorted(ids)} for scope, ids in sorted(COMPARISON_SCOPES.items())],
        "competitions": available_competitions(seasons[0]) if seasons else {},
    }


def find_v2_player(player_id: int, season: str, mode: str, scope: int, competition: str) -> PlayerResponse | None:
    return next((player for player in build_v2_players(season, mode, scope, competition) if player.id == player_id), None)


def resolve_watchlist_entries(entries: list[dict[str, object]]) -> list[WatchlistResolveResult]:
    """Resolve independently submitted browser watchlist entries from static data.

    Watchlists remain entirely client-owned.  This function only validates a
    context and returns a current snapshot for that single request.
    """
    resolved: list[WatchlistResolveResult] = []
    valid_competitions = {"all", "ucl", "uel", "uecl"}

    for entry in entries:
        key = entry.get("key")
        result_key = key if isinstance(key, str) and len(key) <= 500 else ""
        player_ref = entry.get("player")
        context_ref = entry.get("context")
        if not isinstance(player_ref, dict) or not isinstance(context_ref, dict):
            resolved.append(WatchlistResolveResult(key=result_key, status="invalid_context"))
            continue

        player_id = player_ref.get("playerId")
        namespace = player_ref.get("idNamespace")
        season = context_ref.get("season")
        mode = context_ref.get("mode")
        scope = context_ref.get("scope")
        competition = context_ref.get("competition")
        valid_player = isinstance(player_id, int) and not isinstance(player_id, bool) and player_id > 0
        valid_common = (
            namespace == "fotmob"
            and valid_player
            and isinstance(season, str)
            and season in supported_seasons()
            and mode in {"league", "europe"}
        )
        if not valid_common:
            resolved.append(WatchlistResolveResult(key=result_key, status="invalid_context"))
            continue

        if mode == "league":
            if scope not in COMPARISON_SCOPES or competition not in {None, "all"}:
                resolved.append(WatchlistResolveResult(key=result_key, status="invalid_context"))
                continue
            expected_key = f"fotmob:{player_id}|season:{season}|mode:league|scope:{scope}|competition:null"
            if key != expected_key:
                resolved.append(WatchlistResolveResult(key=result_key, status="invalid_context"))
                continue
            normalized_context = WatchlistResolvedContext(
                season=season, mode="league", scope=scope, competition=None,
            )
            player = find_v2_player(player_id, season, "league", scope, "all")
        else:
            if scope is not None or competition not in valid_competitions:
                resolved.append(WatchlistResolveResult(key=result_key, status="invalid_context"))
                continue
            expected_key = f"fotmob:{player_id}|season:{season}|mode:europe|scope:null|competition:{competition}"
            if key != expected_key:
                resolved.append(WatchlistResolveResult(key=result_key, status="invalid_context"))
                continue
            normalized_context = WatchlistResolvedContext(
                season=season, mode="europe", scope=None, competition=competition,
            )
            player = find_v2_player(player_id, season, "europe", 7, competition)

        if player is None:
            resolved.append(WatchlistResolveResult(
                key=result_key, status="unavailable", context=normalized_context,
            ))
            continue
        resolved.append(WatchlistResolveResult(
            key=result_key,
            status="resolved",
            context=normalized_context,
            player=WatchlistResolvedPlayer(**player.model_dump(), playerId=player.id),
        ))
    return resolved


def resolve_watchlist_data_quality(
    entries: list[dict[str, object]],
) -> list[WatchlistDataQualityResult]:
    """Batch the non-breaking data-quality companion contract for Watchlists."""
    results: list[WatchlistDataQualityResult] = []
    for resolved in resolve_watchlist_entries(entries):
        if resolved.status != "resolved" or resolved.player is None or resolved.context is None:
            results.append(WatchlistDataQualityResult(
                key=resolved.key,
                status=resolved.status,
                context=resolved.context,
            ))
            continue
        context = resolved.context
        quality = build_player_data_quality(
            resolved.player.playerId,
            context.season,
            context.mode,
            context.scope or 8,
            context.competition or "all",
        )
        results.append(WatchlistDataQualityResult(
            key=resolved.key,
            status="resolved" if quality is not None else "unavailable",
            playerId=resolved.player.playerId,
            context=context,
            dataQuality=quality.dataQuality if quality is not None else None,
        ))
    return results


@lru_cache(maxsize=1)
def dataset_generated_at() -> datetime:
    """Deterministic snapshot time derived from the static inputs, never request time."""
    root = Path(__file__).resolve().parents[1] / "data"
    inputs = (
        root / "spear_cohort.csv",
        root / "tactical_3zone_ratio.csv",
        root / "player_profiles.csv",
    )
    modified = max(path.stat().st_mtime for path in inputs if path.exists())
    return datetime.fromtimestamp(modified, timezone.utc)


@lru_cache(maxsize=1)
def supported_seasons() -> frozenset[str]:
    return frozenset(season for _, season in load_spear_cohort())


def players_envelope(season: str, scope: int, limit: int) -> PlayersEnvelope:
    all_players = build_players(season, scope)
    selected = list(all_players[:limit])
    return PlayersEnvelope(
        data=selected,
        meta=DatasetMeta(
            season=season,
            scope=scope,
            population=len(all_players),
            returned=len(selected),
            generatedAt=dataset_generated_at(),
        ),
    )
