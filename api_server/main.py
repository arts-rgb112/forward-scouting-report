from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from starlette.concurrency import run_in_threadpool
from starlette.responses import PlainTextResponse

from .schemas import (
    AgeBand, ApiErrorEnvelope, DuelSpatialEnvelope, HealthResponse, LeaderboardEnvelope, LeaderboardOptions, LeaderboardPageEnvelope,
    DuelPressLeaderboardEnvelope, DuelPressLeaderboardSort, DuelPressPlayerEnvelope,
    DuelPressDetailReadoutEnvelope,
    DuelPressV2LeaderboardPageEnvelope, DuelPressV2PlayerEnvelope,
    DuelPressDetailReadoutV2Envelope,
    ContextualCompareEnvelope, ContextualCompareRequest,
    MetricRanksEnvelope, MetricRanksRequest,
    BenchmarkRadarV2Envelope, RatioBenchmarkEnvelope, TacticalSummaryEnvelope, TacticalSummaryV2Envelope, VolumeBenchmarkEnvelope,
    LeaderboardSort, MinutesBand, SortOrder,
    PlayerComparisonEnvelope, PlayerDataQualityEnvelope, PlayerDetailEnvelope,
    PlayerEnvelope, PlayersEnvelope, WatchlistDataQualityEnvelope,
    ShotmapServiceErrorDetail, ShotmapServiceErrorEnvelope,
    FinalThirdEffectiveShotEnvelope, FinalThirdGoalMouthEnvelope, FinalThirdShotEnvelope,
    GoalMouthBaselineEnvelope, SixLaneShootingCorridorEnvelope, FullActivityHeatmapEnvelope,
    WatchlistResolveEnvelope, WatchlistResolveRequest, TacticalQuadrantEnvelope,
)
from .service import (
    build_duel_spatial_analysis, build_player_data_quality, build_players,
    duel_press_leaderboard_envelope, find_duel_press_player,
    find_duel_press_detail_readouts,
    duel_press_v2_leaderboard_envelope, find_duel_press_v2_player,
    find_duel_press_detail_readouts_v2,
    build_player_detail, build_tactical_quadrant_analysis, compare_players, find_v2_player_summary_timed, leaderboard_options,
    resolve_contextual_compare_sides,
    leaderboard_v21_envelope, leaderboard_v2_envelope, players_envelope,
    resolve_watchlist_data_quality, resolve_watchlist_entries, supported_seasons,
    _v2_player_summary_index,
    resolve_metric_rank_entries,
    build_benchmark_radar_v2, build_ratio_benchmark, build_tactical_summary, build_tactical_summary_v2, build_volume_benchmark,
    build_final_third_shot_map, build_goal_mouth_baseline, build_six_lane_shooting_corridor, build_full_activity_heatmap,
    ShotmapContractViolation,
)


DEFAULT_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "https://forward-scouting-report-6dn7-tau.vercel.app",
    "https://messi.my",
)
VERCEL_PREVIEW_ORIGIN_REGEX = r"^https://forward-scouting-report-6dn7-[a-z0-9-]+-messiflick\.vercel\.app$"
# Canonical dashboard origins allowed to issue protected browser POST requests.
# Keep the Vercel origin during the messi.my transition as a rollback path.
DASHBOARD_ALLOWED_ORIGINS = frozenset({
    "https://forward-scouting-report-6dn7-tau.vercel.app",
    "https://messi.my",
})
WATCHLIST_MAX_BODY_BYTES = 64 * 1024
PROTECTED_WATCHLIST_POST_PATHS = {
    "/api/v2/watchlist/resolve",
    "/api/v2/watchlist/data-quality",
}
METRIC_RANKS_POST_PATH = "/api/v2/metric-ranks"
CONTEXTUAL_COMPARE_POST_PATH = "/api/v2/compare/contextual"
PLAYER_SUMMARY_DEADLINE_SECONDS = 8.0
_PLAYER_SUMMARY_INFLIGHT: dict[tuple[int, str, str, int, str], asyncio.Task[object]] = {}


def configure_messi_logging() -> logging.Logger:
    """Configure application logs without modifying uvicorn's logger tree."""
    logger = logging.getLogger("messi")
    configured_level = os.getenv("API_LOG_LEVEL", "INFO").strip().upper()
    level = getattr(logging, configured_level, logging.INFO)
    if not isinstance(level, int):
        level = logging.INFO
    logger.setLevel(level)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s"
        ))
        logger.addHandler(handler)
    return logger


MESSI_LOG = configure_messi_logging()
PLAYER_SUMMARY_LOG = logging.getLogger("messi.player_summary")
WARM_CACHE_LOG = logging.getLogger("messi.warm_cache")
WARM_CACHE_SCOPE = 8
WARM_CACHE_COMPETITION = "all"

DUEL_PRESS_ERROR_RESPONSES = {
    404: {
        "model": ApiErrorEnvelope,
        "description": "The season, European competition, or player is unavailable in the selected context.",
        "content": {
            "application/json": {
                "examples": {
                    "seasonUnavailable": {
                        "summary": "Unsupported season",
                        "value": {"detail": "No static cohort is available for season 2020/2021"},
                    },
                    "playerUnavailable": {
                        "summary": "Player outside the selected context",
                        "value": {"detail": "Player is not in the selected leaderboard"},
                    },
                },
            },
        },
    },
    422: {
        "description": (
            "FastAPI validation error for an unsupported enum, pageSize other than 50, "
            "or a mode/competition mismatch."
        ),
    },
}

METRIC_RANKS_ERROR_RESPONSES = {
    413: {
        "model": ApiErrorEnvelope,
        "description": "Request body exceeds the 64 KiB companion API limit.",
    },
    422: {
        "description": (
            "Request validation error: malformed or extra fields, an unsupported taxonomy, "
            "duplicate keys, or more than 50 entries."
        ),
    },
}

CONTEXTUAL_COMPARE_ERROR_RESPONSES = {
    400: {
        "model": ApiErrorEnvelope,
        "description": "The companion middleware rejected an invalid Content-Length header.",
    },
    403: {
        "model": ApiErrorEnvelope,
        "description": "The request origin is not the production dashboard or an immutable preview.",
    },
    413: {
        "model": ApiErrorEnvelope,
        "description": "Request body exceeds the 64 KiB companion API limit.",
    },
    422: {
        "description": (
            "Request validation error: malformed or extra fields, non-FotMob identity, "
            "invalid taxonomy/version, duplicate sides, or a mode/dimension mismatch."
        ),
    },
    500: {
        "model": ShotmapServiceErrorEnvelope,
        "description": "A stored player shotmap snapshot violates the strict shotmap contract.",
    },
}


class ScopedCORSMiddleware(CORSMiddleware):
    """Keep legacy Watchlist writes restricted to the fixed production origin.

    Immutable preview origins are intentionally available to the companion API,
    but must not gain access to the older Watchlist POST surface merely because
    an application-wide CORS regex is used for read endpoints.
    """

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] == "http"
            and scope["method"] == "OPTIONS"
            and scope["path"] in PROTECTED_WATCHLIST_POST_PATHS
        ):
            origin = Headers(scope=scope).get("origin")
            if origin and origin not in DASHBOARD_ALLOWED_ORIGINS:
                response = PlainTextResponse("Disallowed CORS origin", status_code=403)
                await response(scope, receive, send)
                return
        await super().__call__(scope, receive, send)


def cors_origins() -> list[str]:
    """Use an exact comma-separated allowlist; deployment origins are configured externally."""
    configured = os.getenv("MESSI_CORS_ORIGINS", "")
    return [item.strip().rstrip("/") for item in configured.split(",") if item.strip()] or list(DEFAULT_ORIGINS)


def cors_origin_regex() -> str:
    """Allow only immutable preview hostnames for this exact Vercel project."""
    return VERCEL_PREVIEW_ORIGIN_REGEX


def is_metric_ranks_origin_allowed(origin: str | None) -> bool:
    """POST batch ranks only from an approved dashboard origin or this project's previews."""
    return bool(origin) and (
        origin in DASHBOARD_ALLOWED_ORIGINS
        or re.fullmatch(VERCEL_PREVIEW_ORIGIN_REGEX, origin) is not None
    )


def validate_duel_press_context(mode: str, competition: str) -> None:
    if mode == "league" and competition != "all":
        raise HTTPException(
            status_code=422,
            detail="competition must be 'all' when mode is 'league'",
        )


app = FastAPI(
    title="M.E.S.S.I. 2.0 Scouting API",
    version="2.4.0",
    description=(
        "M.E.S.S.I. scouting API. Existing v2 responses remain stable; the opt-in "
        "duel-press-v1 companion contract combines ground/aerial duels and adds "
        "forward pressing from recoveries and final-third possession wins. "
        "metric-ranks-v1 provides batch all-cohort ranks for the same taxonomy."
    ),
    docs_url="/docs",
    redoc_url="/redoc",
)
app.add_middleware(
    ScopedCORSMiddleware,
    allow_origins=cors_origins(),
    allow_origin_regex=cors_origin_regex(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    max_age=600,
)


async def _warm_player_summary_cache() -> None:
    """Build season-rail summary indexes sequentially without blocking the event loop."""
    total_started = time.perf_counter()
    try:
        seasons = await run_in_threadpool(supported_seasons)
    except Exception:
        WARM_CACHE_LOG.exception("warm_cache_failed phase=supported_seasons")
        return

    contexts = [
        (season, mode, WARM_CACHE_SCOPE, WARM_CACHE_COMPETITION)
        for season in sorted(seasons, reverse=True)
        for mode in ("league", "europe")
    ]
    WARM_CACHE_LOG.info("warm_cache_started contexts=%s", len(contexts))
    for season, mode, scope, competition in contexts:
        started = time.perf_counter()
        try:
            await run_in_threadpool(
                _v2_player_summary_index, season, mode, scope, competition,
            )
        except asyncio.CancelledError:
            elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
            WARM_CACHE_LOG.info(
                "warm_cache_cancelled season=%s mode=%s scope=%s competition=%s elapsed_ms=%s",
                season, mode, scope, competition, elapsed_ms,
            )
            raise
        except Exception:
            elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
            WARM_CACHE_LOG.exception(
                "warm_cache_context_failed season=%s mode=%s scope=%s competition=%s elapsed_ms=%s",
                season, mode, scope, competition, elapsed_ms,
            )
        else:
            elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
            WARM_CACHE_LOG.info(
                "warm_cache_context_complete season=%s mode=%s scope=%s competition=%s elapsed_ms=%s",
                season, mode, scope, competition, elapsed_ms,
            )
    total_ms = round((time.perf_counter() - total_started) * 1000.0, 2)
    WARM_CACHE_LOG.info("warm_cache_complete contexts=%s total_ms=%s", len(contexts), total_ms)


@app.on_event("startup")
async def schedule_player_summary_cache_warmup() -> None:
    """Schedule optional cache warmup and return immediately so the port can open."""
    enabled = os.getenv("API_WARM_CACHE", "1").strip().lower() not in {"0", "false", "no", "off"}
    if not enabled:
        WARM_CACHE_LOG.info("warm_cache_disabled env=API_WARM_CACHE")
        return
    app.state.player_summary_warm_cache_task = asyncio.create_task(
        _warm_player_summary_cache(), name="messi-player-summary-cache-warmup",
    )
    WARM_CACHE_LOG.info("warm_cache_scheduled background=true")


@app.exception_handler(ShotmapContractViolation)
async def shotmap_contract_error(_: Request, exc: ShotmapContractViolation) -> JSONResponse:
    payload = ShotmapServiceErrorEnvelope(
        detail=ShotmapServiceErrorDetail(message=str(exc)),
    )
    return JSONResponse(status_code=500, content=payload.model_dump(mode="json"))


@app.middleware("http")
async def guard_watchlist_resolution(request: Request, call_next):
    """Bound client-owned batch posts and reject hostile browser origins."""
    path = request.url.path
    if request.method != "POST" or path not in (*PROTECTED_WATCHLIST_POST_PATHS, METRIC_RANKS_POST_PATH, CONTEXTUAL_COMPARE_POST_PATH):
        return await call_next(request)
    origin = request.headers.get("origin")
    origin_allowed = (
        origin in DASHBOARD_ALLOWED_ORIGINS
        if path in PROTECTED_WATCHLIST_POST_PATHS
        else is_metric_ranks_origin_allowed(origin)
    )
    if not origin_allowed:
        return JSONResponse(status_code=403, content={"detail": "Origin is not allowed for this companion API"})
    content_length = request.headers.get("content-length")
    try:
        if content_length is not None and int(content_length) > WATCHLIST_MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request body is too large"})
    except ValueError:
        return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
    if len(await request.body()) > WATCHLIST_MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body is too large"})
    return await call_next(request)


@app.get("/", tags=["system"])
def root() -> dict[str, str]:
    return {
        "service": "M.E.S.S.I. 2.0 Scouting API",
        "status": "ok",
        "health": "/health",
        "docs": "/docs",
    }


@app.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    players = build_players("2025/2026", 8)
    return HealthResponse(season="2025/2026", players=len(players))


@app.get(
    "/api/v2/goal-mouth-baseline",
    response_model=GoalMouthBaselineEnvelope,
    tags=["players"],
    responses={
        404: {"description": "The selected player is not available in the exact static context."},
        422: {"description": "Player context parameters must be supplied together and be internally valid."},
        500: {
            "model": ShotmapServiceErrorEnvelope,
            "description": "A required static goal-mouth baseline snapshot violates the strict contract.",
        },
    },
)
def get_goal_mouth_baseline(
    request: Request,
    response: Response,
    playerId: int | None = Query(default=None, ge=1),
    season: str | None = Query(default=None, pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] | None = Query(default=None),
    scope: Literal["3", "5", "7", "8"] | None = Query(default=None),
    competition: Literal["all", "ucl", "uel", "uecl"] | None = Query(default=None),
    includePenalties: bool | None = Query(default=None),
) -> GoalMouthBaselineEnvelope:
    """Return the global grid, optionally enriched with one exact player context."""
    allowed_query_keys = {
        "playerId", "season", "mode", "scope", "competition", "includePenalties",
    }
    unknown_query_keys = set(request.query_params) - allowed_query_keys
    if unknown_query_keys:
        raise HTTPException(
            status_code=422,
            detail="unknown goal-mouth-baseline query parameter(s): " + ",".join(sorted(unknown_query_keys)),
        )
    core_context = (playerId, season, mode, competition)
    supplied = [value is not None for value in core_context]
    if any(supplied) and not all(supplied):
        raise HTTPException(status_code=422, detail="playerId, season, mode, and competition must be supplied together")
    if not any(supplied) and (scope is not None or includePenalties is not None):
        raise HTTPException(status_code=422, detail="includePenalties requires a complete player context")
    if mode == "league" and scope is None:
        raise HTTPException(status_code=422, detail="league context requires scope")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be omitted for europe context")
    if mode is not None and competition is not None:
        validate_duel_press_context(mode, competition)
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    if playerId is None:
        return build_goal_mouth_baseline()
    envelope = build_goal_mouth_baseline(
        playerId, season, mode, int(scope or "8"), competition,
        include_penalties=True if includePenalties is None else includePenalties,
    )
    if envelope is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return envelope


@app.get("/api/v1/players", response_model=PlayersEnvelope, tags=["players"])
def list_players(
    response: Response,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    limit: int = Query(default=100, ge=1, le=1000),
) -> PlayersEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return players_envelope(season, int(scope), limit)


@app.get("/api/v2/leaderboard-options", response_model=LeaderboardOptions, tags=["leaderboards"])
def list_leaderboard_options() -> LeaderboardOptions:
    """Capabilities are derived from verified static snapshots, never UI defaults."""
    return LeaderboardOptions.model_validate(leaderboard_options())


@app.get(
    "/api/v2/leaderboards/duel-press",
    response_model=DuelPressLeaderboardEnvelope,
    tags=["leaderboards"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def list_duel_press_leaderboards(
    response: Response,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(
        default=50, ge=50, le=50,
        description="duel-press-v1 uses a fixed 50-player server page.",
    ),
    sort: DuelPressLeaderboardSort = Query(default="rank"),
    order: SortOrder = Query(default="asc"),
    role: Literal["Type A", "Type B"] | None = Query(default=None),
    position: str | None = Query(default=None, min_length=1, max_length=100),
    ageBand: AgeBand = Query(default="all"),
    minutesBand: MinutesBand = Query(default="all"),
    q: str | None = Query(default=None, min_length=1, max_length=100),
) -> DuelPressLeaderboardEnvelope:
    """Opt-in six-sector taxonomy with combined duels and forward pressing.

    A valid empty filter result and a page beyond ``totalPages`` both return
    HTTP 200 with ``data: []``.  The metadata remains canonical, with
    ``returned: 0`` and ``hasNextPage: false``. Equal primary sort values are
    always ordered by ``rank ASC`` then ``id ASC``, regardless of sort order.
    """
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    validate_duel_press_context(mode, competition)
    envelope = duel_press_leaderboard_envelope(
        season, mode, int(scope), competition, page=page, page_size=pageSize,
        role=role, position=position, age_band=ageBand,
        minutes_band=minutesBand, query=q, sort=sort, order=order,
    )
    if mode == "europe" and not envelope.meta.population:
        raise HTTPException(status_code=404, detail="This competition is unavailable for the selected season")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return envelope


@app.get(
    "/api/v2/leaderboards/duel-press-v2",
    response_model=DuelPressV2LeaderboardPageEnvelope,
    tags=["leaderboards"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def list_duel_press_v2_leaderboards(
    response: Response,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=50, ge=50, le=50),
    sort: DuelPressLeaderboardSort = Query(default="rank"),
    order: SortOrder = Query(default="asc"),
    role: Literal["Type A", "Type B"] | None = Query(default=None),
    position: str | None = Query(default=None, min_length=1, max_length=100),
    ageBand: AgeBand = Query(default="all"),
    minutesBand: MinutesBand = Query(default="all"),
    q: str | None = Query(default=None, min_length=1, max_length=100),
) -> DuelPressV2LeaderboardPageEnvelope:
    """Versioned stat-pairs-v2 board; the v1 companion remains untouched."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    validate_duel_press_context(mode, competition)
    envelope = duel_press_v2_leaderboard_envelope(
        season, mode, int(scope), competition, page=page, page_size=pageSize,
        role=role, position=position, age_band=ageBand, minutes_band=minutesBand,
        query=q, sort=sort, order=order,
    )
    if mode == "europe" and not envelope.meta.population:
        raise HTTPException(status_code=404, detail="This competition is unavailable for the selected season")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return envelope


@app.get(
    "/api/v2/leaderboards", response_model=LeaderboardEnvelope | LeaderboardPageEnvelope,
    tags=["leaderboards"],
)
def list_leaderboards(
    response: Response,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    limit: int = Query(default=1000, ge=1, le=1000),
    page: int | None = Query(default=None, ge=1),
    pageSize: int | None = Query(default=None, ge=1, le=250),
    sort: LeaderboardSort = Query(default="rank"),
    order: SortOrder = Query(default="asc"),
    role: Literal["Type A", "Type B"] | None = Query(default=None),
    position: str | None = Query(default=None, min_length=1, max_length=100),
    ageBand: AgeBand = Query(default="all"),
    minutesBand: MinutesBand = Query(default="all"),
    q: str | None = Query(default=None, min_length=1, max_length=100),
) -> LeaderboardEnvelope | LeaderboardPageEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    uses_pagination = (
        page is not None or pageSize is not None or role is not None or position is not None
        or ageBand != "all" or minutesBand != "all" or q is not None
        or sort != "rank" or order != "asc"
    )
    if uses_pagination:
        envelope = leaderboard_v21_envelope(
            season, mode, int(scope), competition, page=page or 1, page_size=pageSize or 50,
            role=role, position=position, age_band=ageBand,
            minutes_band=minutesBand, query=q, sort=sort, order=order,
        )
    else:
        envelope = LeaderboardEnvelope.model_validate(leaderboard_v2_envelope(season, mode, int(scope), competition, limit))
    if mode == "europe" and not envelope.meta.population:
        raise HTTPException(status_code=404, detail="This competition is unavailable for the selected season")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return envelope


def _history_summary_task(
    key: tuple[int, str, str, int, str],
) -> tuple[asyncio.Task[object], bool]:
    """Share same-context static work while keeping unrelated contexts independent."""
    existing = _PLAYER_SUMMARY_INFLIGHT.get(key)
    if existing is not None:
        return existing, True
    task: asyncio.Task[object] = asyncio.create_task(
        run_in_threadpool(find_v2_player_summary_timed, *key)
    )
    _PLAYER_SUMMARY_INFLIGHT[key] = task

    def clear_finished(done: asyncio.Task[object]) -> None:
        if _PLAYER_SUMMARY_INFLIGHT.get(key) is done:
            _PLAYER_SUMMARY_INFLIGHT.pop(key, None)

    task.add_done_callback(clear_finished)
    return task, False


@app.get(
    "/api/v2/players/{player_id}", response_model=PlayerEnvelope | PlayerDetailEnvelope,
    tags=["players"],
    responses={
        504: {
            "model": ApiErrorEnvelope,
            "description": "A static player summary exceeded the bounded server lookup deadline.",
        },
        500: {
            "model": ShotmapServiceErrorEnvelope,
            "description": "The stored player shotmap snapshot exists but violates the strict shotmap contract.",
        },
    },
)
async def get_player(
    request: Request,
    response: Response,
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    includeAnalysis: bool = Query(default=False, description="Return server-computed radar, spatial, and raw metric analysis."),
) -> PlayerEnvelope | PlayerDetailEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if not includeAnalysis:
        request_id = request.headers.get("X-Request-Id") or uuid4().hex
        key = (player_id, season, mode, int(scope), competition)
        total_started = time.perf_counter()
        task, shared = _history_summary_task(key)
        try:
            resolved = await asyncio.wait_for(
                asyncio.shield(task), timeout=PLAYER_SUMMARY_DEADLINE_SECONDS,
            )
        except TimeoutError as exc:
            total_ms = round((time.perf_counter() - total_started) * 1000.0, 2)
            PLAYER_SUMMARY_LOG.warning(
                "player_summary_timeout request_id=%s player_id=%s season=%s mode=%s scope=%s competition=%s "
                "phase=cohort_index total_ms=%s deadline_ms=%s shared_inflight=%s",
                request_id, player_id, season, mode, scope, competition, total_ms,
                int(PLAYER_SUMMARY_DEADLINE_SECONDS * 1000), shared,
            )
            raise HTTPException(
                status_code=504,
                detail="Player summary lookup exceeded the 8-second server deadline.",
                headers={
                    "X-Request-Id": request_id,
                    "Retry-After": "2",
                    "Server-Timing": f"player-summary;dur={total_ms:.2f}",
                },
            ) from exc
        player, timing = resolved  # type: ignore[misc]
        total_ms = round((time.perf_counter() - total_started) * 1000.0, 2)
        PLAYER_SUMMARY_LOG.info(
            "player_summary_complete request_id=%s player_id=%s season=%s mode=%s scope=%s competition=%s "
            "phase_cohort_index_ms=%s index_cache=%s shared_inflight=%s schema_envelope_ms=0 total_ms=%s",
            request_id, player_id, season, mode, scope, competition,
            timing["phaseCohortIndexMs"], timing["indexCache"], shared, total_ms,
        )
        if player is None:
            raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
        response.headers["X-Request-Id"] = request_id
        response.headers["Server-Timing"] = f"player-summary;dur={total_ms:.2f}"
        return PlayerEnvelope(data=player)
    # Offload to the threadpool like every sibling handler: build_player_detail is
    # synchronous, so calling it inline froze this worker's event loop for its whole
    # duration and stalled unrelated requests, /health included.
    player = await run_in_threadpool(build_player_detail, player_id, season, mode, int(scope), competition)
    if player is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return PlayerDetailEnvelope(data=player)


@app.get(
    "/api/v2/players/{player_id}/final-third-shot-map",
    response_model=FinalThirdShotEnvelope | FinalThirdEffectiveShotEnvelope | FinalThirdGoalMouthEnvelope,
    tags=["players"],
    responses={
        404: {
            "model": ApiErrorEnvelope,
            "description": "The selected player or season is not available in the exact static context.",
        },
        422: {
            "description": (
                "depthBand must be front2; league mode requires competition=all. "
                "front3 is deliberately unsupported."
            ),
        },
        500: {
            "model": ShotmapServiceErrorEnvelope,
            "description": "The committed final-third shot snapshot violates its strict contract.",
        },
    },
)
def get_final_third_shot_map(
    request: Request,
    response: Response,
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    depthBand: Literal["front2"] = Query(
        default="front2",
        description="Only exact positional-grid depths 5 and 6 are currently supported.",
    ),
    conversionVersion: Literal["goals-v1", "effective-shot-v2", "goal-mouth-v3"] = Query(
        default="goals-v1",
        description=(
            "goals-v1 preserves the released goal conversion contract; "
            "effective-shot-v2 returns on-target-or-goal share plus effectiveShotCount; "
            "goal-mouth-v3 additionally returns the server-owned front-two xGOT-minus-xG caption."
        ),
    ),
) -> FinalThirdShotEnvelope | FinalThirdEffectiveShotEnvelope | FinalThirdGoalMouthEnvelope:
    """Return a cached, source-event-backed final-third companion contract.

    This endpoint never calls FotMob: it reads the committed season shard and
    keeps domestic and European source contexts isolated.
    """
    del depthBand  # Literal validation is the public front2-only product gate.
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(
            status_code=422,
            detail="scope must be omitted for europe context",
        )
    validate_duel_press_context(mode, competition)
    envelope = build_final_third_shot_map(
        player_id, season, mode, int(scope), competition, conversionVersion,
    )
    if envelope is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return envelope


@app.get(
    "/api/v2/players/{playerId}/six-lane-shooting-corridor",
    response_model=SixLaneShootingCorridorEnvelope,
    tags=["players"],
    responses={
        404: {"model": ApiErrorEnvelope, "description": "Player unavailable in the exact selected context."},
        422: {"description": "League/europe context dimensions are invalid."},
        500: {"model": ShotmapServiceErrorEnvelope, "description": "Static source violates the corridor contract."},
    },
)
def get_six_lane_shooting_corridor(
    request: Request,
    response: Response,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> SixLaneShootingCorridorEnvelope:
    """Return full Tier-3 activity with fixed PK handling, never a max-180 fallback."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be omitted for europe context")
    validate_duel_press_context(mode, competition)
    envelope = build_six_lane_shooting_corridor(playerId, season, mode, int(scope), competition)
    if envelope is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return envelope


@app.get(
    "/api/v2/players/{playerId}/full-activity-heatmap",
    response_model=FullActivityHeatmapEnvelope,
    tags=["players"],
    responses={
        404: {"model": ApiErrorEnvelope, "description": "Player unavailable in the exact selected context."},
        422: {"description": "League/europe context dimensions are invalid."},
    },
)
def get_full_activity_heatmap(
    request: Request,
    response: Response,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> FullActivityHeatmapEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be omitted for europe context")
    validate_duel_press_context(mode, competition)
    envelope = build_full_activity_heatmap(playerId, season, mode, int(scope), competition)
    if envelope is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return envelope


@app.get(
    "/api/v2/players/{playerId}/duel-press",
    response_model=DuelPressPlayerEnvelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_duel_press_player(
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> DuelPressPlayerEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    validate_duel_press_context(mode, competition)
    player = find_duel_press_player(playerId, season, mode, int(scope), competition)
    if player is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return player


@app.get(
    "/api/v2/players/{playerId}/duel-press/detail-metrics",
    response_model=DuelPressDetailReadoutEnvelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_duel_press_detail_metrics(
    response: Response,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> DuelPressDetailReadoutEnvelope:
    """Strict, additive six-category raw detail readout from the static cohort."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    validate_duel_press_context(mode, competition)
    detail = find_duel_press_detail_readouts(playerId, season, mode, int(scope), competition)
    if detail is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return detail


@app.get(
    "/api/v2/players/{playerId}/duel-press-v2",
    response_model=DuelPressV2PlayerEnvelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_duel_press_v2_player(
    response: Response,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> DuelPressV2PlayerEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    validate_duel_press_context(mode, competition)
    player = find_duel_press_v2_player(playerId, season, mode, int(scope), competition)
    if player is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return player


@app.get(
    "/api/v2/players/{playerId}/duel-press-v2/detail-metrics",
    response_model=DuelPressDetailReadoutV2Envelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_duel_press_v2_detail_metrics(
    response: Response,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> DuelPressDetailReadoutV2Envelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    validate_duel_press_context(mode, competition)
    detail = find_duel_press_detail_readouts_v2(playerId, season, mode, int(scope), competition)
    if detail is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return detail


@app.get(
    "/api/v2/players/{playerId}/benchmark-radar-v2",
    response_model=BenchmarkRadarV2Envelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_benchmark_radar_v2(
    request: Request,
    response: Response,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> BenchmarkRadarV2Envelope:
    """Return additive v2-axis Volume and Ratio radars from one server frame.

    The selected context may be European, but its values are always compared
    to the same-season domestic eight-league benchmark frame declared in the
    response.  No existing v1 benchmark endpoint is changed.
    """
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be null/omitted when mode is 'europe'")
    validate_duel_press_context(mode, competition)
    data = build_benchmark_radar_v2(playerId, season, mode, int(scope), competition)
    if data is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return BenchmarkRadarV2Envelope(data=data)


@app.post(
    "/api/v2/metric-ranks",
    response_model=MetricRanksEnvelope,
    tags=["leaderboards"],
    responses=METRIC_RANKS_ERROR_RESPONSES,
)
def metric_ranks(request: MetricRanksRequest) -> MetricRanksEnvelope:
    """Batch exact all-cohort ranks without changing leaderboard/detail DTOs.

    Result order always mirrors the request. A syntactically valid but absent
    season/competition is ``invalid_context``; a valid context without that
    player is ``unavailable``. Neither condition aborts sibling entries.
    """
    return MetricRanksEnvelope(results=resolve_metric_rank_entries(request.entries))


@app.get(
    "/api/v2/players/{playerId}/volume-benchmark",
    response_model=VolumeBenchmarkEnvelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_volume_benchmark(
    request: Request,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    benchmarkScope: Literal["8"] = Query(...),
) -> VolumeBenchmarkEnvelope:
    """Return an actual domestic eight-league average polygon for Volume radar."""
    del benchmarkScope  # Required Literal validation fixes the public benchmark cohort.
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be null/omitted when mode is 'europe'")
    validate_duel_press_context(mode, competition)
    benchmark = build_volume_benchmark(playerId, season, mode, int(scope), competition)
    if benchmark is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return VolumeBenchmarkEnvelope(data=benchmark)


@app.get(
    "/api/v2/players/{playerId}/ratio-benchmark",
    response_model=RatioBenchmarkEnvelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_ratio_benchmark(
    request: Request,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    benchmarkScope: Literal["8"] = Query(...),
) -> RatioBenchmarkEnvelope:
    """Return an actual domestic eight-league average polygon for Ratio radar."""
    del benchmarkScope
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be null/omitted when mode is 'europe'")
    validate_duel_press_context(mode, competition)
    benchmark = build_ratio_benchmark(playerId, season, mode, int(scope), competition)
    if benchmark is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return RatioBenchmarkEnvelope(data=benchmark)


@app.get(
    "/api/v2/players/{playerId}/tactical-summary",
    response_model=TacticalSummaryEnvelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_tactical_summary(
    request: Request,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> TacticalSummaryEnvelope:
    """Return server-authored tactical-summary-v1 lines for one exact context."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be null/omitted when mode is 'europe'")
    validate_duel_press_context(mode, competition)
    summary = build_tactical_summary(playerId, season, mode, int(scope), competition)
    if summary is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return TacticalSummaryEnvelope(data=summary)


@app.get(
    "/api/v2/players/{playerId}/tactical-summary-v2",
    response_model=TacticalSummaryV2Envelope,
    tags=["players"],
    responses=DUEL_PRESS_ERROR_RESPONSES,
)
def get_tactical_summary_v2(
    request: Request,
    playerId: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> TacticalSummaryV2Envelope:
    """Return same-context, same-position tactical readouts without v1 changes."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if mode == "europe" and "scope" in request.query_params:
        raise HTTPException(status_code=422, detail="scope must be null/omitted when mode is 'europe'")
    validate_duel_press_context(mode, competition)
    summary = build_tactical_summary_v2(playerId, season, mode, int(scope), competition)
    if summary is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return TacticalSummaryV2Envelope(data=summary)


@app.get(
    "/api/v2/players/{player_id}/duel-spatial",
    response_model=DuelSpatialEnvelope,
    tags=["players"],
)
def get_player_duel_spatial(
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> DuelSpatialEnvelope:
    """Return spatial-duel data only when complete event coordinates exist."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    analysis = build_duel_spatial_analysis(player_id, season, mode, int(scope), competition)
    if analysis is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return DuelSpatialEnvelope(data=analysis)


@app.get(
    "/api/v2/players/{player_id}/tactical-quadrant",
    response_model=TacticalQuadrantEnvelope,
    tags=["players"],
)
def get_player_tactical_quadrant(
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> TacticalQuadrantEnvelope:
    """Expose the detail-page quadrant without expanding strict detail DTOs."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    analysis = build_tactical_quadrant_analysis(
        player_id, season, mode, int(scope), competition,
    )
    if analysis is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return TacticalQuadrantEnvelope(data=analysis)


@app.get(
    "/api/v2/compare", response_model=PlayerComparisonEnvelope, tags=["players"],
    responses={
        500: {
            "model": ShotmapServiceErrorEnvelope,
            "description": "A stored player shotmap snapshot violates the strict shotmap contract.",
        },
    },
)
def compare_player_details(
    players: str = Query(description="Comma-separated list of two to four player IDs."),
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> PlayerComparisonEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    try:
        player_ids = tuple(int(value) for value in players.split(",") if value.strip())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="players must contain numeric player IDs") from exc
    if len(player_ids) < 2 or len(player_ids) > 4 or len(set(player_ids)) != len(player_ids) or any(player_id <= 0 for player_id in player_ids):
        raise HTTPException(status_code=422, detail="players must contain two to four distinct positive IDs")
    comparison = compare_players(player_ids, season, mode, int(scope), competition)
    if comparison is None:
        raise HTTPException(status_code=404, detail="One or more players are not in the selected leaderboard")
    return comparison


@app.post(
    "/api/v2/compare/contextual",
    response_model=ContextualCompareEnvelope,
    tags=["players"],
    responses=CONTEXTUAL_COMPARE_ERROR_RESPONSES,
)
def contextual_compare(request: ContextualCompareRequest) -> ContextualCompareEnvelope:
    """Resolve exactly two independent player contexts without cross-cohort reuse.

    Unsupported but well-formed static contexts and missing players are
    isolated per side as ``invalid_context`` and ``unavailable`` respectively.
    """
    return resolve_contextual_compare_sides(request.left, request.right)


@app.post(
    "/api/v2/watchlist/resolve", response_model=WatchlistResolveEnvelope,
    tags=["watchlist"],
)
def resolve_watchlist(request: WatchlistResolveRequest) -> WatchlistResolveEnvelope:
    """Validate up to 100 client-owned contextual watchlist entries."""
    return WatchlistResolveEnvelope(results=resolve_watchlist_entries(request.entries))


@app.get(
    "/api/v2/players/{player_id}/data-quality",
    response_model=PlayerDataQualityEnvelope,
    tags=["players"],
)
def player_data_quality(
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7", "8"] = Query(default="8"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> PlayerDataQualityEnvelope:
    quality = build_player_data_quality(
        player_id, season, mode, int(scope), competition,
    )
    if quality is None:
        raise HTTPException(
            status_code=404,
            detail="Player is not available in the selected leaderboard context",
        )
    return PlayerDataQualityEnvelope(data=quality)


@app.post(
    "/api/v2/watchlist/data-quality",
    response_model=WatchlistDataQualityEnvelope,
    tags=["watchlist"],
)
def watchlist_data_quality(
    request: WatchlistResolveRequest,
) -> WatchlistDataQualityEnvelope:
    """Return imputation status without changing the strict resolve contract."""
    return WatchlistDataQualityEnvelope(
        results=resolve_watchlist_data_quality(request.entries),
    )
