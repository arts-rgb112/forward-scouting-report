"""Unmounted router factory. The application owns exact-context source loading."""
from collections.abc import Callable, Collection
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Query, Request, Response
from pydantic import ValidationError

from api_server.box_subregion_contract import BoxContext, BoxSubregionEnvelope


def create_box_subregion_router(
    provider: Callable[[BoxContext], BoxSubregionEnvelope | None],
    supported_seasons: Callable[[], Collection[str]],
) -> APIRouter:
    """No default provider, app mount, data discovery, CORS changes, or caching."""
    router = APIRouter()

    @router.get("/api/v2/players/{playerId}/box-subregion-stats", response_model=BoxSubregionEnvelope, tags=["players"])
    def get_box_subregions(
        request: Request,
        response: Response,
        playerId: Annotated[int, Path(gt=0)],
        season: Annotated[str, Query(pattern=r"^20\d{2}/20\d{2}$")] = "2025/2026",
        mode: Literal["league", "europe"] = "league",
        scope: Literal["3", "5", "7", "8"] | None = None,
        competition: Literal["all", "ucl", "uel", "uecl"] = "all",
    ) -> BoxSubregionEnvelope:
        keys = [key for key, _ in request.query_params.multi_items()]
        if set(keys) - {"season", "mode", "scope", "competition"} or len(keys) != len(set(keys)):
            raise HTTPException(status_code=422, detail="Unknown or duplicate query parameters")
        if mode == "europe" and "scope" in keys:
            raise HTTPException(status_code=422, detail="scope must be omitted for europe context")
        if mode == "league" and competition != "all":
            raise HTTPException(status_code=422, detail="league requires competition=all")
        try:
            context = BoxContext(
                playerId=playerId, season=season, mode=mode,
                scope=int(scope or "8") if mode == "league" else None,
                competition=competition if mode == "europe" else None,
            )
        except ValidationError as error:
            raise HTTPException(status_code=422, detail="Invalid box-subregion request context") from error
        if season not in supported_seasons():
            raise HTTPException(status_code=404, detail=f"No static cohort is available for season {season}")
        try:
            result = provider(context.model_copy(deep=True))
            if result is not None:
                # Revalidate even a model: caller mutation must not bypass gates.
                result = BoxSubregionEnvelope.model_validate(result.model_dump())
                if result.context != context:
                    raise ValueError("Provider returned a different request context")
        except Exception as error:
            # This injected provider is an internal data boundary, not an HTTP
            # dependency. Any failure remains a sanitized error, never no-data.
            raise HTTPException(status_code=500, detail="Stored box-subregion source violates its contract") from error
        if result is None:
            raise HTTPException(status_code=404, detail="Player is not in the selected leaderboard")
        # Caching requires independently verified source revision identity first.
        response.headers["Cache-Control"] = "no-store"
        return result

    return router
