from __future__ import annotations

import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .schemas import (
    AgeBand, DuelSpatialEnvelope, HealthResponse, LeaderboardEnvelope, LeaderboardOptions, LeaderboardPageEnvelope,
    LeaderboardSort, MinutesBand, SortOrder,
    PlayerComparisonEnvelope, PlayerDataQualityEnvelope, PlayerDetailEnvelope,
    PlayerEnvelope, PlayersEnvelope, WatchlistDataQualityEnvelope,
    WatchlistResolveEnvelope, WatchlistResolveRequest,
)
from .service import (
    build_duel_spatial_analysis, build_player_data_quality, build_players,
    build_player_detail, compare_players, find_v2_player, leaderboard_options,
    leaderboard_v21_envelope, leaderboard_v2_envelope, players_envelope,
    resolve_watchlist_data_quality, resolve_watchlist_entries, supported_seasons,
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


def cors_origins() -> list[str]:
    """Use an exact comma-separated allowlist; deployment origins are configured externally."""
    configured = os.getenv("MESSI_CORS_ORIGINS", "")
    return [item.strip().rstrip("/") for item in configured.split(",") if item.strip()] or list(DEFAULT_ORIGINS)


def cors_origin_regex() -> str:
    """Allow only immutable preview hostnames for this exact Vercel project."""
    return VERCEL_PREVIEW_ORIGIN_REGEX


app = FastAPI(
    title="M.E.S.S.I. 2.0 Scouting API",
    version="2.0.0",
    description="2025/2026 M.E.S.S.I. six-sector scouting leaderboard API.",
    docs_url="/docs",
    redoc_url="/redoc",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_origin_regex=cors_origin_regex(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    max_age=600,
)


@app.middleware("http")
async def guard_watchlist_resolution(request: Request, call_next):
    """Bound the stateless resolver and give POST access only to production."""
    if request.url.path not in PROTECTED_WATCHLIST_POST_PATHS:
        return await call_next(request)
    if request.headers.get("origin") != WATCHLIST_ALLOWED_ORIGIN:
        return JSONResponse(status_code=403, content={"detail": "Origin is not allowed for watchlist resolution"})
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
    players = build_players("2025/2026", 7)
    return HealthResponse(season="2025/2026", players=len(players))


@app.get("/api/v1/players", response_model=PlayersEnvelope, tags=["players"])
def list_players(
    response: Response,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    scope: Literal["3", "5", "7"] = Query(default="7"),
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
    "/api/v2/leaderboards", response_model=LeaderboardEnvelope | LeaderboardPageEnvelope,
    tags=["leaderboards"],
)
def list_leaderboards(
    response: Response,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7"] = Query(default="7"),
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


@app.get(
    "/api/v2/players/{player_id}", response_model=PlayerEnvelope | PlayerDetailEnvelope,
    tags=["players"],
)
def get_player(
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7"] = Query(default="7"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    includeAnalysis: bool = Query(default=False, description="Return server-computed radar, spatial, and raw metric analysis."),
) -> PlayerEnvelope | PlayerDetailEnvelope:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    if not includeAnalysis:
        player = find_v2_player(player_id, season, mode, int(scope), competition)
        if player is None:
            raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
        return PlayerEnvelope(data=player)
    player = build_player_detail(player_id, season, mode, int(scope), competition)
    if player is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return PlayerDetailEnvelope(data=player)


@app.get(
    "/api/v2/players/{player_id}/duel-spatial",
    response_model=DuelSpatialEnvelope,
    tags=["players"],
)
def get_player_duel_spatial(
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7"] = Query(default="7"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> DuelSpatialEnvelope:
    """Return spatial-duel data only when complete event coordinates exist."""
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    analysis = build_duel_spatial_analysis(player_id, season, mode, int(scope), competition)
    if analysis is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return DuelSpatialEnvelope(data=analysis)


@app.get("/api/v2/compare", response_model=PlayerComparisonEnvelope, tags=["players"])
def compare_player_details(
    players: str = Query(description="Comma-separated list of two to four player IDs."),
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7"] = Query(default="7"),
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
    scope: Literal["3", "5", "7"] = Query(default="7"),
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
