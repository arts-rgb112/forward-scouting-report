from __future__ import annotations

from bisect import bisect_left, bisect_right
from datetime import datetime, timezone
from collections import OrderedDict
from functools import cmp_to_key, lru_cache
import hashlib
import json
import math
from pathlib import Path
from threading import RLock
import time
from pydantic import ValidationError

from rankings import (
    COMPARISON_SCOPES, EUROPEAN_LEADERBOARD_ID, calculate_league_percentiles,
    get_spear_leaderboard, get_tactical_matrix,
)
from spear_cohort import load_spear_cohort
from tactical_ratio import (
    get_heatmap_points, get_tactical_ratio_for_session, get_tactical_session_row,
)
from shotmap_store_v2 import (
    ShotmapSnapshotError, get_shotmap_snapshot, shotmap_snapshot_revision,
)
from positional_grid import POSITIONAL_DEPTH_BOUNDARIES, POSITIONAL_LANE_BOUNDARIES

from .schemas import (
    AgeBand, AssetRef, CompareMeta, ContinuousCoreAnalysis, DatasetMeta, DuelSpatialAnalysis, HeatmapPoint, ShotmapPoint, LeaderboardAppliedFilters, LeaderboardEnvelope,
    DuelPressAppliedFilters, DuelPressComponents, DuelPressLeaderboardEnvelope,
    DuelPressLeaderboardSort, DuelPressPlayerEnvelope, DuelPressPlayerResponse,
    DuelPressPlayerStats, DuelPressRawMetrics, DuelPressRequestContext,
    DetailReadoutComparison, DuelPressDetailCategory, DuelPressDetailPlayerIdentity,
    DuelPressDetailReadout, DuelPressDetailReadoutEnvelope,
    DetailV2Comparison, DetailV2Datum, DetailV2Metric, DetailV2Group,
    DuelPressDetailV2Category, DuelPressDetailV2ContextIndicator,
    DuelPressDetailReadoutV2Envelope, DuelPressV2BoardCategory, DuelPressV2RatingStats,
    DuelPressV2LeaderboardPlayer, DuelPressV2LeaderboardPageEnvelope,
    DuelPressV2PlayerEnvelope, DuelPressV2LeaderboardMeta, DuelPressV2CohortContext,
    ContextualCompareCanonicalContext, ContextualCompareEnvelope,
    ContextualCompareComponentAvailability, ContextualCompareRequestSide, ContextualCompareSide,
    DuelPressMetricRanks, MetricRankContext, MetricRankRequestEntry,
    MetricRankResult, MetricRankValue,
    LeaderboardPageEnvelope, MessiDataQuality, MessiScoreAnalysis, PlayerAnalysis,
    LeaderboardSort, MinutesBand, SortOrder,
    PlayerComparisonEnvelope, PlayerDataQuality, PlayerDetailResponse, PlayerResponse,
    PlayersEnvelope, PlayerStats, PlayerTier, RadarAxis, RadarChart,
    PositionalGridCell, RawMetrics, SpatialAnalysis,
    TacticalQuadrantAnalysis, TacticalQuadrantPoint,
    TrueCoreAnalysis, TrueCoreZone,
    WatchlistDataQualityResult, WatchlistResolveResult, WatchlistResolvedContext,
    WatchlistResolvedPlayer,
    RatioBenchmarkAxis, RatioBenchmarkData,
    TacticalSummaryData, TacticalSummaryLine,
    VolumeBenchmarkAxis, VolumeBenchmarkData,
    VolumeBenchmarkSourceContext,
    FinalThirdCoverageIssue, FinalThirdFieldState, FinalThirdGoalMouthCoordinates,
    FinalThirdMarkerSizeScale, FinalThirdShot, FinalThirdShotContext,
    FinalThirdEffectiveShotData, FinalThirdEffectiveShotEnvelope, FinalThirdEffectiveShotZone,
    FinalThirdEffectiveShotZoneFieldStates,
    FinalThirdGoalMouthData, FinalThirdGoalMouthEnvelope, FinalThirdShootingQualitySummary,
    FinalThirdQualityScale, FinalThirdShotData, FinalThirdShotEnvelope, FinalThirdShotZone,
    FinalThirdZoneFieldStates,
    GoalMouthBaselineCell, GoalMouthBaselineConfidenceInterval, GoalMouthBaselineData, GoalMouthBaselineEnvelope,
    GoalMouthBaselineProvenance,
)
from .profiles import league_logo_url, player_age, player_face_url, team_logo_url
from .search import canonical_search_key


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


@lru_cache(maxsize=16)
def build_v2_players(season: str, mode: str, scope: int, competition: str) -> tuple[PlayerResponse, ...]:
    """Return only rows backed by the static snapshot; no synthetic competition data."""
    target = leaderboard_target(mode, scope, competition)
    # v2 explicitly represents a missing verified birth date as ``age: null``.
    # Legacy v1 remains strict and continues to omit incomplete profiles.
    return _players_from_frame(
        get_spear_leaderboard(target, season, scope), require_complete_profiles=False,
    )


@lru_cache(maxsize=16)
def _v2_player_summary_index(
    season: str, mode: str, scope: int, competition: str,
) -> dict[int, PlayerResponse]:
    """Index one static summary context after its canonical cohort is built.

    The public summary response is unchanged; this avoids a repeated linear
    scan when history rails and direct player links ask for the same context.
    The underlying ``build_v2_players`` cache remains the sole cohort source,
    so no score or context can be fabricated by the index.
    """
    return {player.id: player for player in build_v2_players(season, mode, scope, competition)}


@lru_cache(maxsize=16)
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


# A player response is immutable for the lifetime of its static-cohort cache.
# Keep one normalized joined name/club/league haystack per cohort identity so a
# type-ahead request normalizes its short query, rather than every row in the
# population.  Checking object identity also invalidates this small cache when
# a cohort cache is explicitly refreshed in a long-running process.
_SEARCH_HAYSTACK_CACHE_LIMIT = 64
_search_haystack_cache: OrderedDict[
    tuple[str, str, str, int, str],
    tuple[object, dict[int, str]],
] = OrderedDict()
_search_haystack_cache_lock = RLock()
_search_haystack_cache_builds = 0


def _cached_search_haystacks(
    *, kind: str, season: str, mode: str, scope: int, competition: str,
    rows: tuple[PlayerResponse, ...] | tuple[DuelPressPlayerResponse, ...],
) -> dict[int, str]:
    """Return prebuilt search keys for one cached static cohort context."""
    global _search_haystack_cache_builds
    cache_key = (kind, season, mode, scope, competition)
    with _search_haystack_cache_lock:
        cached = _search_haystack_cache.get(cache_key)
        if cached is not None and cached[0] is rows:
            _search_haystack_cache.move_to_end(cache_key)
            return cached[1]

        haystacks = {
            player.id: canonical_search_key(
                f"{player.name}\u001f{player.club.name}\u001f{player.league.name}"
            )
            for player in rows
        }
        _search_haystack_cache[cache_key] = (rows, haystacks)
        _search_haystack_cache.move_to_end(cache_key)
        while len(_search_haystack_cache) > _SEARCH_HAYSTACK_CACHE_LIMIT:
            _search_haystack_cache.popitem(last=False)
        _search_haystack_cache_builds += 1
        return haystacks


def _clear_search_haystack_cache() -> None:
    """Test/support hook for an explicitly refreshed static cohort."""
    global _search_haystack_cache_builds
    with _search_haystack_cache_lock:
        _search_haystack_cache.clear()
        _search_haystack_cache_builds = 0


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
    *, search_haystacks: dict[int, str] | None = None,
) -> tuple[PlayerResponse, ...]:
    if applied.role:
        rows = tuple(player for player in rows if player.archetype == applied.role)
    if applied.position:
        rows = tuple(player for player in rows if player.position == applied.position)
    rows = tuple(player for player in rows if matches_age_band(player.age, applied.ageBand))
    rows = tuple(player for player in rows if matches_minutes_band(player.minutes, applied.minutesBand))
    if applied.q:
        needle = canonical_search_key(applied.q)
        rows = tuple(
            player for player in rows
            if needle in (search_haystacks[player.id] if search_haystacks is not None
                          else canonical_search_key(
                              f"{player.name}\u001f{player.club.name}\u001f{player.league.name}"
                          ))
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
    cohort = build_v2_players(season, mode, scope, competition)
    return _apply_leaderboard_filters(
        cohort, applied,
        search_haystacks=(
            _cached_search_haystacks(
                kind="v2", season=season, mode=mode, scope=scope,
                competition=competition,
                rows=cohort,
            ) if applied.q else None
        ),
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
    cohort = build_v2_players(season, mode, scope, competition)
    rows = _apply_leaderboard_filters(
        cohort, applied,
        search_haystacks=(
            _cached_search_haystacks(
                kind="v2", season=season, mode=mode, scope=scope,
                competition=competition, rows=cohort,
            ) if applied.q else None
        ),
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
    if page_size != 50:
        raise ValueError("duel-press-v1 requires pageSize=50")
    applied = DuelPressAppliedFilters(
        role=role,
        position=(position.strip() or None) if position is not None else None,
        q=(query.strip() or None) if query is not None else None,
        ageBand=age_band, minutesBand=minutes_band, sort=sort, order=order,
    )
    cohort = build_duel_press_players(season, mode, scope, competition)
    rows = cohort
    if applied.role:
        rows = tuple(player for player in rows if player.archetype == applied.role)
    if applied.position:
        rows = tuple(player for player in rows if player.position == applied.position)
    rows = tuple(player for player in rows if matches_age_band(player.age, applied.ageBand))
    rows = tuple(player for player in rows if matches_minutes_band(player.minutes, applied.minutesBand))
    if applied.q:
        needle = canonical_search_key(applied.q)
        search_haystacks = _cached_search_haystacks(
            kind="duel-press", season=season, mode=mode, scope=scope,
            competition=competition, rows=cohort,
        )
        rows = tuple(
            player for player in rows
            if needle in search_haystacks[player.id]
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
    if player is None:
        return None
    context = DuelPressRequestContext(
        playerId=player_id,
        season=season,
        mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
    )
    return DuelPressPlayerEnvelope(context=context, data=player)


# The detail endpoint intentionally reads only the already-cached static
# leaderboard frame.  These formula identifiers correspond to the legacy
# quadrant bars, so a browser never needs to reconstruct an attempt, loss,
# margin, finishing delta, or contextual indicator.
DETAIL_READOUT_FORMULA_VERSION = "legacy-bars-v1"


def _detail_number(value: object) -> float | None:
    number = _optional_number(value)
    return round(number, 4) if number is not None else None


def _detail_comparison(
    value: float | None, values: list[float], direction: str,
) -> DetailReadoutComparison:
    """Calculate an exact-context distribution position from static values."""
    if not values:
        return DetailReadoutComparison(state="unavailable", population=0)
    ordered = sorted(values)
    count = len(ordered)
    midpoint = count // 2
    median = (
        ordered[midpoint]
        if count % 2
        else (ordered[midpoint - 1] + ordered[midpoint]) / 2.0
    )
    if value is None:
        return DetailReadoutComparison(
            state="unavailable", median=round(float(median), 4), population=count,
        )
    if direction == "lower_is_better":
        rank = 1 + sum(candidate < value for candidate in ordered)
    else:
        # Neutral indicators expose distribution location only; the client
        # must consult ``direction: neutral`` before inferring desirability.
        rank = 1 + sum(candidate > value for candidate in ordered)
    percentile = 100.0 if count == 1 else round((count - rank) * 100.0 / (count - 1), 2)
    return DetailReadoutComparison(
        state="available", median=round(float(median), 4), rank=rank,
        percentile=percentile, population=count,
    )


def _detail_readout(
    *, identifier: str, label: str, value: float | None, unit: str,
    direction: str, source: str, comparison_values: list[float],
    formula_id: str | None = None, state: str = "observed",
    missing_components: list[str] | None = None,
) -> DuelPressDetailReadout:
    if value is None:
        return DuelPressDetailReadout(
            id=identifier, label=label, value=None, unit=unit, direction=direction,
            source="unavailable", state="unavailable",
            comparison=_detail_comparison(None, comparison_values, direction),
            formulaId=formula_id,
            formulaVersion=DETAIL_READOUT_FORMULA_VERSION if formula_id else None,
            missingComponents=missing_components,
        )
    return DuelPressDetailReadout(
        id=identifier, label=label, value=value, unit=unit, direction=direction,
        source=source, state=state,
        comparison=_detail_comparison(value, comparison_values, direction),
        formulaId=formula_id if state == "server_derived" else None,
        formulaVersion=DETAIL_READOUT_FORMULA_VERSION if state == "server_derived" else None,
        missingComponents=missing_components,
    )


def _detail_frame_records(season: str, mode: str, scope: int, competition: str) -> list[dict[str, object]]:
    """Return only detail-eligible rows for one canonical static context."""
    target = leaderboard_target(mode, scope, competition)
    frame = get_spear_leaderboard(target, season, scope)
    eligible_ids = {player.id for player in build_duel_press_players(season, mode, scope, competition)}
    records: list[dict[str, object]] = []
    for record in frame.to_dict(orient="records"):
        try:
            if _source_player_id(record.get("player_id")) in eligible_ids:
                records.append(record)
        except (TypeError, ValueError):
            continue
    return records


def _detail_values(records: list[dict[str, object]], column: str) -> list[float]:
    return [value for record in records if (value := _detail_number(record.get(column))) is not None]


def _detail_missing_score_components(record: dict[str, object], category: str) -> list[str]:
    required = {
        "outsideShot": ("out_box_shots_raw", "out_box_shot_quality_goals_raw"),
        "boxThreat": ("in_box_shots_raw", "in_box_finishing_per90_raw", "deep_box_zone_score"),
        "dangerZone": ("dribble_attempts_raw", "dribble_margin_per90_raw", "danger_zone_density"),
        "combinedDuel": (
            "ground_duel_attempts_raw", "aerial_duel_attempts_raw",
            "duel_margin_per90_raw", "aerial_margin_per90_raw",
        ),
        "spaceControl": ("cca_area_pct", "danger_zone_density"),
        "forwardPress": ("recoveries_per90", "final_third_possessions_won_per90"),
    }[category]
    return [field for field in required if _detail_number(record.get(field)) is None]


def _detail_forward_readout(
    *, identifier: str, label: str, value: float | None, unit: str,
    source: str | None, comparison_values: list[float], is_total: bool,
) -> DuelPressDetailReadout:
    if source is None:
        return _detail_readout(
            identifier=identifier, label=label, value=None, unit=unit,
            direction="higher_is_better", source="unavailable",
            comparison_values=comparison_values,
        )
    fallback_total = source == "league_per90_fallback" and is_total
    return _detail_readout(
        identifier=identifier, label=label, value=value, unit=unit,
        direction="higher_is_better", source=source,
        comparison_values=comparison_values,
        formula_id="league-per90-total-v1" if fallback_total else None,
        state="server_derived" if fallback_total else "observed",
    )


def find_duel_press_detail_readouts(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> DuelPressDetailReadoutEnvelope | None:
    """Build a strict, server-owned detail readout without provider fan-out."""
    players = build_duel_press_players(season, mode, scope, competition)
    player = next((row for row in players if row.id == player_id), None)
    if player is None:
        return None
    records = _detail_frame_records(season, mode, scope, competition)
    record = next((
        row for row in records
        if _source_player_id(row.get("player_id")) == player_id
    ), None)
    if record is None:
        return None

    def raw(column: str) -> float | None:
        return _detail_number(record.get(column))

    def values(column: str) -> list[float]:
        return _detail_values(records, column)

    def direct(identifier: str, label: str, column: str, unit: str, direction: str = "higher_is_better") -> DuelPressDetailReadout:
        return _detail_readout(
            identifier=identifier, label=label, value=raw(column), unit=unit,
            direction=direction, source="player_season_total", comparison_values=values(column),
        )

    def derived(identifier: str, label: str, column: str, unit: str, direction: str = "higher_is_better", formula_id: str = "legacy-bars-v1") -> DuelPressDetailReadout:
        return _detail_readout(
            identifier=identifier, label=label, value=raw(column), unit=unit,
            direction=direction, source="server_derived", comparison_values=values(column),
            formula_id=formula_id, state="server_derived",
        )

    def spatial(identifier: str, label: str, column: str, unit: str) -> DuelPressDetailReadout:
        return _detail_readout(
            identifier=identifier, label=label, value=raw(column), unit=unit,
            direction="higher_is_better", source="tactical_ratio_static", comparison_values=values(column),
        )

    score_values = {
        "outsideShot": [row.stats.outsideShot for row in players],
        "boxThreat": [row.stats.boxThreat for row in players],
        "dangerZone": [row.stats.dangerZone for row in players],
        "combinedDuel": [row.stats.combinedDuel for row in players],
        "spaceControl": [row.stats.spaceControl for row in players],
        "forwardPress": [row.stats.forwardPress for row in players],
    }
    scores = {
        "outsideShot": player.stats.outsideShot, "boxThreat": player.stats.boxThreat,
        "dangerZone": player.stats.dangerZone, "combinedDuel": player.stats.combinedDuel,
        "spaceControl": player.stats.spaceControl, "forwardPress": player.stats.forwardPress,
    }
    labels = {
        "outsideShot": "박스 밖 슈팅", "boxThreat": "박스 위협", "dangerZone": "돌파와 위험 지역",
        "combinedDuel": "통합 경합", "spaceControl": "공간 점유", "forwardPress": "전방 압박",
    }
    category_readouts = {
        "outsideShot": [
            direct("outsideBoxShots", "박스 밖 슈팅", "out_box_shots_raw", "count"),
            direct("outsideBoxXg", "박스 밖 xG", "out_box_xg_raw", "goals"),
            direct("outsideBoxXgot", "박스 밖 xGOT", "out_box_xgot_raw", "goals"),
            derived("outsideBoxShotQualityGoals", "박스 밖 슈팅 질 (xGOT-xG)", "out_box_shot_quality_goals_raw", "goals"),
        ],
        "boxThreat": [
            direct("inBoxShots", "박스 안 슈팅", "in_box_shots_raw", "count"),
            direct("inBoxXg", "박스 안 xG", "in_box_xg_raw", "goals"),
            direct("inBoxXgot", "박스 안 xGOT", "in_box_xgot_raw", "goals"),
            derived("inBoxFinishingGoals", "박스 안 순수 결정력 (xGOT-xG)", "in_box_finishing_goals_raw", "goals"),
            derived("inBoxFinishingPer90", "박스 안 순수 결정력 /90", "in_box_finishing_per90_raw", "per90", formula_id="per90-finishing-v1"),
            spatial("deepBoxZoneScore", "딥 박스 존 점유", "deep_box_zone_score", "score"),
        ],
        "dangerZone": [
            derived("successfulDribblesPer90", "성공 드리블 /90", "dribbles_succeeded_per90_raw", "per90", formula_id="per90-successful-dribbles-v1"),
            derived("failedDribblesPer90", "실패 드리블 /90", "dribbles_failed_per90_raw", "per90", "lower_is_better", "failed-dribbles-v1"),
            derived("dribbleMarginPer90", "드리블 마진 /90", "dribble_margin_per90_raw", "per90", formula_id="dribble-margin-v1"),
            derived("dribbleAttempts", "드리블 시도", "dribble_attempts_raw", "count", formula_id="attempts-from-rate-v1"),
            direct("dribbleSuccessRate", "드리블 성공률", "dribble_success_rate_raw", "percent"),
            spatial("dangerZoneDensity", "위험 지역 밀도", "danger_zone_density", "percent"),
        ],
        "combinedDuel": [
            derived("groundDuelAttempts", "지상 경합 시도", "ground_duel_attempts_raw", "count", formula_id="attempts-from-rate-v1"),
            derived("groundWonPer90", "지상 경합 승리 /90", "ground_won_per90_raw", "per90", formula_id="per90-ground-wins-v1"),
            derived("groundLostPer90", "지상 경합 패배 /90", "ground_lost_per90_raw", "per90", "lower_is_better", "ground-losses-from-rate-v1"),
            derived("duelMarginPer90", "지상 경합 마진 /90", "duel_margin_per90_raw", "per90", formula_id="ground-margin-v1"),
            direct("groundDuelWinRate", "지상 경합 승률", "ground_duel_win_rate_raw", "percent"),
            derived("aerialDuelAttempts", "공중 경합 시도", "aerial_duel_attempts_raw", "count", formula_id="attempts-from-rate-v1"),
            derived("aerialWonPer90", "공중 경합 승리 /90", "aerial_won_per90_raw", "per90", formula_id="per90-aerial-wins-v1"),
            derived("aerialLostPer90", "공중 경합 패배 /90", "aerial_lost_per90_raw", "per90", "lower_is_better", "aerial-losses-from-rate-v1"),
            derived("aerialMarginPer90", "공중 경합 마진 /90", "aerial_margin_per90_raw", "per90", formula_id="aerial-margin-v1"),
            direct("aerialDuelWinRate", "공중 경합 승률", "aerial_duel_win_rate_raw", "percent"),
        ],
        "spaceControl": [
            spatial("ccaAreaPct", "CCA 면적", "cca_area_pct", "percent"),
            spatial("dangerZoneDensity", "위험 지역 밀도", "danger_zone_density", "percent"),
        ],
        "forwardPress": [
            _detail_forward_readout(identifier="recoveries", label="회수", value=raw("recoveries"), unit="count", source=_optional_source(record.get("recoveries_source")), comparison_values=values("recoveries"), is_total=True),
            _detail_forward_readout(identifier="recoveriesPer90", label="회수 /90", value=raw("recoveries_per90"), unit="per90", source=_optional_source(record.get("recoveries_source")), comparison_values=values("recoveries_per90"), is_total=False),
            _detail_forward_readout(identifier="finalThirdPossessionsWon", label="파이널 서드 볼 탈취", value=raw("final_third_possessions_won"), unit="count", source=_optional_source(record.get("final_third_possessions_won_source")), comparison_values=values("final_third_possessions_won"), is_total=True),
            _detail_forward_readout(identifier="finalThirdPossessionsWonPer90", label="파이널 서드 볼 탈취 /90", value=raw("final_third_possessions_won_per90"), unit="per90", source=_optional_source(record.get("final_third_possessions_won_source")), comparison_values=values("final_third_possessions_won_per90"), is_total=False),
        ],
    }
    categories: list[DuelPressDetailCategory] = []
    for category in ("outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"):
        missing_components = _detail_missing_score_components(record, category)
        categories.append(DuelPressDetailCategory(
            id=category, label=labels[category], score=scores[category],
            scoreState="imputed" if missing_components else "observed",
            imputedComponents=missing_components,
            comparison=_detail_comparison(scores[category], score_values[category], "higher_is_better"),
            readouts=category_readouts[category],
        ))
    context_indicators = [
        derived("netProgressionPer90", "순수 전진 /90", "net_progression_per90_raw", "per90", "neutral", "net-progression-v1"),
        derived("shootingLuckOrGoalkeeperImpact", "득점 운 · 상대 선방", "shooting_luck_or_goalkeeper_impact_raw", "goals", "neutral", "goals-minus-xgot-v1"),
    ]
    context = DuelPressRequestContext(
        playerId=player_id, season=season, mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
    )
    return DuelPressDetailReadoutEnvelope(
        context=context,
        player=DuelPressDetailPlayerIdentity(
            id=player.id, name=player.name, position=player.position,
            club=player.club, league=player.league,
        ),
        categories=categories, contextIndicators=context_indicators,
    )


# ---------------------------------------------------------------------------
# stat-pairs-v2: one canonical calculator for the v2 board, player, and detail
# ---------------------------------------------------------------------------
DETAIL_V2_FORMULA_VERSION = "stat-pairs-v2"
V2_MISSING_COMPONENT_SCORE = 20
V2_CATEGORY_ORDER = (
    "outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress",
)

# Integer point weights keep the published 30/20/15/15/10/10 formula exact.
# Do not use binary floats here: a .5 total changed with expression order and
# made otherwise identical score calculations disagree by one point.
V2_OVERALL_WEIGHT_POINTS = {
    "boxThreat": 30,
    "outsideShot": 20,
    "dangerZone": 15,
    "spaceControl": 15,
    "combinedDuel": 10,
    "forwardPress": 10,
}

# A rate calculated from a handful of events is a fact, but not yet reliable
# evidence of a repeatable skill.  We preserve the raw fact in the detail
# response and attenuate only its *positive percentile contribution* to the
# category score.  The attenuation factor is the exact-context percentile of
# the relevant total attempt sample, so this policy never mixes seasons,
# competitions, or domestic/european populations.
V2_EFFICIENCY_RELIABILITY_POLICY = "attempt-percentile-upper-shrink-v1"
V2_EFFICIENCY_RELIABILITY_ANCHOR = 50


def _v2_per90(total: float | None, record: dict[str, object]) -> float | None:
    minutes = _detail_number(record.get("minutes_played"))
    if total is None or minutes is None or minutes <= 0:
        return None
    return total * 90.0 / minutes


def _v2_rate(record: dict[str, object], key: str) -> float | None:
    rate = _detail_number(record.get(key))
    if rate is None or not 0 < rate <= 100:
        return None
    return rate / 100.0


def _v2_attempts(record: dict[str, object], won_key: str, rate_key: str) -> float | None:
    won = _detail_number(record.get(won_key))
    rate = _v2_rate(record, rate_key)
    return won / rate if won is not None and rate is not None else None


def _v2_losses(record: dict[str, object], won_key: str, rate_key: str) -> float | None:
    attempts = _v2_attempts(record, won_key, rate_key)
    won = _detail_number(record.get(won_key))
    return attempts - won if attempts is not None and won is not None else None


def _v2_aerial_attempts(record: dict[str, object]) -> float | None:
    """Prefer an exact provider attempt total over reverse-calculation."""
    provider_attempts = _detail_number(record.get("aerial_duel_attempts_provider_raw"))
    if provider_attempts is not None and provider_attempts >= 0:
        return provider_attempts
    return _v2_attempts(record, "aerial_duels_won_raw", "aerial_duel_win_rate_raw")


def _v2_ground_attempts(record: dict[str, object]) -> float | None:
    provider_attempts = _detail_number(record.get("ground_duel_attempts_provider_raw"))
    if provider_attempts is not None and provider_attempts >= 0:
        return provider_attempts
    return _v2_attempts(record, "duels_won_raw", "ground_duel_win_rate_raw")


def _v2_zero_attempts(record: dict[str, object], *, attempts_key: str, wins_key: str) -> bool:
    """Only an explicit zero attempt total enables product zero handling."""
    attempts = _detail_number(record.get(attempts_key))
    wins = _detail_number(record.get(wins_key))
    return attempts == 0 and (wins is None or wins == 0)


def _v2_aerial_zero_attempts(record: dict[str, object]) -> bool:
    return _v2_zero_attempts(record, attempts_key="aerial_duel_attempts_provider_raw", wins_key="aerial_duels_won_raw")


def _v2_ground_zero_attempts(record: dict[str, object]) -> bool:
    return _v2_zero_attempts(record, attempts_key="ground_duel_attempts_provider_raw", wins_key="duels_won_raw")


def _v2_aerial_rate(record: dict[str, object]) -> tuple[float | None, str]:
    """Return an observed rate or its wins/attempts-only derivation.

    The second element is API provenance.  A raw wins value by itself never
    supplies a denominator and therefore cannot produce a rate.
    """
    if _v2_aerial_zero_attempts(record):
        return 0.0, "zero_attempts_observed"
    rate = _detail_number(record.get("aerial_duel_win_rate_raw"))
    if rate is not None and 0 <= rate <= 100:
        source = str(record.get("aerial_duel_win_rate_source") or "").strip()
        if source in {"player_season_total", "provider_wins_attempts_derived_rate"}:
            return rate, source
        return rate, "player_season_total"
    wins = _detail_number(record.get("aerial_duels_won_raw"))
    attempts = _detail_number(record.get("aerial_duel_attempts_provider_raw"))
    if wins is None or attempts is None or attempts <= 0 or wins < 0 or wins > attempts:
        return None, "unavailable"
    return wins * 100.0 / attempts, "provider_wins_attempts_derived_rate"


def _v2_aerial_losses(record: dict[str, object]) -> float | None:
    if _v2_aerial_zero_attempts(record):
        return 0.0
    wins = _detail_number(record.get("aerial_duels_won_raw"))
    attempts = _v2_aerial_attempts(record)
    if wins is None or attempts is None or attempts < wins:
        return None
    return attempts - wins


def _v2_ground_losses(record: dict[str, object]) -> float | None:
    if _v2_ground_zero_attempts(record):
        return 0.0
    wins = _detail_number(record.get("duels_won_raw"))
    attempts = _v2_ground_attempts(record)
    if wins is None or attempts is None or attempts < wins:
        return None
    return attempts - wins


def _v2_ground_rate(record: dict[str, object]) -> tuple[float | None, str]:
    if _v2_ground_zero_attempts(record):
        return 0.0, "zero_attempts_observed"
    rate = _detail_number(record.get("ground_duel_win_rate_raw"))
    if rate is not None and 0 <= rate <= 100:
        return rate, "player_season_total"
    return None, "unavailable"


def _v2_ground_wins(record: dict[str, object]) -> float | None:
    return 0.0 if _v2_ground_zero_attempts(record) else _detail_number(record.get("duels_won_raw"))


def _v2_aerial_wins(record: dict[str, object]) -> float | None:
    return 0.0 if _v2_aerial_zero_attempts(record) else _detail_number(record.get("aerial_duels_won_raw"))


def _v2_combined_attempts(record: dict[str, object]) -> float | None:
    ground, aerial = _v2_ground_attempts(record), _v2_aerial_attempts(record)
    return ground + aerial if ground is not None and aerial is not None else None


def _v2_combined_wins(record: dict[str, object]) -> float | None:
    ground, aerial = _v2_ground_wins(record), _v2_aerial_wins(record)
    return ground + aerial if ground is not None and aerial is not None else None


def _v2_combined_losses(record: dict[str, object]) -> float | None:
    ground, aerial = _v2_ground_losses(record), _v2_aerial_losses(record)
    return ground + aerial if ground is not None and aerial is not None else None


def _v2_combined_zero_attempts(record: dict[str, object]) -> bool:
    return _v2_ground_zero_attempts(record) and _v2_aerial_zero_attempts(record)


def _v2_combined_rate(record: dict[str, object]) -> tuple[float | None, str]:
    attempts, wins = _v2_combined_attempts(record), _v2_combined_wins(record)
    if _v2_combined_zero_attempts(record):
        return 0.0, "zero_attempts_observed"
    if attempts is None or wins is None or attempts <= 0 or wins < 0 or wins > attempts:
        return None, "unavailable"
    return wins * 100.0 / attempts, "provider_wins_attempts_derived_rate"


def _v2_margin_per90(record: dict[str, object], wins, losses) -> float | None:
    won, lost = wins(record), losses(record)
    return _v2_per90(won - lost, record) if won is not None and lost is not None else None


def _v2_ground_margin_per90(record: dict[str, object]) -> float | None:
    return _v2_margin_per90(record, _v2_ground_wins, _v2_ground_losses)


def _v2_aerial_margin_per90(record: dict[str, object]) -> float | None:
    return _v2_margin_per90(record, _v2_aerial_wins, _v2_aerial_losses)


def _v2_combined_margin_per90(record: dict[str, object]) -> float | None:
    return _v2_margin_per90(record, _v2_combined_wins, _v2_combined_losses)


def _v2_net_progression_per90(record: dict[str, object]) -> float | None:
    direct = lambda field: _detail_number(record.get(field))
    values = (
        _v2_per90(direct("dribbles_succeeded_raw"), record),
        _v2_per90(direct("fouls_won_raw"), record),
        _v2_per90(direct("penalties_awarded_raw"), record),
        _v2_per90(_v2_ground_wins(record), record),
        _v2_per90(_v2_aerial_wins(record), record),
        _v2_per90(_v2_ground_losses(record), record),
        _v2_per90(_v2_aerial_losses(record), record),
        _v2_per90(_v2_losses(record, "dribbles_succeeded_raw", "dribble_success_rate_raw"), record),
        _v2_per90(direct("dispossessed_raw"), record),
    )
    if any(value is None for value in values):
        return None
    return sum(values[:5]) - sum(values[5:])


def _v2_progression_observation_total(record: dict[str, object]) -> float | None:
    """Return the total event sample supporting net progression.

    It intentionally includes every count that can move the progression
    result, not minutes-normalised values.  Statistical reliability comes
    from observed events; the displayed performance metric remains /90.
    """
    direct = lambda field: _detail_number(record.get(field))
    values = (
        _v2_attempts(record, "dribbles_succeeded_raw", "dribble_success_rate_raw"),
        _v2_ground_attempts(record),
        _v2_aerial_attempts(record),
        direct("fouls_won_raw"),
        direct("penalties_awarded_raw"),
        direct("dispossessed_raw"),
    )
    return sum(values) if all(value is not None and value >= 0 for value in values) else None


def _v2_xgot_minus_xg(record: dict[str, object], *, xgot_key: str, xg_key: str) -> float | None:
    """Return an observed finishing-quality delta without treating a gap as zero."""
    xgot, xg = _detail_number(record.get(xgot_key)), _detail_number(record.get(xg_key))
    return xgot - xg if xgot is not None and xg is not None else None


def _v2_outside_box_xgot_minus_xg(record: dict[str, object]) -> float | None:
    return _v2_xgot_minus_xg(record, xgot_key="out_box_xgot_raw", xg_key="out_box_xg_raw")


def _v2_in_box_xgot_minus_xg(record: dict[str, object]) -> float | None:
    return _v2_xgot_minus_xg(record, xgot_key="in_box_xgot_raw", xg_key="in_box_xg_raw")


def _v2_display_comparison(value: float | None, values: list[float], direction: str) -> DetailV2Comparison:
    if value is None or not values:
        ordered = sorted(values)
        median = None
        if ordered:
            middle = len(ordered) // 2
            median = ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2.0
        return DetailV2Comparison(state="unavailable", median=median, population=len(ordered))
    ordered = sorted(values)
    population = len(ordered)
    rank = 1 + sum(candidate < value for candidate in ordered) if direction == "lower_is_better" else 1 + sum(candidate > value for candidate in ordered)
    score = 99 if population == 1 else round(99 * (population - rank) / (population - 1))
    middle = population // 2
    median = ordered[middle] if population % 2 else (ordered[middle - 1] + ordered[middle]) / 2.0
    return DetailV2Comparison(
        state="available", median=round(float(median), 4), rank=rank,
        population=population, percentileScore=int(score),
    )


def _v2_zero_attempts_floor_comparison(value: float | None, values: list[float]) -> DetailV2Comparison:
    """A zero loss from zero attempts is not an elite low-loss performance."""
    ordinary = _v2_display_comparison(value, values, "lower_is_better")
    if ordinary.state == "unavailable":
        return ordinary
    return ordinary.model_copy(update={
        "state": "zero_attempts_floor", "rank": ordinary.population, "percentileScore": 0,
    })


def _v2_datum(
    value: float | None, unit: str, direction: str, values: list[float], *,
    observed: bool, formula_id: str | None = None, observed_source: str = "player_season_total",
    zero_attempts_floor: bool = False,
) -> DetailV2Datum:
    if value is None:
        return DetailV2Datum(
            value=None, unit=unit, direction=direction, state="unavailable", source="unavailable",
            formulaId=None, formulaVersion=None,
            comparison=_v2_display_comparison(None, values, direction),
        )
    if observed:
        comparison = _v2_zero_attempts_floor_comparison(value, values) if zero_attempts_floor else _v2_display_comparison(value, values, direction)
        observed_formula = {
            "provider_wins_attempts_derived_rate": "provider_wins_attempts_derived_rate",
            "zero_attempts_observed": "zero_attempts_floor",
        }.get(observed_source)
        return DetailV2Datum(
            value=round(value, 4), unit=unit, direction=direction, state="observed",
            source=observed_source,
            formulaId=observed_formula,
            formulaVersion=DETAIL_V2_FORMULA_VERSION if observed_formula else None,
            percentileScore=comparison.percentileScore, comparison=comparison,
        )
    comparison = _v2_zero_attempts_floor_comparison(value, values) if zero_attempts_floor else _v2_display_comparison(value, values, direction)
    return DetailV2Datum(
        value=round(value, 4), unit=unit, direction=direction, state="server_derived",
        source="server_derived", formulaId=formula_id or "derived-v2",
        formulaVersion=DETAIL_V2_FORMULA_VERSION,
        percentileScore=comparison.percentileScore, comparison=comparison,
    )


def _v2_values(records: list[dict[str, object]], evaluator) -> list[float]:
    return [value for record in records if (value := evaluator(record)) is not None]


def _v2_round_half_up(numerator: int, denominator: int) -> int:
    """Deterministic non-negative half-up rounding for official ratings."""
    if denominator <= 0:
        raise ValueError("rating denominator must be positive")
    return (2 * numerator + denominator) // (2 * denominator)


def _v2_overall_rating(categories: dict[str, int]) -> int:
    weighted = sum(V2_OVERALL_WEIGHT_POINTS[category] * categories[category] for category in V2_OVERALL_WEIGHT_POINTS)
    return _v2_round_half_up(weighted, 100)


def _v2_percentile_score_from_sorted(
    value: float | None, ordered_values: list[float], direction: str,
) -> int | None:
    """Rank one component against a pre-sorted static-cohort distribution.

    The board computes every player's score from the same distribution.  Doing
    the sort once per component prevents a cold leaderboard request from
    repeatedly sorting the entire cohort for every player/metric pair.
    """
    if value is None or not ordered_values:
        return None
    population = len(ordered_values)
    if direction == "lower_is_better":
        rank = 1 + bisect_left(ordered_values, value)
    else:
        rank = 1 + population - bisect_right(ordered_values, value)
    return 99 if population == 1 else int(round(99 * (population - rank) / (population - 1)))


def _v2_reliability_adjusted_percentile(score: int | None, attempt_percentile: int | None) -> int | None:
    """Conservatively shrink only an unsupported high efficiency score.

    A score at or below the cohort midpoint is never lifted.  Above the
    midpoint, the distance from 50 is multiplied by the player's total-attempt
    percentile.  This makes a 5/6 aerial rate a real raw fact but prevents it
    from receiving the same category credit as a high-volume 5/6 rate.
    """
    if score is None or attempt_percentile is None:
        return None
    if score <= V2_EFFICIENCY_RELIABILITY_ANCHOR:
        return score
    return _v2_round_half_up(
        V2_EFFICIENCY_RELIABILITY_ANCHOR * 99
        + attempt_percentile * (score - V2_EFFICIENCY_RELIABILITY_ANCHOR),
        99,
    )


def _v2_component_reliability_evaluator(category: str, source_field: str):
    """Map efficiency/loss components to their exact total-event sample."""
    if category == "combinedDuel":
        if source_field in {"combined_duel_win_rate", "combined_duel_margin_per90"}:
            return _v2_combined_attempts
        if source_field == "ground_duel_win_rate":
            return _v2_ground_attempts
        if source_field == "aerial_duel_win_rate":
            return _v2_aerial_attempts
    if category == "dangerZone":
        if source_field == "dribbles_failed_raw":
            return lambda row: _v2_attempts(row, "dribbles_succeeded_raw", "dribble_success_rate_raw")
        if source_field == "net_progression_per90":
            return _v2_progression_observation_total
    return None


def _v2_pair(
    records: list[dict[str, object]], record: dict[str, object], *, identifier: str,
    label: str, unit: str, direction: str, total_evaluator, total_observed: bool,
    total_formula: str | None = None, observed_source: str = "player_season_total",
    zero_attempts_floor: bool = False,
) -> DetailV2Metric:
    total = total_evaluator(record)
    per90 = _v2_per90(total, record)
    per90_evaluator = lambda row: _v2_per90(total_evaluator(row), row)
    return DetailV2Metric(
        id=identifier, label=label,
        total=_v2_datum(total, unit, direction, _v2_values(records, total_evaluator), observed=total_observed, formula_id=total_formula, observed_source=observed_source, zero_attempts_floor=zero_attempts_floor),
        per90=_v2_datum(per90, "per90", direction, _v2_values(records, per90_evaluator), observed=False, formula_id="per90-v2", zero_attempts_floor=zero_attempts_floor),
        pairState="complete" if total is not None and per90 is not None else "partial" if total is not None else "unavailable",
        pairReason=None if total is not None and per90 is not None else "minutes_unavailable_or_nonpositive" if total is not None else "source_unavailable",
    )


def _v2_aerial_attempt_pair(records: list[dict[str, object]], record: dict[str, object]) -> DetailV2Metric:
    """Expose whether aerial attempts were observed or rate-derived."""
    total = _v2_aerial_attempts(record)
    direct_total = _detail_number(record.get("aerial_duel_attempts_provider_raw"))
    per90 = _v2_per90(total, record)
    total_values = _v2_values(records, _v2_aerial_attempts)
    per90_values = _v2_values(records, lambda row: _v2_per90(_v2_aerial_attempts(row), row))
    return DetailV2Metric(
        id="aerialDuelAttempts", label="Aerial duel attempts",
        total=_v2_datum(
            total, "count", "higher_is_better", total_values,
            observed=direct_total is not None,
            formula_id="attempts-from-success-rate-v2",
        ),
        per90=_v2_datum(per90, "per90", "higher_is_better", per90_values, observed=False, formula_id="per90-v2"),
        pairState="complete" if total is not None and per90 is not None else "partial" if total is not None else "unavailable",
        pairReason=None if total is not None and per90 is not None else "minutes_unavailable_or_nonpositive" if total is not None else "source_unavailable",
    )


def _v2_ground_attempt_pair(records: list[dict[str, object]], record: dict[str, object]) -> DetailV2Metric:
    total = _v2_ground_attempts(record)
    direct_total = _detail_number(record.get("ground_duel_attempts_provider_raw"))
    per90 = _v2_per90(total, record)
    total_values = _v2_values(records, _v2_ground_attempts)
    per90_values = _v2_values(records, lambda row: _v2_per90(_v2_ground_attempts(row), row))
    return DetailV2Metric(
        id="groundDuelAttempts", label="Ground duel attempts",
        total=_v2_datum(total, "count", "higher_is_better", total_values, observed=direct_total is not None, formula_id="attempts-from-success-rate-v2"),
        per90=_v2_datum(per90, "per90", "higher_is_better", per90_values, observed=False, formula_id="per90-v2"),
        pairState="complete" if total is not None and per90 is not None else "partial" if total is not None else "unavailable",
        pairReason=None if total is not None and per90 is not None else "minutes_unavailable_or_nonpositive" if total is not None else "source_unavailable",
    )


def _v2_duel_wins_pair(
    records: list[dict[str, object]], record: dict[str, object], *, identifier: str,
    label: str, evaluator, zero_attempts,
) -> DetailV2Metric:
    total = evaluator(record)
    per90 = _v2_per90(total, record)
    total_values = _v2_values(records, evaluator)
    per90_values = _v2_values(records, lambda row: _v2_per90(evaluator(row), row))
    zero = zero_attempts(record)
    return DetailV2Metric(
        id=identifier, label=label,
        total=_v2_datum(total, "count", "higher_is_better", total_values, observed=True, observed_source="zero_attempts_observed" if zero else "player_season_total"),
        per90=_v2_datum(per90, "per90", "higher_is_better", per90_values, observed=False, formula_id="per90-v2"),
        pairState="complete" if total is not None and per90 is not None else "partial" if total is not None else "unavailable",
        pairReason=None if total is not None and per90 is not None else "minutes_unavailable_or_nonpositive" if total is not None else "source_unavailable",
    )


def _v2_duel_losses_pair(
    records: list[dict[str, object]], record: dict[str, object], *, identifier: str,
    label: str, evaluator, zero_attempts,
) -> DetailV2Metric:
    total = evaluator(record)
    per90 = _v2_per90(total, record)
    total_values = _v2_values(records, evaluator)
    per90_values = _v2_values(records, lambda row: _v2_per90(evaluator(row), row))
    zero = zero_attempts(record)
    return DetailV2Metric(
        id=identifier, label=label,
        total=_v2_datum(total, "count", "lower_is_better", total_values, observed=zero, formula_id="losses-from-wins-attempts-v2", observed_source="zero_attempts_observed" if zero else "player_season_total", zero_attempts_floor=zero),
        per90=_v2_datum(per90, "per90", "lower_is_better", per90_values, observed=False, formula_id="zero_attempts_floor" if zero else "per90-v2", zero_attempts_floor=zero),
        pairState="complete" if total is not None and per90 is not None else "partial" if total is not None else "unavailable",
        pairReason=None if total is not None and per90 is not None else "minutes_unavailable_or_nonpositive" if total is not None else "source_unavailable",
    )


def _v2_press_pair(
    records: list[dict[str, object]], record: dict[str, object], *, identifier: str,
    label: str, total_key: str, per90_key: str, source_key: str,
) -> DetailV2Metric:
    """Keep the v1 press total/per90 source invariant explicit in v2."""
    source = _optional_source(record.get(source_key))
    total = _detail_number(record.get(total_key))
    per90 = _detail_number(record.get(per90_key))
    total_values = _v2_values(records, lambda row: _detail_number(row.get(total_key)))
    per90_values = _v2_values(records, lambda row: _detail_number(row.get(per90_key)))
    if source is None or total is None or per90 is None:
        return DetailV2Metric(
            id=identifier, label=label,
            total=_v2_datum(None, "count", "higher_is_better", total_values, observed=True),
            per90=_v2_datum(None, "per90", "higher_is_better", per90_values, observed=True),
            pairState="unavailable",
            pairReason="source_unavailable",
        )
    if source == "league_per90_fallback":
        total_datum = _v2_datum(total, "count", "higher_is_better", total_values, observed=False, formula_id="league-per90-total-v2")
        per90_datum = _v2_datum(per90, "per90", "higher_is_better", per90_values, observed=True, observed_source="league_per90_fallback")
    else:
        total_datum = _v2_datum(total, "count", "higher_is_better", total_values, observed=True, observed_source="player_season_total")
        per90_datum = _v2_datum(per90, "per90", "higher_is_better", per90_values, observed=True, observed_source="player_season_total")
    return DetailV2Metric(id=identifier, label=label, total=total_datum, per90=per90_datum, pairState="complete", pairReason=None)


def _v2_scalar(
    records: list[dict[str, object]], record: dict[str, object], *, identifier: str,
    label: str, unit: str, direction: str, evaluator, observed: bool,
    formula_id: str | None = None, observed_source: str = "player_season_total",
    zero_attempts_floor: bool = False,
) -> DetailV2Metric:
    value = evaluator(record)
    return DetailV2Metric(
        id=identifier, label=label,
        value=_v2_datum(
            value, unit, direction, _v2_values(records, evaluator), observed=observed,
            formula_id=formula_id, observed_source=observed_source,
            zero_attempts_floor=zero_attempts_floor,
        ),
        pairState="scalar",
        pairReason=None,
    )


def _v2_component_specs():
    direct = lambda field: lambda row: _detail_number(row.get(field))
    return {
        "outsideShot": (
            ("out_box_shots_raw", "higher_is_better", lambda row: _v2_per90(direct("out_box_shots_raw")(row), row), lambda row: False),
            ("out_box_xg_raw", "higher_is_better", lambda row: _v2_per90(direct("out_box_xg_raw")(row), row), lambda row: False),
            ("out_box_xgot_raw", "higher_is_better", lambda row: _v2_per90(direct("out_box_xgot_raw")(row), row), lambda row: False),
            ("out_box_xgot_minus_xg_per90", "higher_is_better", lambda row: _v2_per90(_v2_outside_box_xgot_minus_xg(row), row), lambda row: False),
        ),
        "boxThreat": (
            ("in_box_shots_raw", "higher_is_better", lambda row: _v2_per90(direct("in_box_shots_raw")(row), row), lambda row: False),
            ("in_box_xg_raw", "higher_is_better", lambda row: _v2_per90(direct("in_box_xg_raw")(row), row), lambda row: False),
            ("in_box_xgot_raw", "higher_is_better", lambda row: _v2_per90(direct("in_box_xgot_raw")(row), row), lambda row: False),
            ("in_box_xgot_minus_xg_per90", "higher_is_better", lambda row: _v2_per90(_v2_in_box_xgot_minus_xg(row), row), lambda row: False),
        ),
        "dangerZone": (
            ("dribble_attempts_raw", "higher_is_better", lambda row: _v2_per90(_v2_attempts(row, "dribbles_succeeded_raw", "dribble_success_rate_raw"), row), lambda row: False),
            ("dribbles_succeeded_raw", "higher_is_better", lambda row: _v2_per90(direct("dribbles_succeeded_raw")(row), row), lambda row: False),
            ("dribbles_failed_raw", "lower_is_better", lambda row: _v2_per90(_v2_losses(row, "dribbles_succeeded_raw", "dribble_success_rate_raw"), row), lambda row: False),
            ("net_progression_per90", "higher_is_better", _v2_net_progression_per90, lambda row: False),
        ),
        "combinedDuel": (
            ("combined_duel_attempts_per90", "higher_is_better", lambda row: _v2_per90(_v2_combined_attempts(row), row), lambda row: False),
            ("combined_duel_win_rate", "higher_is_better", lambda row: _v2_combined_rate(row)[0], _v2_combined_zero_attempts),
            ("combined_duel_margin_per90", "higher_is_better", _v2_combined_margin_per90, _v2_combined_zero_attempts),
            ("ground_duel_win_rate", "higher_is_better", lambda row: _v2_ground_rate(row)[0], _v2_ground_zero_attempts),
            ("aerial_duel_win_rate", "higher_is_better", lambda row: _v2_aerial_rate(row)[0], _v2_aerial_zero_attempts),
        ),
        "spaceControl": (
            ("cca_area_pct", "higher_is_better", direct("cca_area_pct"), lambda row: False),
            ("danger_zone_density", "higher_is_better", direct("danger_zone_density"), lambda row: False),
        ),
        "forwardPress": (
            ("recoveries_per90", "higher_is_better", direct("recoveries_per90"), lambda row: False),
            ("final_third_possessions_won_per90", "higher_is_better", direct("final_third_possessions_won_per90"), lambda row: False),
        ),
    }


def _v2_rating_snapshot(
    records: list[dict[str, object]], season: str, mode: str, scope: int, competition: str,
) -> tuple[str, dict[int, dict[str, object]]]:
    """Calculate every visible v2 rating once from one raw static frame."""
    specs = _v2_component_specs()
    # ``_v2_display_comparison`` deliberately builds rich comparison objects
    # for one detail response.  The board needs the same strict rank rule for
    # every record, so materialise each component distribution exactly once.
    # This keeps the first static-cohort request bounded instead of performing
    # O(players * components) full sorts.
    distributions = {
        (category, source_field): sorted(_v2_values(records, evaluator))
        for category, components in specs.items()
        for source_field, _direction, evaluator, _zero_attempt_floor in components
    }
    reliability_evaluators = {
        (category, source_field): evaluator
        for category, components in specs.items()
        for source_field, _direction, _component_evaluator, _zero_attempt_floor in components
        if (evaluator := _v2_component_reliability_evaluator(category, source_field)) is not None
    }
    reliability_distributions = {
        key: sorted(_v2_values(records, evaluator))
        for key, evaluator in reliability_evaluators.items()
    }
    ratings: dict[int, dict[str, object]] = {}
    for record in records:
        try:
            player_id = _source_player_id(record.get("player_id"))
        except (TypeError, ValueError):
            continue
        categories: dict[str, int] = {}
        missing: dict[str, list[str]] = {}
        for category, components in specs.items():
            scores: list[int] = []
            absent: list[str] = []
            for source_field, direction, evaluator, zero_attempt_floor in components:
                value = evaluator(record)
                if zero_attempt_floor(record):
                    scores.append(0)
                    continue
                score = _v2_percentile_score_from_sorted(
                    value, distributions[(category, source_field)], direction,
                )
                reliability_evaluator = reliability_evaluators.get((category, source_field))
                if score is not None and reliability_evaluator is not None:
                    attempt_percentile = _v2_percentile_score_from_sorted(
                        reliability_evaluator(record),
                        reliability_distributions[(category, source_field)],
                        "higher_is_better",
                    )
                    score = _v2_reliability_adjusted_percentile(score, attempt_percentile)
                if score is None:
                    scores.append(V2_MISSING_COMPONENT_SCORE)
                    absent.append(source_field)
                else:
                    scores.append(score)
            categories[category] = _v2_round_half_up(sum(scores), len(scores))
            missing[category] = absent
        overall = _v2_overall_rating(categories)
        ratings[player_id] = {"categories": categories, "missing": missing, "overall": overall}
    for category in V2_CATEGORY_ORDER:
        values = sorted(float(item["categories"][category]) for item in ratings.values())
        for value in ratings.values():
            category_value = float(value["categories"][category])
            rank = 1 + len(values) - bisect_right(values, category_value)
            middle = len(values) // 2
            median = values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2.0
            score = 99 if len(values) == 1 else int(round(99 * (len(values) - rank) / (len(values) - 1)))
            value.setdefault("categoryComparisons", {})[category] = DetailV2Comparison(
                state="available", median=round(float(median), 4), rank=rank,
                population=len(values), percentileScore=score,
            )
    overall_values = sorted(float(item["overall"]) for item in ratings.values())
    for value in ratings.values():
        overall_value = float(value["overall"])
        rank = 1 + len(overall_values) - bisect_right(overall_values, overall_value)
        middle = len(overall_values) // 2
        median = overall_values[middle] if len(overall_values) % 2 else (overall_values[middle - 1] + overall_values[middle]) / 2.0
        score = 99 if len(overall_values) == 1 else int(round(99 * (len(overall_values) - rank) / (len(overall_values) - 1)))
        comparison = DetailV2Comparison(
            state="available", median=round(float(median), 4), rank=rank,
            population=len(overall_values), percentileScore=score,
        )
        value["overallComparison"] = comparison
        value["rank"] = comparison.rank
    material = [
        {"playerId": player_id, "rating": ratings[player_id]}
        for player_id in sorted(ratings)
    ]
    # The detail endpoint also exposes tooltip-only facts (for example goals
    # minus xGOT and every net-progression term), so snapshot identity covers
    # the full v2 raw input set rather than only the six displayed ratings.
    snapshot_fields = (
        "minutes_played", "out_box_shots_raw", "out_box_xg_raw", "out_box_xgot_raw",
        "in_box_shots_raw", "in_box_xg_raw", "in_box_xgot_raw",
        "dribbles_succeeded_raw", "dribble_success_rate_raw", "duels_won_raw",
        "ground_duel_attempts_provider_raw", "ground_duel_win_rate_raw", "aerial_duels_won_raw", "aerial_duel_attempts_provider_raw",
        "aerial_duel_win_rate_raw", "aerial_duel_win_rate_source",
        "cca_area_pct", "danger_zone_density", "recoveries", "recoveries_per90",
        "recoveries_source", "final_third_possessions_won",
        "final_third_possessions_won_per90", "final_third_possessions_won_source",
        "goals_raw", "xgot_raw", "fouls_won_raw", "penalties_awarded_raw", "dispossessed_raw",
    )
    frame_material = [
        {"playerId": _source_player_id(record.get("player_id")), **{field: record.get(field) for field in snapshot_fields}}
        for record in sorted(records, key=lambda item: _source_player_id(item.get("player_id")))
    ]
    digest = hashlib.sha256(json.dumps(
        {"season": season, "mode": mode, "scope": scope, "competition": competition,
         "ratingVersion": DETAIL_V2_FORMULA_VERSION,
         "efficiencyReliabilityPolicy": V2_EFFICIENCY_RELIABILITY_POLICY,
         "efficiencyReliabilityAnchor": V2_EFFICIENCY_RELIABILITY_ANCHOR,
         "ratings": material, "frame": frame_material},
        sort_keys=True, separators=(",", ":"), default=str,
    ).encode("utf-8")).hexdigest()[:16]
    return f"stat-pairs-v2:{digest}", ratings


def _v2_context(player_id: int, season: str, mode: str, scope: int, competition: str) -> DuelPressRequestContext:
    return DuelPressRequestContext(
        playerId=player_id, season=season, mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
    )


def _v2_player(
    player: DuelPressPlayerResponse, rating: dict[str, object], record: dict[str, object],
    records: list[dict[str, object]], cohort_population: int,
) -> DuelPressV2LeaderboardPlayer:
    # The leaderboard and profile resource expose the six authoritative card
    # scores only.  Rebuilding every raw pair for all 50 rows belongs to the
    # dedicated detail-metrics endpoint and made first-page navigation
    # needlessly expensive.
    category_models = {
        category: DuelPressV2BoardCategory(
            percentileScore=int(rating["categories"][category]),
            scoreState="imputed" if rating["missing"][category] else "observed",
            imputedComponents=list(rating["missing"][category]),
        )
        for category in V2_CATEGORY_ORDER
    }
    return DuelPressV2LeaderboardPlayer(
        id=player.id, rank=int(rating["rank"]),
        overallRating={
            "rawValue": rating["overall"],
            "percentileScore": rating["overallComparison"].percentileScore,
            "state": "imputed" if any(rating["missing"].values()) else "observed",
            "comparison": rating["overallComparison"],
        },
        name=player.name, position=player.position, archetype=player.archetype,
        age=player.age, minutes=player.minutes, tier=tier_from_rank(int(rating["rank"]), cohort_population),
        face=player.face, nation=player.nation, club=player.club, league=player.league,
        stats=DuelPressV2RatingStats(**category_models),
    )


def _v2_category_from_rating(category: str, rating: dict[str, object], comparison: DetailV2Comparison, groups: list[DetailV2Group]) -> DuelPressDetailV2Category:
    missing = rating["missing"][category]
    return DuelPressDetailV2Category(
        id=category, label=category, percentileScore=rating["categories"][category],
        scoreState="imputed" if missing else "observed", imputedComponents=missing,
        comparison=comparison, groups=groups,
    )


def _v2_category(record: dict[str, object], records: list[dict[str, object]], category: str, rating: dict[str, object]) -> DuelPressDetailV2Category:
    direct = lambda field: lambda row: _detail_number(row.get(field))
    groups = {
        "outsideShot": [DetailV2Group(id="outsideBoxShooting", label="Outside-box shooting", kind="count_rate_pair", metrics=[
            _v2_pair(records, record, identifier="outsideBoxShotAttempts", label="Outside-box shot attempts", unit="count", direction="higher_is_better", total_evaluator=direct("out_box_shots_raw"), total_observed=True),
            _v2_pair(records, record, identifier="outsideBoxXg", label="Outside-box xG", unit="goals", direction="higher_is_better", total_evaluator=direct("out_box_xg_raw"), total_observed=True),
            _v2_pair(records, record, identifier="outsideBoxXgot", label="Outside-box xGOT", unit="goals", direction="higher_is_better", total_evaluator=direct("out_box_xgot_raw"), total_observed=True),
            _v2_pair(records, record, identifier="outsideBoxXgotMinusXg", label="Outside-box xGOT minus xG", unit="goals", direction="higher_is_better", total_evaluator=_v2_outside_box_xgot_minus_xg, total_observed=False, total_formula="xgot-minus-xg-v1"),
        ])],
        "boxThreat": [DetailV2Group(id="inBoxShooting", label="In-box shooting", kind="count_rate_pair", metrics=[
            _v2_pair(records, record, identifier="inBoxShotAttempts", label="In-box shot attempts", unit="count", direction="higher_is_better", total_evaluator=direct("in_box_shots_raw"), total_observed=True),
            _v2_pair(records, record, identifier="inBoxXg", label="In-box xG", unit="goals", direction="higher_is_better", total_evaluator=direct("in_box_xg_raw"), total_observed=True),
            _v2_pair(records, record, identifier="inBoxXgot", label="In-box xGOT", unit="goals", direction="higher_is_better", total_evaluator=direct("in_box_xgot_raw"), total_observed=True),
            _v2_pair(records, record, identifier="inBoxXgotMinusXg", label="In-box xGOT minus xG", unit="goals", direction="higher_is_better", total_evaluator=_v2_in_box_xgot_minus_xg, total_observed=False, total_formula="xgot-minus-xg-v1"),
        ])],
        "dangerZone": [DetailV2Group(id="onBallDribbles", label="On-ball dribbles", kind="count_rate_pair", metrics=[
            _v2_pair(records, record, identifier="dribbleAttempts", label="Dribble attempts", unit="count", direction="higher_is_better", total_evaluator=lambda row: _v2_attempts(row, "dribbles_succeeded_raw", "dribble_success_rate_raw"), total_observed=False, total_formula="attempts-from-success-rate-v2"),
            _v2_pair(records, record, identifier="successfulDribbles", label="Successful dribbles", unit="count", direction="higher_is_better", total_evaluator=direct("dribbles_succeeded_raw"), total_observed=True),
            _v2_pair(records, record, identifier="failedDribbles", label="Failed dribbles", unit="count", direction="lower_is_better", total_evaluator=lambda row: _v2_losses(row, "dribbles_succeeded_raw", "dribble_success_rate_raw"), total_observed=False, total_formula="losses-from-success-rate-v2"),
            _v2_scalar(records, record, identifier="netProgressionPer90", label="Net progression /90", unit="per90", direction="higher_is_better", evaluator=_v2_net_progression_per90, observed=False, formula_id="net-progression-v1"),
        ])],
        "combinedDuel": [
            DetailV2Group(id="combinedDuelVolume", label="Combined duel volume", kind="count_rate_pair", metrics=[
                _v2_pair(records, record, identifier="combinedDuelAttempts", label="Combined duel attempts", unit="count", direction="higher_is_better", total_evaluator=_v2_combined_attempts, total_observed=False, total_formula="combined-duel-attempts-v2"),
                _v2_pair(records, record, identifier="combinedDuelWins", label="Combined duel wins", unit="count", direction="higher_is_better", total_evaluator=_v2_combined_wins, total_observed=False, total_formula="combined-duel-wins-v2"),
                _v2_pair(records, record, identifier="combinedDuelLosses", label="Combined duel losses", unit="count", direction="lower_is_better", total_evaluator=_v2_combined_losses, total_observed=False, total_formula="combined-duel-losses-v2", zero_attempts_floor=_v2_combined_zero_attempts(record)),
                _v2_scalar(records, record, identifier="combinedDuelWinRate", label="Combined duel success rate", unit="percent", direction="higher_is_better", evaluator=lambda row: _v2_combined_rate(row)[0], observed=True, observed_source=_v2_combined_rate(record)[1], zero_attempts_floor=_v2_combined_zero_attempts(record)),
                _v2_scalar(records, record, identifier="combinedDuelSuccessMarginPer90", label="Combined duel success margin /90", unit="per90", direction="higher_is_better", evaluator=_v2_combined_margin_per90, observed=False, formula_id="combined-duel-margin-v2", zero_attempts_floor=_v2_combined_zero_attempts(record)),
            ]),
            DetailV2Group(id="groundDuels", label="Ground duels", kind="duel_split", metrics=[
                _v2_ground_attempt_pair(records, record),
                _v2_duel_wins_pair(records, record, identifier="groundDuelWins", label="Ground duel wins", evaluator=_v2_ground_wins, zero_attempts=_v2_ground_zero_attempts),
                _v2_duel_losses_pair(records, record, identifier="groundDuelLosses", label="Ground duel losses", evaluator=_v2_ground_losses, zero_attempts=_v2_ground_zero_attempts),
                _v2_scalar(records, record, identifier="groundDuelWinRate", label="Ground duel success rate", unit="percent", direction="higher_is_better", evaluator=lambda row: _v2_ground_rate(row)[0], observed=True, observed_source=_v2_ground_rate(record)[1], zero_attempts_floor=_v2_ground_zero_attempts(record)),
                _v2_scalar(records, record, identifier="groundDuelSuccessMarginPer90", label="Ground duel success margin /90", unit="per90", direction="higher_is_better", evaluator=_v2_ground_margin_per90, observed=False, formula_id="ground-duel-margin-v2", zero_attempts_floor=_v2_ground_zero_attempts(record)),
            ]),
            DetailV2Group(id="aerialDuels", label="Aerial duels", kind="duel_split", metrics=[
                _v2_aerial_attempt_pair(records, record),
                _v2_duel_wins_pair(records, record, identifier="aerialDuelWins", label="Aerial duel wins", evaluator=_v2_aerial_wins, zero_attempts=_v2_aerial_zero_attempts),
                _v2_duel_losses_pair(records, record, identifier="aerialDuelLosses", label="Aerial duel losses", evaluator=_v2_aerial_losses, zero_attempts=_v2_aerial_zero_attempts),
                _v2_scalar(
                    records, record, identifier="aerialDuelWinRate", label="Aerial duel success rate",
                    unit="percent", direction="higher_is_better",
                    evaluator=lambda row: _v2_aerial_rate(row)[0], observed=True,
                    observed_source=_v2_aerial_rate(record)[1], zero_attempts_floor=_v2_aerial_zero_attempts(record),
                ),
                _v2_scalar(records, record, identifier="aerialDuelSuccessMarginPer90", label="Aerial duel success margin /90", unit="per90", direction="higher_is_better", evaluator=_v2_aerial_margin_per90, observed=False, formula_id="aerial-duel-margin-v2", zero_attempts_floor=_v2_aerial_zero_attempts(record)),
            ]),
        ],
        "spaceControl": [DetailV2Group(id="spaceControl", label="Space control", kind="spatial", metrics=[
            _v2_scalar(records, record, identifier="ccaAreaPct", label="CCA area", unit="percent", direction="higher_is_better", evaluator=direct("cca_area_pct"), observed=True, observed_source="tactical_ratio_static"),
            _v2_scalar(records, record, identifier="dangerZoneDensity", label="Danger-zone density", unit="percent", direction="higher_is_better", evaluator=direct("danger_zone_density"), observed=True, observed_source="tactical_ratio_static"),
        ])],
        "forwardPress": [DetailV2Group(id="forwardPressing", label="Forward pressing", kind="pressing", metrics=[
            _v2_press_pair(records, record, identifier="recoveries", label="Recoveries", total_key="recoveries", per90_key="recoveries_per90", source_key="recoveries_source"),
            _v2_press_pair(records, record, identifier="finalThirdPossessionsWon", label="Final-third possessions won", total_key="final_third_possessions_won", per90_key="final_third_possessions_won_per90", source_key="final_third_possessions_won_source"),
        ])],
    }[category]
    missing = rating["missing"][category]
    return _v2_category_from_rating(category, rating, rating["categoryComparisons"][category], groups)


def _v2_context_indicators(record: dict[str, object], records: list[dict[str, object]]) -> list[DuelPressDetailV2ContextIndicator]:
    direct = lambda field: lambda row: _detail_number(row.get(field))
    successful = lambda row: _v2_per90(direct("dribbles_succeeded_raw")(row), row)
    failed = lambda row: _v2_per90(_v2_losses(row, "dribbles_succeeded_raw", "dribble_success_rate_raw"), row)
    ground_won = lambda row: _v2_per90(_v2_ground_wins(row), row)
    ground_lost = lambda row: _v2_per90(_v2_ground_losses(row), row)
    aerial_won = lambda row: _v2_per90(_v2_aerial_wins(row), row)
    aerial_lost = lambda row: _v2_per90(_v2_aerial_losses(row), row)
    fouls = lambda row: _v2_per90(direct("fouls_won_raw")(row), row)
    penalties = lambda row: _v2_per90(direct("penalties_awarded_raw")(row), row)
    dispossessed = lambda row: _v2_per90(direct("dispossessed_raw")(row), row)
    goals_minus_xgot = lambda row: (direct("goals_raw")(row) - direct("xgot_raw")(row) if direct("goals_raw")(row) is not None and direct("xgot_raw")(row) is not None else None)
    net_facts = [
        _v2_scalar(records, record, identifier="successfulDribblesPer90", label="Successful dribbles /90", unit="per90", direction="higher_is_better", evaluator=successful, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="foulsWonPer90", label="Fouls won /90", unit="per90", direction="higher_is_better", evaluator=fouls, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="penaltiesAwardedPer90", label="Penalties awarded /90", unit="per90", direction="higher_is_better", evaluator=penalties, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="groundDuelWinsPer90", label="Ground duel wins /90", unit="per90", direction="higher_is_better", evaluator=ground_won, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="groundDuelLossesPer90", label="Ground duel losses /90", unit="per90", direction="lower_is_better", evaluator=ground_lost, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="aerialDuelWinsPer90", label="Aerial duel wins /90", unit="per90", direction="higher_is_better", evaluator=aerial_won, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="aerialDuelLossesPer90", label="Aerial duel losses /90", unit="per90", direction="lower_is_better", evaluator=aerial_lost, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="failedDribblesPer90", label="Failed dribbles /90", unit="per90", direction="lower_is_better", evaluator=failed, observed=False, formula_id="per90-v2"),
        _v2_scalar(records, record, identifier="dispossessedPer90", label="Dispossessed /90", unit="per90", direction="lower_is_better", evaluator=dispossessed, observed=False, formula_id="per90-v2"),
    ]
    return [
        DuelPressDetailV2ContextIndicator(id="netProgressionPer90", label="Net progression /90", metric=_v2_scalar(records, record, identifier="netProgressionPer90", label="Net progression /90", unit="per90", direction="higher_is_better", evaluator=_v2_net_progression_per90, observed=False, formula_id="net-progression-v1"), tooltipFacts=net_facts),
        DuelPressDetailV2ContextIndicator(id="goalsMinusXgot", label="Goals minus xGOT", metric=_v2_scalar(records, record, identifier="goalsMinusXgot", label="Goals minus xGOT", unit="goals", direction="higher_is_better", evaluator=goals_minus_xgot, observed=False, formula_id="goals-minus-xgot-v1"), tooltipFacts=[
            _v2_scalar(records, record, identifier="goals", label="Goals", unit="goals", direction="higher_is_better", evaluator=direct("goals_raw"), observed=True),
            _v2_scalar(records, record, identifier="xgot", label="xGOT", unit="goals", direction="higher_is_better", evaluator=direct("xgot_raw"), observed=True),
        ]),
    ]


@lru_cache(maxsize=16)
def _v2_frame_cached(
    season: str, mode: str, scope: int, competition: str, dataset_revision: str,
) -> tuple[tuple[dict[str, object], ...], tuple[DuelPressPlayerResponse, ...], str, dict[int, dict[str, object]]]:
    """Bound repeated page/detail work to one immutable static dataset revision."""
    players = build_duel_press_players(season, mode, scope, competition)
    records = _detail_frame_records(season, mode, scope, competition)
    snapshot_id, ratings = _v2_rating_snapshot(records, season, mode, scope, competition)
    return tuple(records), players, snapshot_id, ratings


def _v2_frame(season: str, mode: str, scope: int, competition: str) -> tuple[list[dict[str, object]], tuple[DuelPressPlayerResponse, ...], str, dict[int, dict[str, object]]]:
    revision = dataset_generated_at().isoformat()
    records, players, snapshot_id, ratings = _v2_frame_cached(season, mode, scope, competition, revision)
    return list(records), players, snapshot_id, ratings


def find_duel_press_v2_player(player_id: int, season: str, mode: str, scope: int, competition: str) -> DuelPressV2PlayerEnvelope | None:
    records, players, snapshot_id, ratings = _v2_frame(season, mode, scope, competition)
    player = next((item for item in players if item.id == player_id), None)
    record = next((item for item in records if _source_player_id(item.get("player_id")) == player_id), None)
    rating = ratings.get(player_id)
    if player is None or record is None or rating is None:
        return None
    return DuelPressV2PlayerEnvelope(
        ratingSnapshotId=snapshot_id, context=_v2_context(player_id, season, mode, scope, competition),
        cohortPopulation=len(ratings), data=_v2_player(player, rating, record, records, len(ratings)),
    )


def find_duel_press_detail_readouts_v2(player_id: int, season: str, mode: str, scope: int, competition: str) -> DuelPressDetailReadoutV2Envelope | None:
    records, players, snapshot_id, ratings = _v2_frame(season, mode, scope, competition)
    player = next((item for item in players if item.id == player_id), None)
    record = next((item for item in records if _source_player_id(item.get("player_id")) == player_id), None)
    rating = ratings.get(player_id)
    if player is None or record is None or rating is None:
        return None
    return DuelPressDetailReadoutV2Envelope(
        ratingSnapshotId=snapshot_id, context=_v2_context(player_id, season, mode, scope, competition),
        cohortPopulation=len(ratings),
        player=DuelPressDetailPlayerIdentity(id=player.id, name=player.name, position=player.position, club=player.club, league=player.league),
        categories=[_v2_category(record, records, category, rating) for category in V2_CATEGORY_ORDER],
        contextIndicators=_v2_context_indicators(record, records),
    )


def duel_press_v2_leaderboard_envelope(
    season: str, mode: str, scope: int, competition: str, *, page: int, page_size: int,
    role: str | None, position: str | None, age_band: AgeBand, minutes_band: MinutesBand,
    query: str | None, sort: DuelPressLeaderboardSort, order: SortOrder,
) -> DuelPressV2LeaderboardPageEnvelope:
    if page_size != 50:
        raise ValueError("duel-press-v2 requires pageSize=50")
    records, players, snapshot_id, ratings = _v2_frame(season, mode, scope, competition)
    applied = DuelPressAppliedFilters(role=role, position=(position.strip() or None) if position else None, q=(query.strip() or None) if query else None, ageBand=age_band, minutesBand=minutes_band, sort=sort, order=order)
    rows = [(player, ratings[player.id]) for player in players if player.id in ratings]
    if applied.role:
        rows = [row for row in rows if row[0].archetype == applied.role]
    if applied.position:
        rows = [row for row in rows if row[0].position == applied.position]
    rows = [row for row in rows if matches_age_band(row[0].age, applied.ageBand) and matches_minutes_band(row[0].minutes, applied.minutesBand)]
    if applied.q:
        needle = canonical_search_key(applied.q)
        rows = [row for row in rows if needle in canonical_search_key(f"{row[0].name} {row[0].club.name} {row[0].league.name}")]
    sort_value = {
        "rank": lambda row: int(row[1]["rank"]), "score": lambda row: int(row[1]["overall"]), "name": lambda row: row[0].name.casefold(),
        "minutes": lambda row: row[0].minutes, "age": lambda row: row[0].age if row[0].age is not None else 10_000,
        **{category: lambda row, category=category: int(row[1]["categories"][category]) for category in V2_CATEGORY_ORDER},
    }[applied.sort]
    def compare_rows(left, right) -> int:
        left_value, right_value = sort_value(left), sort_value(right)
        if left_value != right_value:
            if left_value < right_value:
                return -1 if applied.order == "asc" else 1
            return 1 if applied.order == "asc" else -1
        # Tie-breakers never reverse with the requested sort direction.
        left_tie, right_tie = (int(left[1]["rank"]), left[0].id), (int(right[1]["rank"]), right[0].id)
        return -1 if left_tie < right_tie else 1 if left_tie > right_tie else 0
    rows.sort(key=cmp_to_key(compare_rows))
    population = len(rows)
    total_pages = (population + page_size - 1) // page_size
    selected = rows[(page - 1) * page_size:page * page_size] if page <= max(total_pages, 1) else []
    return DuelPressV2LeaderboardPageEnvelope(
        ratingSnapshotId=snapshot_id, context=DuelPressV2CohortContext(season=season, mode=mode, scope=scope if mode == "league" else None, competition=competition if mode == "europe" else None), cohortPopulation=len(ratings),
        data=[_v2_player(player, rating, next(record for record in records if _source_player_id(record.get("player_id")) == player.id), records, len(ratings)) for player, rating in selected],
        meta=DuelPressV2LeaderboardMeta(season=season, mode=mode, scope=scope if mode == "league" else None, competition=competition if mode == "europe" else None, population=population, returned=len(selected), page=page, pageSize=page_size, totalItems=population, totalPages=total_pages, hasNextPage=page < total_pages, applied=applied, generatedAt=dataset_generated_at()),
    )


DUEL_PRESS_METRIC_FIELDS = (
    "outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl",
    "forwardPress",
)


@lru_cache(maxsize=16)
def _duel_press_metric_rank_maps(
    season: str, mode: str, scope: int, competition: str,
) -> dict[int, DuelPressMetricRanks] | None:
    """Rank every duel-press sector once for one unfiltered context.

    The companion endpoint batches entries by this key before looking up a
    player.  This deliberately reads no page, search, role, age, or minutes
    predicate: rank is always relative to the complete eligible cohort.
    """
    if season not in supported_seasons():
        return None
    rows = build_duel_press_players(season, mode, scope, competition)
    if not rows:
        return None

    per_metric: dict[str, dict[int, float]] = {
        field: {
            player.id: float(getattr(player.stats, field))
            for player in rows
            if getattr(player.stats, field, None) is not None
        }
        for field in DUEL_PRESS_METRIC_FIELDS
    }
    result: dict[int, DuelPressMetricRanks] = {}
    for player in rows:
        values: dict[str, MetricRankValue] = {}
        for field, population_values in per_metric.items():
            score = population_values.get(player.id)
            population = len(population_values)
            rank = (
                1 + sum(candidate > score for candidate in population_values.values())
                if score is not None else None
            )
            values[field] = MetricRankValue(rank=rank, population=population)
        result[player.id] = DuelPressMetricRanks(**values)
    return result


def resolve_metric_rank_entries(
    entries: list[MetricRankRequestEntry],
) -> list[MetricRankResult]:
    """Resolve metric ranks in input order while loading each cohort once."""
    grouped: dict[tuple[str, str, int, str], list[MetricRankRequestEntry]] = {}
    for entry in entries:
        context = entry.context
        key = (
            context.season, context.mode, context.scope or 8,
            context.competition,
        )
        grouped.setdefault(key, []).append(entry)

    rank_maps = {
        key: _duel_press_metric_rank_maps(*key)
        for key in grouped
    }
    results: list[MetricRankResult] = []
    for entry in entries:
        context: MetricRankContext = entry.context
        key = (
            context.season, context.mode, context.scope or 8,
            context.competition,
        )
        ranks = rank_maps[key]
        if ranks is None:
            status = "invalid_context"
            metrics = None
        else:
            metrics = ranks.get(entry.player.playerId)
            status = "resolved" if metrics is not None else "unavailable"
        results.append(MetricRankResult(
            key=entry.key,
            player=entry.player,
            metricTaxonomyVersion=entry.metricTaxonomyVersion,
            context=context,
            status=status,
            metrics=metrics,
        ))
    return results


VOLUME_RADAR_AXES = (
    ("outsideShot", "Outside-box shot volume", "outside_box_shots_attempts_top_percent", "out_box_shots", "outside_box_shots_attempts_rank"),
    ("boxThreat", "Box shot volume", "box_shots_volume_top_percent", "in_box_shots", "box_shots_volume_rank"),
    ("dangerZone", "Dribble attempt volume", "dribble_attempts_volume_top_percent", "dribble_attempts", "dribble_attempts_volume_rank"),
    ("aerial", "Aerial duel volume", "aerial_duel_attempts_volume_top_percent", "aerial_duel_attempts", "aerial_duel_attempts_volume_rank"),
    ("groundDuel", "Ground duel volume", "ground_duel_attempts_volume_top_percent", "ground_duel_attempts", "ground_duel_attempts_volume_rank"),
    ("spaceControl", "Central activity area", "cca_area_top_percent", "tactical:cca_area_pct", "cca_area_rank"),
)

VOLUME_BENCHMARK_AXES = (
    ("outsideShot", "Outside-box shot attempts", "out_box_shots_raw", "out_box_shots"),
    ("boxThreat", "Box hits", "in_box_shots_raw", "in_box_shots"),
    ("dangerZone", "Dribble attempts", "dribble_attempts_raw", "dribble_attempts"),
    ("aerial", "Aerial duel attempts", "aerial_duel_attempts_raw", "aerial_duel_attempts"),
    ("groundDuel", "Ground duel attempts", "ground_duel_attempts_raw", "ground_duel_attempts"),
    ("spaceControl", "Core activity radius", "cca_area_pct", "tactical:cca_area_pct"),
)
RATIO_BENCHMARK_AXES = (
    ("outsideShot", "Outside-box shot quality", "shot_quality_per90_raw", "shot_quality_per90", "single"),
    ("boxThreat", "Deep-box finishing", "deep_box_zone_score", "tactical:deep_box_zone_score", "box"),
    ("dangerZone", "Danger-zone progression", "danger_zone_density", "tactical:danger_zone_density", "danger"),
    ("aerial", "Aerial duel margin", "aerial_margin_per90_raw", "aerial_margin_per90", "single"),
    ("groundDuel", "Ground duel margin", "duel_margin_per90_raw", "duel_margin_per90", "single"),
    ("spaceControl", "Space-control efficiency", "danger_zone_density", "tactical:danger_zone_density", "single"),
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


def _finite_number(value: object) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _volume_score_and_rank(value: float | None, values: tuple[float, ...]) -> tuple[float, int | None]:
    """Use the existing higher-is-better radar scale without a 50-point fallback."""
    if value is None or not values:
        return 20.0, None
    rank = 1 + sum(candidate > value for candidate in values)
    score = round(max(0.0, min(100.0, 100.0 - (rank / len(values)) * 100.0)), 2)
    return score, rank


@lru_cache(maxsize=8)
def _volume_benchmark_populations(season: str) -> dict[str, tuple[float, ...]] | None:
    """Return raw values for the exact eligible domestic eight-league cohort.

    ``get_spear_leaderboard(47, season, 8)`` is the shared 8-league cohort
    builder. Its cached rows contain the raw volume values so a benchmark does
    not perform a second tactical/heatmap scan for every player.
    """
    frame = get_spear_leaderboard(47, season, 8)
    if frame.empty:
        return None
    records = frame.to_dict(orient="records")
    populations = {
        axis_id: tuple(
            value for record in records
            if (value := _finite_number(record.get(frame_attr))) is not None
        )
        for axis_id, _, frame_attr, _ in VOLUME_BENCHMARK_AXES
    }
    return populations if all(populations.values()) else None


def _context_source_metrics(
    player: PlayerResponse, player_id: int, season: str, mode: str, competition: str,
) -> object | None:
    """Read raw metrics from the selected domestic or European context."""
    source_league = leaderboard_target(mode, 8, competition) if mode == "europe" else player.league.id
    source = load_spear_cohort().get((source_league, season), {}).get(str(player_id))
    return source[1] if source is not None else None


@lru_cache(maxsize=128)
def build_volume_benchmark(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> VolumeBenchmarkData | None:
    """Project one selected context onto the fixed domestic 8-league volume scale."""
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    source_context = VolumeBenchmarkSourceContext(
        mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
    )
    populations = _volume_benchmark_populations(season)
    metrics = _context_source_metrics(player, player_id, season, mode, competition)
    if populations is None or metrics is None:
        return VolumeBenchmarkData(
            playerId=player_id, season=season, sourceContext=source_context,
            available=False, reason="benchmark_source_unavailable", axes=[],
        )

    tactical = get_tactical_ratio_for_session(
        player_id, getattr(metrics, "league_name", "") or player.league.name, season,
    )
    axes: list[VolumeBenchmarkAxis] = []
    imputed = False
    for axis_id, label, _, raw_attr in VOLUME_BENCHMARK_AXES:
        raw = _raw_value(metrics, tactical, raw_attr)
        values = populations[axis_id]
        player_score, player_rank = _volume_score_and_rank(raw, values)
        average_scores = [_volume_score_and_rank(value, values)[0] for value in values]
        axis_imputed = raw is None
        imputed = imputed or axis_imputed
        axes.append(VolumeBenchmarkAxis(
            id=axis_id,
            label=label,
            playerScore=player_score,
            averageScore=round(sum(average_scores) / len(average_scores), 2),
            playerRawValue=raw,
            averageRawValue=round(sum(values) / len(values), 4),
            playerRank=player_rank,
            population=len(values),
            tier=_radar_tier(player_score),
            imputed=axis_imputed,
        ))
    return VolumeBenchmarkData(
        playerId=player_id, season=season, sourceContext=source_context,
        available=True, reason="partial_source_imputed" if imputed else "complete", axes=axes,
    )


@lru_cache(maxsize=8)
def _ratio_benchmark_records(season: str) -> tuple[dict[str, object], ...] | None:
    """Return canonical fully eligible domestic 8-league rows for Ratio scoring."""
    frame = get_spear_leaderboard(47, season, 8)
    if frame.empty:
        return None
    return tuple(frame.to_dict(orient="records"))


def _ratio_population_values(records: tuple[dict[str, object], ...], field: str) -> tuple[float, ...]:
    return tuple(
        value for record in records
        if (value := _finite_number(record.get(field))) is not None
    )


def _ratio_component_score(value: float | None, population: tuple[float, ...]) -> float | None:
    if value is None or not population:
        return None
    return _volume_score_and_rank(value, population)[0]


def _ratio_axis_scores(
    records: tuple[dict[str, object], ...], axis_kind: str,
) -> tuple[float, ...]:
    """Mirror existing RATIO_RADAR_AXES factor formulas on the fixed cohort."""
    if axis_kind == "single":
        raise ValueError("single-axis scores require their raw field")
    if axis_kind == "box":
        primary_field, secondary_field, primary_weight = (
            "in_box_finishing_per90_raw", "deep_box_zone_score", 0.70,
        )
    elif axis_kind == "danger":
        primary_field, secondary_field, primary_weight = (
            "dribble_margin_per90_raw", "danger_zone_density", 0.70,
        )
    else:
        raise ValueError(f"unknown Ratio axis kind: {axis_kind}")
    primary_values = _ratio_population_values(records, primary_field)
    secondary_values = _ratio_population_values(records, secondary_field)
    if not primary_values or not secondary_values:
        return ()
    scores: list[float] = []
    for record in records:
        primary = _ratio_component_score(_finite_number(record.get(primary_field)), primary_values)
        secondary = _ratio_component_score(_finite_number(record.get(secondary_field)), secondary_values)
        if primary is not None and secondary is not None:
            scores.append(round(primary_weight * primary + (1.0 - primary_weight) * secondary, 2))
    return tuple(scores)


def _ratio_player_score(
    axis_kind: str,
    raw: float | None,
    metrics: object,
    tactical: dict[str, object] | None,
    records: tuple[dict[str, object], ...],
    raw_frame_attr: str,
) -> tuple[float, int | None, tuple[float, ...]]:
    """Score selected league/Europe metrics on the existing domestic Ratio scale."""
    if axis_kind == "single":
        values = _ratio_population_values(records, raw_frame_attr)
        score_values = tuple(_volume_score_and_rank(value, values)[0] for value in values)
        player_score, player_rank = _volume_score_and_rank(raw, values)
        return player_score, player_rank, score_values
    if axis_kind == "box":
        primary = _raw_value(metrics, tactical, "in_box_finishing_per90")
        primary_values = _ratio_population_values(records, "in_box_finishing_per90_raw")
        secondary_values = _ratio_population_values(records, "deep_box_zone_score")
    elif axis_kind == "danger":
        primary = _raw_value(metrics, tactical, "dribble_margin_per90")
        primary_values = _ratio_population_values(records, "dribble_margin_per90_raw")
        secondary_values = _ratio_population_values(records, "danger_zone_density")
    else:
        raise ValueError(f"unknown Ratio axis kind: {axis_kind}")
    primary_score = _ratio_component_score(primary, primary_values)
    secondary_score = _ratio_component_score(raw, secondary_values)
    scores = _ratio_axis_scores(records, axis_kind)
    if primary_score is None or secondary_score is None or not scores:
        return 20.0, None, scores
    score = round(0.70 * primary_score + 0.30 * secondary_score, 2)
    rank = 1 + sum(candidate > score for candidate in scores)
    return score, rank, scores


@lru_cache(maxsize=128)
def build_ratio_benchmark(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> RatioBenchmarkData | None:
    """Project selected-context Ratio inputs onto the fixed domestic 8-league scale."""
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    source_context = VolumeBenchmarkSourceContext(
        mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
    )
    records = _ratio_benchmark_records(season)
    metrics = _context_source_metrics(player, player_id, season, mode, competition)
    if records is None or metrics is None:
        return RatioBenchmarkData(
            playerId=player_id, season=season, sourceContext=source_context,
            available=False, reason="benchmark_source_unavailable", axes=[],
        )

    tactical = get_tactical_ratio_for_session(
        player_id, getattr(metrics, "league_name", "") or player.league.name, season,
    )
    axes: list[RatioBenchmarkAxis] = []
    imputed = False
    for axis_id, label, frame_attr, raw_attr, axis_kind in RATIO_BENCHMARK_AXES:
        raw = _raw_value(metrics, tactical, raw_attr)
        player_score, player_rank, score_values = _ratio_player_score(
            axis_kind, raw, metrics, tactical, records, frame_attr,
        )
        raw_values = _ratio_population_values(records, frame_attr)
        if not score_values or not raw_values:
            return RatioBenchmarkData(
                playerId=player_id, season=season, sourceContext=source_context,
                available=False, reason="benchmark_source_unavailable", axes=[],
            )
        axis_imputed = raw is None or player_rank is None
        imputed = imputed or axis_imputed
        axes.append(RatioBenchmarkAxis(
            id=axis_id,
            label=label,
            playerScore=player_score,
            averageScore=round(sum(score_values) / len(score_values), 2),
            playerRawValue=raw,
            averageRawValue=round(sum(raw_values) / len(raw_values), 4),
            playerRank=player_rank,
            population=len(score_values),
            tier=_radar_tier(player_score),
            imputed=axis_imputed,
        ))
    return RatioBenchmarkData(
        playerId=player_id, season=season, sourceContext=source_context,
        available=True, reason="partial_source_imputed" if imputed else "complete", axes=axes,
    )


def _summary_missing_line(line_id: str) -> TacticalSummaryLine:
    return TacticalSummaryLine(
        id=line_id,
        text="공간 활동 원천값이 일부 없어 이 항목은 보강 중입니다.",
        imputed=True,
    )


def _build_tactical_summary_lines(tactical: dict[str, object]) -> list[TacticalSummaryLine]:
    """Apply the documented tactical-summary-v1 rule set to static spatial data.

    Positioning uses in-box activity share, movement uses the dominant five-lane
    share, and activity uses the continuous 50%-density core area.  These are
    location summaries only; no client-side median or percentile inference is
    required.
    """
    in_box = _finite_number(tactical.get("in_box_ratio"))
    if in_box is None:
        positioning = _summary_missing_line("positioning")
    elif in_box >= 30.0:
        positioning = TacticalSummaryLine(
            id="positioning",
            text=f"박스 중심 위치선정형 · 반복 활동의 {in_box:.1f}%가 박스 안에 분포합니다.",
            imputed=False,
        )
    else:
        positioning = TacticalSummaryLine(
            id="positioning",
            text=f"박스 외곽 연계형 · 반복 활동의 {in_box:.1f}%가 박스 안에 분포합니다.",
            imputed=False,
        )

    lanes = {lane: _finite_number(tactical.get(f"lane_{lane}_ratio")) for lane in range(1, 6)}
    lane_values = {lane: value for lane, value in lanes.items() if value is not None}
    if len(lane_values) != 5:
        movement = _summary_missing_line("movement")
    else:
        dominant_lane = max(lane_values, key=lambda lane: (lane_values[lane], lane))
        lane_copy = {
            1: "우측 와이드 침투형",
            2: "우측 하프스페이스 타격형",
            3: "중앙 침투형",
            4: "좌측 하프스페이스 타격형",
            5: "좌측 와이드 침투형",
        }[dominant_lane]
        movement = TacticalSummaryLine(
            id="movement",
            text=f"{lane_copy} · 주 활동 레인은 전체 반복 활동의 {lane_values[dominant_lane]:.1f}%를 차지합니다.",
            imputed=False,
        )

    core_area = _finite_number(tactical.get("cca_area_pct"))
    if core_area is None:
        activity = _summary_missing_line("activity")
    else:
        activity_copy = (
            "핵심 반경 집중형" if core_area <= 20.0
            else "핵심 반경 균형형" if core_area <= 35.0
            else "넓은 활동 반경형"
        )
        activity = TacticalSummaryLine(
            id="activity",
            text=f"{activity_copy} · 최고 밀도 50%의 연속 활동 면적은 피치의 {core_area:.1f}%입니다.",
            imputed=False,
        )
    return [positioning, movement, activity]


@lru_cache(maxsize=128)
def build_tactical_summary(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> TacticalSummaryData | None:
    """Return three display-ready tactical lines without changing PlayerAnalysis."""
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    source_context = VolumeBenchmarkSourceContext(
        mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
    )
    metrics = _context_source_metrics(player, player_id, season, mode, competition)
    if metrics is None:
        return TacticalSummaryData(
            playerId=player_id, season=season, sourceContext=source_context,
            available=False, reason="summary_source_unavailable", lines=[],
        )
    tactical = get_tactical_ratio_for_session(
        player_id, getattr(metrics, "league_name", "") or player.league.name, season,
    )
    if tactical is None:
        return TacticalSummaryData(
            playerId=player_id, season=season, sourceContext=source_context,
            available=False, reason="summary_source_unavailable", lines=[],
        )
    lines = _build_tactical_summary_lines(tactical)
    return TacticalSummaryData(
        playerId=player_id,
        season=season,
        sourceContext=source_context,
        available=True,
        reason="partial_source_imputed" if any(line.imputed for line in lines) else "complete",
        lines=lines,
    )


def _spatial_analysis(
    player_id: int,
    tactical: dict[str, object] | None,
    season: str | None = None,
) -> SpatialAnalysis:
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
        # Detail traffic is always season-specific. Passing it through avoids
        # deserialising every historical shotmap shard on the Render instance.
        snapshot_available, shot_rows = get_shotmap_snapshot(heatmap_key, season)
    except ShotmapSnapshotError as exc:
        raise ShotmapContractViolation("Stored shotmap snapshot could not be loaded or validated.") from exc
    valid_shots: list[ShotmapPoint] = []
    for index, shot in enumerate(shot_rows):
        try:
            legacy_shot, _ = _shotmap_point_without_internal_identity(shot)
            valid_shots.append(ShotmapPoint.model_validate(legacy_shot))
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


@lru_cache(maxsize=32)
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


@lru_cache(maxsize=16)
def build_player_detail(player_id: int, season: str, mode: str, scope: int, competition: str) -> PlayerDetailResponse | None:
    # Detail payloads embed all heatmap and shotmap points.  Keeping hundreds
    # of them resident makes the 512 MB Render instance restart under normal
    # browsing, so this deliberately remains a small hot-cache.
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
        rawMetrics=_raw_metrics(metrics), spatial=_spatial_analysis(player_id, tactical, season),
    )
    return PlayerDetailResponse(**player.model_dump(), analysis=analysis)


FINAL_THIRD_ZONE_ORDER = tuple(
    [f"depth6_lane{lane}" for lane in range(1, 6)]
    + [f"depth5_lane{lane}" for lane in range(1, 6)]
)
FINAL_THIRD_SOURCE = "player_season_shot_events"
FINAL_THIRD_UNAVAILABLE_REASON = "shotmap_snapshot_unavailable_for_selected_context"
FINAL_THIRD_COMPETITION_UNAVAILABLE_REASON = "competition_scoped_shot_event_snapshot_unavailable"
FINAL_THIRD_QUALITY_FORMULA = "avg-xgot-minus-avg-xg-v1"
FINAL_THIRD_EFFECTIVE_CONVERSION_FORMULA = "effective-on-target-plus-goal-divided-by-shots-v2"
FINAL_THIRD_EFFECTIVE_COUNT_FORMULA = "status-goal-or-on-target-v2"
FINAL_THIRD_SHOOTING_QUALITY_FORMULA = "sum-xgot-minus-sum-xg-v1"
GOAL_MOUTH_WIDTH_PITCH_PCT = 7.32 / 68.0 * 100.0
GOAL_MOUTH_CROSSBAR_METERS = 2.44
FINAL_THIRD_EUROPE_COMPETITIONS = (
    ("ucl", "Champions League"),
    ("uel", "Europa League"),
    ("uecl", "Europa Conference League"),
)
GOAL_MOUTH_BASELINE_SEASONS = (
    "2021/2022", "2022/2023", "2023/2024", "2024/2025", "2025/2026",
)
GOAL_MOUTH_BASELINE_MINIMUM_CELL_SAMPLE = 150
GOAL_MOUTH_BASELINE_DATA_DIR = Path(__file__).resolve().parents[1] / "data"


def _goal_mouth_baseline_shards() -> tuple[Path, ...]:
    """Return only the documented five static baseline inputs, in season order."""
    return tuple(
        GOAL_MOUTH_BASELINE_DATA_DIR / f"tactical_shotmap_points_{season.replace('/', '_')}.json"
        for season in GOAL_MOUTH_BASELINE_SEASONS
    )


def goal_mouth_baseline_snapshot_revision() -> tuple[tuple[str, int, int], ...] | None:
    """Revision key for the closed five-shard manifest, or None when any shard is absent."""
    revision: list[tuple[str, int, int]] = []
    for path in _goal_mouth_baseline_shards():
        try:
            stat = path.stat()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise ShotmapContractViolation(
                f"Goal-mouth baseline static snapshot could not be statted: {path.name}."
            ) from exc
        revision.append((path.name, stat.st_mtime_ns, stat.st_size))
    return tuple(revision)


def _goal_mouth_baseline_cells(
    counts: list[list[list[int]]], *, unavailable_reason: str | None = None,
) -> list[GoalMouthBaselineCell]:
    cells: list[GoalMouthBaselineCell] = []
    for row in range(1, 6):
        for column in range(1, 11):
            shots, goals = counts[row - 1][column - 1]
            cell_kwargs = dict(
                cellId=f"row{row}_column{column}", column=column, row=row,
                yMin=(column - 1) / 10, yMax=column / 10,
                zMin=(row - 1) / 5, zMax=row / 5,
            )
            if unavailable_reason is not None:
                cells.append(GoalMouthBaselineCell(
                    **cell_kwargs, shots=None, goals=None, goalRatePct=None,
                    state="unavailable", lowSample=False, confidenceIntervalPct=None,
                    reason=unavailable_reason,
                ))
            elif shots < GOAL_MOUTH_BASELINE_MINIMUM_CELL_SAMPLE:
                cells.append(GoalMouthBaselineCell(
                    **cell_kwargs, shots=shots, goals=goals,
                    goalRatePct=(100.0 * goals / shots) if shots else None,
                    state="low_sample", lowSample=True,
                    confidenceIntervalPct=_goal_mouth_baseline_confidence_interval(goals, shots),
                    reason="insufficient_baseline_sample",
                ))
            else:
                cells.append(GoalMouthBaselineCell(
                    **cell_kwargs, shots=shots, goals=goals,
                    goalRatePct=100.0 * goals / shots,
                    state="observed", lowSample=False,
                    confidenceIntervalPct=_goal_mouth_baseline_confidence_interval(goals, shots),
                    reason=None,
                ))
    return cells


def _goal_mouth_baseline_confidence_interval(
    goals: int, shots: int,
) -> GoalMouthBaselineConfidenceInterval | None:
    """Return the unrounded 95% Wilson interval, in percentage points."""
    if shots == 0:
        return None
    z = 1.959963984540054
    proportion = goals / shots
    z_squared = z * z
    denominator = 1.0 + z_squared / shots
    center = (proportion + z_squared / (2.0 * shots)) / denominator
    half_width = z * math.sqrt(
        (proportion * (1.0 - proportion) + z_squared / (4.0 * shots)) / shots
    ) / denominator
    return GoalMouthBaselineConfidenceInterval(
        lower=max(0.0, 100.0 * (center - half_width)),
        upper=min(100.0, 100.0 * (center + half_width)),
    )


def _goal_mouth_baseline_unavailable() -> GoalMouthBaselineEnvelope:
    reason = "required_static_snapshot_missing"
    return GoalMouthBaselineEnvelope(data=GoalMouthBaselineData(
        available=False, reason=reason,
        provenance=GoalMouthBaselineProvenance(totalShots=None, totalGoals=None),
        cells=_goal_mouth_baseline_cells(
            [[[0, 0] for _ in range(10)] for _ in range(5)], unavailable_reason=reason,
        ),
    ))


@lru_cache(maxsize=2)
def _build_goal_mouth_baseline_cached(
    revision: tuple[tuple[str, int, int], ...] | None,
) -> GoalMouthBaselineEnvelope:
    """Aggregate the fixed historical static manifest; no player or provider data is used."""
    if revision is None:
        return _goal_mouth_baseline_unavailable()
    counts = [[[0, 0] for _ in range(10)] for _ in range(5)]
    total_shots = 0
    total_goals = 0
    for path in _goal_mouth_baseline_shards():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            # A deployment/data-refresh race must preserve the published
            # unavailable contract rather than pretending any partial total.
            return _goal_mouth_baseline_unavailable()
        except (OSError, ValueError) as exc:
            raise ShotmapContractViolation(
                f"Goal-mouth baseline static snapshot could not be loaded: {path.name}."
            ) from exc
        if not isinstance(payload, dict):
            raise ShotmapContractViolation(
                f"Goal-mouth baseline static snapshot must contain an object: {path.name}."
            )
        for heatmap_key, source_rows in payload.items():
            if not isinstance(source_rows, list):
                raise ShotmapContractViolation(
                    f"Goal-mouth baseline static snapshot entry must contain an array: {path.name}:{heatmap_key}."
                )
            for source_index, raw in enumerate(source_rows):
                raw_point, _ = _shotmap_point_without_internal_identity(raw)
                try:
                    point = ShotmapPoint.model_validate(raw_point)
                except (TypeError, ValueError, ValidationError) as exc:
                    raise ShotmapContractViolation(
                        "Goal-mouth baseline static snapshot contains an invalid record "
                        f"at {path.name}:{heatmap_key} index {source_index}."
                    ) from exc
                endpoint_available, mouth_y, mouth_z, _, _ = _final_third_endpoint(point)
                if not (
                    endpoint_available
                    and mouth_y is not None and mouth_z is not None
                    and math.isfinite(mouth_y) and math.isfinite(mouth_z)
                    and 0 <= mouth_y <= 1 and 0 <= mouth_z <= 1
                ):
                    continue
                column = min(9, math.floor(mouth_y * 10))
                row = min(4, math.floor(mouth_z * 5))
                counts[row][column][0] += 1
                counts[row][column][1] += int(point.outcome == "goal")
                total_shots += 1
                total_goals += int(point.outcome == "goal")
    return GoalMouthBaselineEnvelope(data=GoalMouthBaselineData(
        available=True, reason=None,
        provenance=GoalMouthBaselineProvenance(
            totalShots=total_shots, totalGoals=total_goals,
        ),
        cells=_goal_mouth_baseline_cells(counts),
    ))


def build_goal_mouth_baseline() -> GoalMouthBaselineEnvelope:
    """Return the cached global 10×5 baseline, invalidating only on its five inputs."""
    return _build_goal_mouth_baseline_cached(goal_mouth_baseline_snapshot_revision())


def _final_third_segment(value: float, boundaries: tuple[float, ...]) -> int:
    """Use the published positional-grid boundary convention (right edge inclusive)."""
    for index, edge in enumerate(boundaries[1:], start=1):
        if value < edge or index == len(boundaries) - 1:
            return index
    raise AssertionError("positional grid must cover normalized pitch coordinates")


def _final_third_zone_id(pitch_x: float, pitch_y: float) -> str:
    depth = _final_third_segment(pitch_x, POSITIONAL_DEPTH_BOUNDARIES)
    lane = _final_third_segment(pitch_y, POSITIONAL_LANE_BOUNDARIES)
    return f"depth{depth}_lane{lane}"


def _final_third_field(
    state: str, reason: str | None = None, formula_version: str | None = None,
    source_available: bool = True,
) -> FinalThirdFieldState:
    return FinalThirdFieldState(
        state=state,
        reason=reason,
        source=FINAL_THIRD_SOURCE if source_available else None,
        formulaVersion=formula_version,
    )


def _final_third_unavailable_zones(reason: str) -> list[FinalThirdShotZone]:
    return [
        FinalThirdShotZone(
            zoneId=zone_id,
            depth=int(zone_id[5]), lane=int(zone_id[-1]),
            shotsTotal=None, goals=None, conversionRatePct=None,
            qualityScore=None, qualityEligibleShots=None,
            state="unavailable", reason=reason, source=None,
            fieldStates=FinalThirdZoneFieldStates(
                volume=_final_third_field("unavailable", reason, source_available=False),
                conversionRatePct=_final_third_field("unavailable", reason, source_available=False),
                qualityScore=_final_third_field("unavailable", reason, FINAL_THIRD_QUALITY_FORMULA, source_available=False),
            ),
        )
        for zone_id in FINAL_THIRD_ZONE_ORDER
    ]


def _final_third_endpoint(point: ShotmapPoint) -> tuple[bool, float | None, float | None, str | None, bool]:
    """Translate a provider goal-line endpoint without deriving any missing coordinate.

    The static v1 trajectory's blocked point is useful on the pitch but is not
    a goal-mouth endpoint.  It therefore remains intentionally unplottable in
    the front-on view.
    """
    if point.outcome == "blocked":
        return False, None, None, "blocked_has_no_goal_mouth_endpoint", False
    trajectory = point.trajectory
    if trajectory is None:
        return False, None, None, "goal_mouth_endpoint_unavailable_in_source", True
    if trajectory.endpointKind != "goal_mouth" or trajectory.endZMeters is None:
        return False, None, None, "goal_mouth_endpoint_incomplete_in_source", True
    # The normalized goal frame is intentionally not clamped. A provider may
    # report a shot outside the posts/crossbar and the client must preserve it.
    mouth_y = 0.5 + (trajectory.endY - 50.0) / GOAL_MOUTH_WIDTH_PITCH_PCT
    mouth_z = trajectory.endZMeters / GOAL_MOUTH_CROSSBAR_METERS
    return True, round(mouth_y, 6), round(mouth_z, 6), None, False


def _final_third_quality_values(point: ShotmapPoint) -> tuple[float, float] | None:
    if point.xg is None or point.xgot is None:
        return None
    if not math.isfinite(point.xg) or not math.isfinite(point.xgot):
        return None
    return point.xg, point.xgot


def _final_third_shooting_quality_summary(
    points: list[ShotmapPoint], *, source_partial_reason: str | None = None,
    unavailable_reason: str | None = None,
) -> FinalThirdShootingQualitySummary:
    """Return the caption value from the same source-event eligibility as zone quality.

    This is deliberately server-owned: clients receive a total and never sum
    xG/xGOT from the per-shot display array.
    """
    if unavailable_reason is not None:
        return FinalThirdShootingQualitySummary(
            totalShotCount=None, eligibleShotCount=None, xgTotal=None, xgotTotal=None,
            xgotMinusXg=None, state="unavailable", reason=unavailable_reason, source=None,
        )
    total = len(points)
    eligible = [value for point in points if (value := _final_third_quality_values(point)) is not None]
    missing = total - len(eligible)
    if not eligible and total:
        return FinalThirdShootingQualitySummary(
            totalShotCount=total, eligibleShotCount=0, xgTotal=None, xgotTotal=None,
            xgotMinusXg=None, state="unavailable",
            reason="xgot_or_xg_unavailable_for_all_front_two_shots",
            source=FINAL_THIRD_SOURCE,
        )
    xg_total = round(sum(xg for xg, _ in eligible), 4)
    xgot_total = round(sum(xgot for _, xgot in eligible), 4)
    delta = round(xgot_total - xg_total, 4)
    reason = source_partial_reason
    if missing:
        missing_reason = f"xgot_or_xg_unavailable_for_{missing}_front_two_shots"
        reason = f"{reason};{missing_reason}" if reason else missing_reason
    return FinalThirdShootingQualitySummary(
        totalShotCount=total, eligibleShotCount=len(eligible), xgTotal=xg_total,
        xgotTotal=xgot_total, xgotMinusXg=delta,
        state="partial" if reason else "observed", reason=reason,
        source=FINAL_THIRD_SOURCE,
    )


def _final_third_snapshot_identity(heatmap_key: str | None, raw: object, occurrence: int) -> str:
    """Return a collision-resistant identity for legacy ID-less static records.

    The fingerprint uses the complete persisted record rather than presentation
    coordinates alone.  ``occurrence`` only distinguishes byte-identical
    records; snapshot builders retain provider list order deterministically.
    This is explicitly labelled ``snapshot_record`` in the response.
    """
    canonical = json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]
    return f"snapshot_record:{heatmap_key}:{digest}:{occurrence}"


def _shotmap_point_without_internal_identity(raw: object) -> tuple[object, str | None]:
    """Read optional ETL identity without extending the legacy ShotmapPoint DTO."""
    if not isinstance(raw, dict):
        return raw, None
    source_event_id = raw.get("sourceEventId")
    event_id = None
    if isinstance(source_event_id, (str, int)) and not isinstance(source_event_id, bool):
        text = str(source_event_id).strip()
        event_id = text or None
    return {key: value for key, value in raw.items() if key != "sourceEventId"}, event_id


def _final_third_source_snapshots(
    player_id: int, player: PlayerResponse, season: str, mode: str, competition: str,
) -> tuple[list[tuple[str, list[object]]], list[str], str]:
    """Load only exact selected-context snapshot shards, never a fallback.

    ``europe=all`` is a true union of the UEFA tournaments in which this
    player has an exact tactical session. It may be partial when one of those
    committed competition snapshots is unavailable, but it must never choose
    a single competition based on the arbitrary display league of an all-cup
    aggregate row.
    """

    if mode == "league":
        competition_names = (player.league.name,)
        unavailable_reason = FINAL_THIRD_UNAVAILABLE_REASON
    elif competition == "all":
        competition_names = tuple(label for _, label in FINAL_THIRD_EUROPE_COMPETITIONS)
        unavailable_reason = FINAL_THIRD_COMPETITION_UNAVAILABLE_REASON
    else:
        competition_names = tuple(
            label for code, label in FINAL_THIRD_EUROPE_COMPETITIONS if code == competition
        )
        unavailable_reason = FINAL_THIRD_COMPETITION_UNAVAILABLE_REASON

    snapshots: list[tuple[str, list[object]]] = []
    missing_keys: list[str] = []
    seen_keys: set[str] = set()
    for competition_name in competition_names:
        tactical = get_tactical_session_row(player_id, competition_name, season)
        heatmap_key = str(tactical.get("heatmap_key") or "") if tactical else ""
        if not heatmap_key or heatmap_key in seen_keys:
            continue
        seen_keys.add(heatmap_key)
        try:
            snapshot_available, source_rows = get_shotmap_snapshot(heatmap_key, season)
        except ShotmapSnapshotError as exc:
            raise ShotmapContractViolation(
                "Final-third shotmap snapshot could not be loaded or validated."
            ) from exc
        if snapshot_available:
            snapshots.append((heatmap_key, list(source_rows)))
        else:
            missing_keys.append(heatmap_key)
    return snapshots, missing_keys, unavailable_reason


@lru_cache(maxsize=128)
def _build_final_third_shot_map_cached(
    player_id: int, season: str, mode: str, scope: int, competition: str,
    snapshot_revision: tuple[int, int] | None,
    conversion_version: str = "goals-v1",
) -> FinalThirdShotEnvelope | FinalThirdEffectiveShotEnvelope | FinalThirdGoalMouthEnvelope | None:
    """Aggregate one immutable shotmap snapshot without any provider request."""
    del snapshot_revision  # cache invalidation input; the store owns file access.
    goal_mouth_v3 = conversion_version == "goal-mouth-v3"
    effective_conversion = conversion_version in {"effective-shot-v2", "goal-mouth-v3"}
    player = find_v2_player(player_id, season, mode, scope, competition)
    if player is None:
        return None
    context = FinalThirdShotContext(
        playerId=player_id, season=season, mode=mode,
        scope=scope if mode == "league" else None,
        competition=competition if mode == "europe" else None,
    )
    snapshots, missing_source_keys, unavailable_reason = _final_third_source_snapshots(
        player_id, player, season, mode, competition,
    )
    if not snapshots:
        unavailable_zones = _final_third_unavailable_zones(unavailable_reason)
        if effective_conversion:
            effective_data = dict(
                    available=False, completeness="unavailable", reason=unavailable_reason,
                    qualityScale=FinalThirdQualityScale(),
                    markerSizeScale=FinalThirdMarkerSizeScale(),
                    goalMouthCoordinates=FinalThirdGoalMouthCoordinates(),
                    zones=[FinalThirdEffectiveShotZone.model_validate({
                        **zone.model_dump(),
                        "effectiveShotCount": None,
                        "fieldStates": {
                            **zone.fieldStates.model_dump(),
                            "effectiveShotCount": _final_third_field(
                                "unavailable", unavailable_reason,
                                FINAL_THIRD_EFFECTIVE_COUNT_FORMULA,
                                source_available=False,
                            ).model_dump(),
                        },
                    }) for zone in unavailable_zones],
                    shots=[], endpointUnavailableCount=0, endpointUnavailableShotIds=[], partialCoverage=[],
            )
            if goal_mouth_v3:
                return FinalThirdGoalMouthEnvelope(
                    context=context,
                    data=FinalThirdGoalMouthData(
                        **effective_data,
                        shootingQuality=_final_third_shooting_quality_summary(
                            [], unavailable_reason=unavailable_reason,
                        ),
                    ),
                )
            return FinalThirdEffectiveShotEnvelope(context=context, data=FinalThirdEffectiveShotData(**effective_data))
        return FinalThirdShotEnvelope(
            context=context,
            data=FinalThirdShotData(
                available=False, completeness="unavailable", reason=unavailable_reason,
                qualityScale=FinalThirdQualityScale(),
                markerSizeScale=FinalThirdMarkerSizeScale(),
                goalMouthCoordinates=FinalThirdGoalMouthCoordinates(),
                zones=unavailable_zones, shots=[],
                endpointUnavailableCount=0, endpointUnavailableShotIds=[], partialCoverage=[],
            ),
        )

    zone_points: dict[str, list[ShotmapPoint]] = {zone_id: [] for zone_id in FINAL_THIRD_ZONE_ORDER}
    shots: list[FinalThirdShot] = []
    source_partial_reason = (
        "competition_snapshot_unavailable:" + ",".join(missing_source_keys)
        if missing_source_keys else None
    )
    coverage: list[FinalThirdCoverageIssue] = [
        FinalThirdCoverageIssue(
            zoneId=zone_id, field=field, reason=source_partial_reason,
        )
        for zone_id in FINAL_THIRD_ZONE_ORDER
        for field in ("volume", "conversionRatePct", "qualityScore")
        if source_partial_reason is not None
    ]
    snapshot_identity_occurrences: dict[str, int] = {}
    provider_event_occurrences: dict[str, int] = {}
    for heatmap_key, source_rows in snapshots:
        for source_index, raw in enumerate(source_rows):
            raw_point, provider_event_id = _shotmap_point_without_internal_identity(raw)
            try:
                point = ShotmapPoint.model_validate(raw_point)
            except (TypeError, ValueError, ValidationError) as exc:
                raise ShotmapContractViolation(
                    "Final-third shotmap snapshot contains an invalid record "
                    f"at {heatmap_key} index {source_index}."
                ) from exc
            zone_id = _final_third_zone_id(point.x, point.y)
            # Allocate identity before filtering: the value is stable if a future
            # taxonomy adds depth bands without altering this source record list.
            if provider_event_id is not None:
                occurrence = provider_event_occurrences.get(provider_event_id, 0)
                provider_event_occurrences[provider_event_id] = occurrence + 1
                shot_id = (
                    provider_event_id if occurrence == 0
                    else f"provider_event:{heatmap_key}:{provider_event_id}:{occurrence}"
                )
                shot_id_source = "provider_event"
            else:
                canonical = json.dumps(raw_point, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
                occurrence_key = f"{heatmap_key}\x00{canonical}"
                occurrence = snapshot_identity_occurrences.get(occurrence_key, 0)
                snapshot_identity_occurrences[occurrence_key] = occurrence + 1
                shot_id = _final_third_snapshot_identity(heatmap_key, raw_point, occurrence)
                shot_id_source = "snapshot_record"
            if zone_id not in zone_points:
                continue
            endpoint_available, mouth_y, mouth_z, endpoint_reason, unexpected_missing = _final_third_endpoint(point)
            shot = FinalThirdShot(
                shotId=shot_id, zoneId=zone_id, pitchX=point.x, pitchY=point.y,
                shotIdSource=shot_id_source, xg=point.xg, xgot=point.xgot, status=point.outcome,
                endpointAvailable=endpoint_available, goalMouthY=mouth_y,
                goalMouthZ=mouth_z, endpointReason=endpoint_reason,
            )
            shots.append(shot)
            zone_points[zone_id].append(point)
            if unexpected_missing:
                coverage.append(FinalThirdCoverageIssue(
                    shotId=shot_id, field="goalMouthEndpoint", reason=endpoint_reason or "source_endpoint_unavailable",
                ))

    zones: list[FinalThirdShotZone | FinalThirdEffectiveShotZone] = []
    conversion_formula = (
        FINAL_THIRD_EFFECTIVE_CONVERSION_FORMULA
        if effective_conversion else "goals-divided-by-shots-v1"
    )
    for zone_id in FINAL_THIRD_ZONE_ORDER:
        points = zone_points[zone_id]
        depth, lane = int(zone_id[5]), int(zone_id[-1])
        shots_total = len(points)
        if shots_total == 0:
            reason = source_partial_reason or "no_attempts_in_zone"
            field_state = "partial" if source_partial_reason else "observed"
            zone_kwargs = dict(
                zoneId=zone_id, depth=depth, lane=lane, shotsTotal=0, goals=0,
                conversionRatePct=None, qualityScore=None, qualityEligibleShots=0,
                state="partial" if source_partial_reason else "observed",
                reason=source_partial_reason, source=FINAL_THIRD_SOURCE,
                fieldStates=FinalThirdZoneFieldStates(
                    volume=_final_third_field(field_state, source_partial_reason),
                    conversionRatePct=_final_third_field(
                        "partial" if source_partial_reason else "unavailable", reason,
                        formula_version=conversion_formula if effective_conversion else None,
                    ),
                    qualityScore=_final_third_field(
                        "partial" if source_partial_reason else "unavailable",
                        reason, FINAL_THIRD_QUALITY_FORMULA,
                    ),
                ),
            )
            if effective_conversion:
                zones.append(FinalThirdEffectiveShotZone(
                    **{
                        **zone_kwargs,
                        "fieldStates": FinalThirdEffectiveShotZoneFieldStates(
                            **zone_kwargs["fieldStates"].model_dump(),
                            effectiveShotCount=_final_third_field(
                                field_state, source_partial_reason,
                                FINAL_THIRD_EFFECTIVE_COUNT_FORMULA,
                            ),
                        ),
                    },
                    effectiveShotCount=0,
                ))
            else:
                zones.append(FinalThirdShotZone(**zone_kwargs))
            continue
        goals = sum(point.outcome == "goal" for point in points)
        effective_shots = sum(point.outcome in {"goal", "on_target"} for point in points)
        eligible = [value for point in points if (value := _final_third_quality_values(point)) is not None]
        missing_quality = shots_total - len(eligible)
        conversion_numerator = effective_shots if effective_conversion else goals
        conversion = round(conversion_numerator / shots_total * 100.0, 2)
        if eligible:
            quality = round(
                sum(xgot for _, xgot in eligible) / len(eligible)
                - sum(xg for xg, _ in eligible) / len(eligible),
                4,
            )
            quality_state = "partial" if (missing_quality or source_partial_reason) else "observed"
            quality_reason = (
                f"xgot_or_xg_unavailable_for_{missing_quality}_shots" if missing_quality else None
            )
        else:
            quality = None
            quality_state = "unavailable"
            quality_reason = "xgot_or_xg_unavailable_for_all_zone_shots"
        if missing_quality:
            coverage.append(FinalThirdCoverageIssue(
                zoneId=zone_id, field="qualityScore", reason=quality_reason or "quality_source_unavailable",
            ))
        if source_partial_reason and quality_reason:
            quality_reason = f"{source_partial_reason};{quality_reason}"
        elif source_partial_reason:
            quality_reason = source_partial_reason
        zone_kwargs = dict(
            zoneId=zone_id, depth=depth, lane=lane, shotsTotal=shots_total, goals=goals,
            conversionRatePct=conversion, qualityScore=quality,
            qualityEligibleShots=len(eligible),
            state="partial" if (missing_quality or source_partial_reason) else "observed",
            reason=quality_reason,
            source=FINAL_THIRD_SOURCE,
            fieldStates=FinalThirdZoneFieldStates(
                volume=_final_third_field(
                    "partial" if source_partial_reason else "observed", source_partial_reason,
                ),
                conversionRatePct=_final_third_field(
                    "partial" if source_partial_reason else "observed",
                    source_partial_reason, formula_version=conversion_formula,
                ),
                qualityScore=_final_third_field(quality_state, quality_reason, FINAL_THIRD_QUALITY_FORMULA),
            ),
        )
        if effective_conversion:
            zones.append(FinalThirdEffectiveShotZone(
                **{
                    **zone_kwargs,
                    "fieldStates": FinalThirdEffectiveShotZoneFieldStates(
                        **zone_kwargs["fieldStates"].model_dump(),
                        effectiveShotCount=_final_third_field(
                            "partial" if source_partial_reason else "observed",
                            source_partial_reason,
                            FINAL_THIRD_EFFECTIVE_COUNT_FORMULA,
                        ),
                    ),
                },
                effectiveShotCount=effective_shots,
            ))
        else:
            zones.append(FinalThirdShotZone(**zone_kwargs))
    completeness = "partial" if coverage else "complete"
    endpoint_unavailable_ids = [shot.shotId for shot in shots if not shot.endpointAvailable]
    if effective_conversion:
        effective_data = dict(
                available=True, completeness=completeness, reason=None,
                qualityScale=FinalThirdQualityScale(),
                markerSizeScale=FinalThirdMarkerSizeScale(),
                goalMouthCoordinates=FinalThirdGoalMouthCoordinates(), zones=zones, shots=shots,
                endpointUnavailableCount=len(endpoint_unavailable_ids),
                endpointUnavailableShotIds=endpoint_unavailable_ids, partialCoverage=coverage,
        )
        if goal_mouth_v3:
            all_points = [point for zone in zone_points.values() for point in zone]
            return FinalThirdGoalMouthEnvelope(
                context=context,
                data=FinalThirdGoalMouthData(
                    **effective_data,
                    shootingQuality=_final_third_shooting_quality_summary(
                        all_points, source_partial_reason=source_partial_reason,
                    ),
                ),
            )
        return FinalThirdEffectiveShotEnvelope(context=context, data=FinalThirdEffectiveShotData(**effective_data))
    return FinalThirdShotEnvelope(
        context=context,
        data=FinalThirdShotData(
            available=True, completeness=completeness, reason=None,
            qualityScale=FinalThirdQualityScale(),
            markerSizeScale=FinalThirdMarkerSizeScale(),
            goalMouthCoordinates=FinalThirdGoalMouthCoordinates(), zones=zones, shots=shots,
            endpointUnavailableCount=len(endpoint_unavailable_ids),
            endpointUnavailableShotIds=endpoint_unavailable_ids, partialCoverage=coverage,
        ),
    )


def build_final_third_shot_map(
    player_id: int, season: str, mode: str, scope: int, competition: str,
    conversion_version: str = "goals-v1",
) -> FinalThirdShotEnvelope | FinalThirdEffectiveShotEnvelope | FinalThirdGoalMouthEnvelope | None:
    """Return only snapshot-backed data and invalidate aggregates on source refresh."""
    return _build_final_third_shot_map_cached(
        player_id, season, mode, scope, competition, shotmap_snapshot_revision(season), conversion_version,
    )


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


@lru_cache(maxsize=64)
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


def _contextual_compare_context(
    side: ContextualCompareRequestSide,
) -> ContextualCompareCanonicalContext:
    context = side.context
    return ContextualCompareCanonicalContext(
        season=context.season,
        mode=context.mode,
        scope=context.scope if context.mode == "league" else None,
        competition=context.competition if context.mode == "europe" else None,
    )


def _resolve_contextual_compare_side(
    player_id: int, taxonomy: str, season: str, mode: str, scope: int, competition: str,
) -> tuple[str, PlayerResponse | None, ContextualCompareComponentAvailability, PlayerDetailResponse | None, MessiDataQuality | None, TacticalQuadrantAnalysis | None, DuelPressPlayerResponse | None, DuelPressDetailReadoutEnvelope | None]:
    """Resolve one side from its own static cohort only.

    Europe summary and duel cohorts are static and context-correct, but the
    legacy detail, quality, and tactical builders read domestic profile and
    tactical files keyed by the player's home league. Do not label those
    domestic calculations as a European comparison. Europe therefore returns
    only its exact-context summary and, for duel-press, its exact-context duel
    companions; analysis companions declare their unavailable provenance.

    There is deliberately no additional contextual cache here. The builders
    have their own bounded caches, whose invalidation properties are explicit;
    an outer cache keyed by an incomplete file-version tuple would only hide
    changes to player profiles or nested static inputs.
    """
    unavailable = ContextualCompareComponentAvailability(
        detail="unavailable", dataQuality="unavailable", tacticalQuadrant="unavailable",
    )
    if season not in supported_seasons() or not build_v2_players(season, mode, scope, competition):
        return "invalid_context", None, unavailable, None, None, None, None, None
    summary = find_v2_player(player_id, season, mode, scope, competition)
    if summary is None:
        return "unavailable", None, unavailable, None, None, None, None, None
    if mode == "europe":
        europe_unavailable = ContextualCompareComponentAvailability(
            detail="exact_context_analysis_unavailable",
            dataQuality="exact_context_analysis_unavailable",
            tacticalQuadrant="exact_context_analysis_unavailable",
        )
        if taxonomy == "legacy-v1":
            return "resolved", summary, europe_unavailable, None, None, None, None, None
        duel = find_duel_press_player(player_id, season, mode, scope, competition)
        readout = find_duel_press_detail_readouts(player_id, season, mode, scope, competition)
        if duel is None or readout is None:
            return "unavailable", None, unavailable, None, None, None, None, None
        return "resolved", summary, europe_unavailable, None, None, None, duel.data, readout
    detail = build_player_detail(player_id, season, mode, scope, competition)
    quality = build_player_data_quality(player_id, season, mode, scope, competition)
    if detail is None or quality is None:
        return "unavailable", None, unavailable, None, None, None, None, None
    quadrant = build_tactical_quadrant_analysis(player_id, season, mode, scope, competition)
    resolved_quadrant = quadrant if quadrant is not None and quadrant.available else None
    league_availability = ContextualCompareComponentAvailability(
        detail="available", dataQuality="available",
        tacticalQuadrant="available" if resolved_quadrant is not None else "unavailable",
    )
    if taxonomy == "legacy-v1":
        return "resolved", summary, league_availability, detail, quality.dataQuality, resolved_quadrant, None, None
    duel = find_duel_press_player(player_id, season, mode, scope, competition)
    readout = find_duel_press_detail_readouts(player_id, season, mode, scope, competition)
    if duel is None or readout is None:
        return "unavailable", None, unavailable, None, None, None, None, None
    return "resolved", summary, league_availability, detail, quality.dataQuality, resolved_quadrant, duel.data, readout


def resolve_contextual_compare_sides(
    left: ContextualCompareRequestSide, right: ContextualCompareRequestSide,
) -> ContextualCompareEnvelope:
    """Return two independently resolved sides in request order without fan-out."""
    def resolve(side: ContextualCompareRequestSide) -> ContextualCompareSide:
        request_context = side.context
        scope = request_context.scope or 8
        status, summary, component_availability, detail, quality, quadrant, duel, readout = _resolve_contextual_compare_side(
            side.player.playerId, side.taxonomy, request_context.season,
            request_context.mode, scope, request_context.competition,
        )
        return ContextualCompareSide(
            player=side.player,
            taxonomy=side.taxonomy,
            context=_contextual_compare_context(side),
            status=status,
            summary=summary,
            componentAvailability=component_availability,
            detail=detail,
            dataQuality=quality,
            tacticalQuadrant=quadrant,
            duelPressPlayer=duel,
            duelPressDetailReadout=readout,
        )

    return ContextualCompareEnvelope(left=resolve(left), right=resolve(right))


def leaderboard_options() -> dict[str, object]:
    seasons = sorted(supported_seasons(), reverse=True)
    return {
        "seasons": seasons,
        "scopes": [{"value": scope, "label": f"{scope} major leagues", "leagueIds": sorted(ids)} for scope, ids in sorted(COMPARISON_SCOPES.items())],
        "competitions": available_competitions(seasons[0]) if seasons else {},
    }


def find_v2_player(player_id: int, season: str, mode: str, scope: int, competition: str) -> PlayerResponse | None:
    return _v2_player_summary_index(season, mode, scope, competition).get(player_id)


def find_v2_player_summary_timed(
    player_id: int, season: str, mode: str, scope: int, competition: str,
) -> tuple[PlayerResponse | None, dict[str, object]]:
    """Resolve an unchanged PlayerEnvelope row and expose only safe timing metadata.

    Timing is intentionally service-side instrumentation rather than a public
    DTO field.  It lets Render logs distinguish a cached context lookup from a
    cohort/index build without leaking source payloads or user credentials.
    """
    before = _v2_player_summary_index.cache_info()
    started = time.perf_counter()
    player = find_v2_player(player_id, season, mode, scope, competition)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    after = _v2_player_summary_index.cache_info()
    return player, {
        "phaseCohortIndexMs": elapsed_ms,
        "indexCache": "miss" if after.misses > before.misses else "hit",
    }


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
