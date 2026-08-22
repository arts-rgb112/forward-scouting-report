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
    ContextualCompareEnvelope, ContextualCompareRequest,
    MetricRanksEnvelope, MetricRanksRequest,
    RatioBenchmarkEnvelope, TacticalSummaryEnvelope, VolumeBenchmarkEnvelope,
    LeaderboardSort, MinutesBand, SortOrder,
    PlayerComparisonEnvelope, PlayerDataQualityEnvelope, PlayerDetailEnvelope,
    PlayerEnvelope, PlayersEnvelope, WatchlistDataQualityEnvelope,
    ShotmapServiceErrorDetail, ShotmapServiceErrorEnvelope,
    FinalThirdShotEnvelope,
    WatchlistResolveEnvelope, WatchlistResolveRequest, TacticalQuadrantEnvelope,
)
from .service import (
    build_duel_spatial_analysis, build_player_data_quality, build_players,
    duel_press_leaderboard_envelope, find_duel_press_player,
    find_duel_press_detail_readouts,
    build_player_detail, build_tactical_quadrant_analysis, compare_players, find_v2_player_summary_timed, leaderboard_options,
    resolve_contextual_compare_sides,
    leaderboard_v21_envelope, leaderboard_v2_envelope, players_envelope,
    resolve_watchlist_data_quality, resolve_watchlist_entries, supported_seasons,
    resolve_metric_rank_entries,
    build_ratio_benchmark, build_tactical_summary, build_volume_benchmark,
    build_final_third_shot_map,
    ShotmapContractViolation,
)


DEFAULT_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "https://forward-scouting-report-6dn7-tau.vercel.app",
)
VERCEL_PREVIEW_ORIGIN_REGEX = r"^https://forward-scouting-report-6dn7-[a-z0-9-]+-messiflick\.vercel\.app$"
WATCHLIST_ALLOWED_ORIGIN = "https://forward-scouting-report-6dn7-tau.vercel.app"
WATCHLIST_MAX_BODY_BYTES = 64 * 1024
PROTECTED_WATCHLIST_POST_PATHS = {
    "/api/v2/watchlist/resolve",
    "/api/v2/watchlist/data-quality",
}
METRIC_RANKS_POST_PATH = "/api/v2/metric-ranks"
CONTEXTUAL_COMPARE_POST_PATH = "/api/v2/compare/contextual"
PLAYER_SUMMARY_DEADLINE_SECONDS = 8.0
_PLAYER_SUMMARY_INFLIGHT: dict[tuple[int, str, str, int, str], asyncio.Task[object]] = {}
PLAYER_SUMMARY_LOG = logging.getLogger("messi.player_summary")

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
            if origin and origin != WATCHLIST_ALLOWED_ORIGIN:
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
    """POST batch ranks only from the production dashboard or this project's previews."""
    return bool(origin) and (
        origin == WATCHLIST_ALLOWED_ORIGIN
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
        origin == WATCHLIST_ALLOWED_ORIGIN
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
    player = build_player_detail(player_id, season, mode, int(scope), competition)
    if player is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return PlayerDetailEnvelope(data=player)


@app.get(
    "/api/v2/players/{player_id}/final-third-shot-map",
    response_model=FinalThirdShotEnvelope,
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
) -> FinalThirdShotEnvelope:
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
    envelope = build_final_third_shot_map(player_id, season, mode, int(scope), competition)
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
