from __future__ import annotations

import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from .schemas import HealthResponse, PlayersEnvelope
from .service import (
    build_players, find_v2_player, leaderboard_options, leaderboard_v2_envelope,
    players_envelope, supported_seasons,
)


DEFAULT_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
)


def cors_origins() -> list[str]:
    """Use an exact comma-separated allowlist; deployment origins are configured externally."""
    configured = os.getenv("MESSI_CORS_ORIGINS", "")
    return [item.strip().rstrip("/") for item in configured.split(",") if item.strip()] or list(DEFAULT_ORIGINS)


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
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Accept", "Content-Type"],
    max_age=600,
)


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


@app.get("/api/v2/leaderboard-options", tags=["leaderboards"])
def list_leaderboard_options() -> dict[str, object]:
    """Capabilities are derived from verified static snapshots, never UI defaults."""
    return leaderboard_options()


@app.get("/api/v2/leaderboards", tags=["leaderboards"])
def list_leaderboards(
    response: Response,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7"] = Query(default="7"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
    limit: int = Query(default=1000, ge=1, le=1000),
) -> dict[str, object]:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    envelope = leaderboard_v2_envelope(season, mode, int(scope), competition, limit)
    if mode == "europe" and not envelope["meta"]["population"]:
        raise HTTPException(status_code=404, detail="This competition is unavailable for the selected season")
    response.headers["Cache-Control"] = "public, max-age=300, stale-while-revalidate=3600"
    return envelope


@app.get("/api/v2/players/{player_id}", tags=["players"])
def get_player(
    player_id: int,
    season: str = Query(default="2025/2026", pattern=r"^20\d{2}/20\d{2}$"),
    mode: Literal["league", "europe"] = Query(default="league"),
    scope: Literal["3", "5", "7"] = Query(default="7"),
    competition: Literal["all", "ucl", "uel", "uecl"] = Query(default="all"),
) -> dict[str, object]:
    if season not in supported_seasons():
        raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
    player = find_v2_player(player_id, season, mode, int(scope), competition)
    if player is None:
        raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
    return {"data": player.model_dump(mode="json")}
