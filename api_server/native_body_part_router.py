"""Additive native body-part router; production never mounts this implicitly."""
from collections.abc import Callable, Collection
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Query, Request, Response
from pydantic import ValidationError

from api_server.box_subregion_contract import BoxContext
from api_server.native_body_part_contract import NativeBodyPartEnvelope


def create_native_body_part_router(
    provider: Callable[[BoxContext, bool], NativeBodyPartEnvelope | None],
    supported_seasons: Callable[[], Collection[str]],
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/v2/players/{playerId}/body-part-shooting-stats", response_model=NativeBodyPartEnvelope, tags=["players"])
    def body_part_stats(
        request: Request,
        response: Response,
        playerId: Annotated[int, Path(gt=0)],
        season: Annotated[str, Query(pattern=r"^20\d{2}/20\d{2}$")] = "2025/2026",
        mode: Literal["league", "europe"] = "league",
        scope: Literal["3", "5", "7", "8"] | None = None,
        competition: Literal["all", "ucl", "uel", "uecl"] = "all",
        includePenalties: bool = True,
    ) -> NativeBodyPartEnvelope:
        keys = [key for key, _ in request.query_params.multi_items()]
        if set(keys) - {"season", "mode", "scope", "competition", "includePenalties"} or len(keys) != len(set(keys)):
            raise HTTPException(status_code=422, detail="Unknown or duplicate query parameters")
        if mode == "europe" and "scope" in keys:
            raise HTTPException(status_code=422, detail="scope must be omitted for europe context")
        if mode == "league" and competition != "all":
            raise HTTPException(status_code=422, detail="league requires competition=all")
        try:
            context = BoxContext(playerId=playerId, season=season, mode=mode,
                                 scope=int(scope or "8") if mode == "league" else None,
                                 competition=competition if mode == "europe" else None)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail="Invalid body-part request context") from error
        if season not in supported_seasons():
            raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
        try:
            result = provider(context.model_copy(deep=True), includePenalties)
            if result is not None:
                result = NativeBodyPartEnvelope.model_validate(result.model_dump())
                if result.context != context or result.includePenalties != includePenalties:
                    raise ValueError("Body-part provider returned a different request context/filter")
        except Exception as error:
            raise HTTPException(status_code=500, detail="Stored body-part source violates its contract") from error
        if result is None:
            raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
        response.headers["Cache-Control"] = "no-store"
        return result

    return router
