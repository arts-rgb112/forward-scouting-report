from __future__ import annotations

from datetime import datetime, timezone
from collections import OrderedDict
from functools import lru_cache
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
from tactical_ratio import get_heatmap_points, get_tactical_ratio_for_session
from shotmap_store_v2 import ShotmapSnapshotError, get_shotmap_snapshot

from .schemas import (
    AgeBand, AssetRef, CompareMeta, ContinuousCoreAnalysis, DatasetMeta, DuelSpatialAnalysis, HeatmapPoint, ShotmapPoint, LeaderboardAppliedFilters, LeaderboardEnvelope,
    DuelPressAppliedFilters, DuelPressComponents, DuelPressLeaderboardEnvelope,
    DuelPressLeaderboardSort, DuelPressPlayerEnvelope, DuelPressPlayerResponse,
    DuelPressPlayerStats, DuelPressRawMetrics, DuelPressRequestContext,
    DetailReadoutComparison, DuelPressDetailCategory, DuelPressDetailPlayerIdentity,
    DuelPressDetailReadout, DuelPressDetailReadoutEnvelope,
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
